// Team Lead review (T-4, D-136..D-138; UX TL v4 §7, §8, TL-08, TL-09, FR03-09, D-021, D-075). Queue, review page data,
// approve / conditional approve / request revision, history, Tester QA sign-off, module handoff chain.
// XP: only the task.approved event → gamificationService.applyTaskApproved (ledger guard). Done only here (and gated legacy paths).
import mongoose from "mongoose";
import Task from "../models/Task.js";
import User from "../models/User.js";
import Project from "../models/Project.js";
import Milestone from "../models/Milestone.js";
import AuditLog from "../models/AuditLog.js";
import XpLog from "../models/XpLog.js";
import GamificationProfile from "../models/GamificationProfile.js";
import Organization from "../models/Organization.js";
import emitter from "../utils/emitter.js";
import { tlScope, projectIn } from "./teamLeadWorkController.js";
import { aiEvalView, finalScore } from "../services/aiEvalService.js";
import { calculateTaskXP, lateAtSubmission } from "../services/xpEngine.js";
import { approvalBlock, validateApproval, validateRevision, revisionUpdate, revisionPlan, revisionEntry, rubberStampWarning, aiStatus, qaState, queueView, isSelfReview, PAGE } from "../services/reviewRules.js";
import { handoffChain } from "../services/handoffRules.js";
import { openLimitRequest, limitRequestOf } from "../services/limitRequest.js";
import { limitState } from "../services/reviewRules.js";
import { awardTLReviewXp } from "../services/tlGamificationService.js";
import { TL_REVIEW_XP } from "../services/xpEngine.js";

const valid = (id) => mongoose.isValidObjectId(id);
const OID = (x) => new mongoose.Types.ObjectId(String(x));
const people = (t) => [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].filter((x, i, a) => x && a.findIndex((y) => String(y._id ?? y) === String(x._id ?? x)) === i);
const assigneeIds = (t) => people(t).map((x) => String(x._id ?? x));
const pid = (s) => [...s.ids].map(OID);
const audit = (s, req, t, action, detail, after) => AuditLog.create({ action, orgId: s.scope.org._id, performedBy: req.user.id, targetProjectId: t.projectId, detail, after }).catch((e) => console.error("[review audit]", e.message));

// ── GET /api/teamlead/review/queue?view&role&module&assignee&page ───────────
export async function getQueue(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const tasks = await Task.find({ ...s.scope.filter, projectId: { $in: pid(s) }, status: "In-Review" }, "title priority deadline submittedAt updatedAt assignee assignees projectId milestoneId aiEval qaRequired qaSignoffs qaConditional status resubmissionCount")
    .populate("assignee", "name role").populate("assignees", "name role").populate("milestoneId", "title").lean();
  const items = tasks.map((t) => {
    const who = people(t);
    return { id: t._id, title: t.title, priority: t.priority, deadline: t.deadline, submittedAt: t.submittedAt ?? t.updatedAt, projectTitle: projectIn(s, t.projectId)?.title ?? "",
      moduleId: t.milestoneId?._id ?? null, moduleTitle: t.milestoneId?.title ?? null, assignees: who.map((x) => x.name), assigneeIds: who.map((x) => String(x._id)), assigneeRoles: who.map((x) => x.role),
      ai: aiStatus(t.aiEval), qa: qaState(t).state, revisions: t.resubmissionCount ?? 0, mine: isSelfReview(t, req.user.id) };
  });
  const v = queueView(items, req.query, new Date());
  const modules = [...new Map(items.filter((x) => x.moduleId).map((x) => [String(x.moduleId), { id: x.moduleId, title: x.moduleTitle }])).values()];
  const assignees = [...new Map(items.flatMap((x) => x.assigneeIds.map((id, i) => [id, { id, name: x.assignees[i] }]))).values()];
  res.json({ ...v, modules, assignees });
}

// ── GET /api/teamlead/review/history?page (approvals and revisions in the TL's projects) ──
export async function getHistory(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  // ponytail: reads the 300 latest reviewed tasks and pages in memory; move to an aggregate if history grows past that.
  const tasks = await Task.find({ ...s.scope.filter, projectId: { $in: pid(s) }, $or: [{ status: "Done", reviewedBy: { $ne: null } }, { "revisionHistory.0": { $exists: true } }] }, "+aiScore title status reviewedAt reviewedBy tlScore qualityScore reviewNote revisionHistory qaConditional assignee assignees projectId")
    .populate("assignee", "name").populate("assignees", "name").populate("reviewedBy", "name").populate("revisionHistory.requestedBy", "name").sort({ updatedAt: -1 }).limit(300).lean();
  const rows = [];
  for (const t of tasks) {
    const base = { taskId: t._id, title: t.title, projectTitle: projectIn(s, t.projectId)?.title ?? "", assignees: people(t).map((x) => x.name) };
    if (t.status === "Done" && t.reviewedAt) rows.push({ ...base, id: `${t._id}-a`, kind: t.qaConditional?.at ? "conditional" : "approved", at: t.reviewedAt, by: t.reviewedBy?.name ?? null, tlScore: t.tlScore ?? null, stars: t.qualityScore ?? null, aiScore: t.aiScore ?? null, note: t.reviewNote ?? "" });
    for (const r of t.revisionHistory ?? []) if (r.type === "revision_requested") rows.push({ ...base, id: String(r._id), kind: "revision", at: r.requestedAt, by: r.requestedBy?.name ?? null, tlScore: null, stars: null, aiScore: null, note: r.comment ?? "", unmet: r.unmetCriteria ?? [] });
  }
  rows.sort((a, b) => +new Date(b.at) - +new Date(a.at));
  const page = Math.max(1, Number(req.query.page) || 1);
  res.json({ total: rows.length, page, pageSize: PAGE, items: rows.slice((page - 1) * PAGE, page * PAGE) });
}

// XP per star for the first assignee, from the engine (nothing is awarded here).
async function xpPreview(t, orgId) {
  const uid = assigneeIds(t)[0];
  if (!uid) return null;
  const [profile, org] = await Promise.all([GamificationProfile.findOne({ userId: uid }, "streaks").lean(), Organization.findOne(/^[0-9a-f]{24}$/i.test(String(orgId)) ? { _id: orgId } : { orgId }, "gamificationRules").lean()]);
  const submittedAt = new Date(t.submittedAt ?? t.updatedAt);
  const { isLate } = lateAtSubmission(t, submittedAt);
  return Object.fromEntries([1, 2, 3, 4, 5].map((q) => [q, calculateTaskXP({ task: t, submittedAt, isLate, qualityStars: q, streakDays: profile?.streaks?.daily ?? 0, orgRules: org?.gamificationRules ?? null }).finalXP]));
}

// ── GET /api/teamlead/review/:id (route guard: ownTask). AI score stays out until the review is finished (D-075). ──
export async function getReview(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const t = await Task.findById(req.params.id, "+aiScore +aiScores").populate("assignee", "name role").populate("assignees", "name role").populate("milestoneId", "title").populate("reviewedBy", "name")
    .populate("revisionHistory.requestedBy", "name").populate("qaSignoffs.by", "name").populate("qaConditional.by", "name").lean();
  const reviewed = t.status !== "In-Review" && t.tlScore != null;
  const qa = qaState(t);
  const inReview = t.status === "In-Review";
  const [xp, preview, next, limit] = await Promise.all([
    reviewed ? XpLog.find({ taskId: t._id, source: { $in: ["task_approved", "tl_review_efficiency"] } }, "userId amount source").populate("userId", "name").lean() : [],
    inReview ? xpPreview(t, req.user.orgId) : null,
    Task.find({ ...s.scope.filter, projectId: { $in: pid(s) }, status: "In-Review", _id: { $ne: t._id } }, "assignee assignees submittedAt").sort({ submittedAt: 1 }).limit(20).lean(),
    t.status === "In-Progress" ? limitRequestOf(t._id) : null,
  ]);
  res.json({
    id: t._id, title: t.title, description: t.description ?? "", type: t.type, priority: t.priority, difficulty: t.difficulty, status: t.status, deadline: t.deadline, estimatedHours: t.estimatedHours,
    projectId: t.projectId, projectTitle: projectIn(s, t.projectId)?.title ?? "", moduleTitle: t.milestoneId?.title ?? null, assignees: people(t).map((x) => ({ id: x._id, name: x.name, role: x.role })),
    acceptanceCriteria: t.acceptanceCriteria ?? [], benchmark: t.benchmark ?? "", isLate: !!t.isLate, submittedAt: t.submittedAt ?? t.updatedAt,
    submission: { note: t.submissionNote ?? "", links: t.submissionLinks ?? [], files: t.submissionFiles ?? [], content: t.submissionContent ?? "", checklist: t.submissionChecklist ?? [] },
    revisions: (t.revisionHistory ?? []).filter((r) => r.type === "revision_requested").map((r) => ({ id: r._id, at: r.requestedAt, by: r.requestedBy?.name ?? null, comment: r.comment, unmet: r.unmetCriteria ?? [] })),
    resubmissionCount: t.resubmissionCount ?? 0, maxResubmissions: t.maxResubmissions ?? 3, limitState: (t.resubmissionCount ?? 0) >= (t.maxResubmissions ?? 3) ? limitState(limit) : null,
    aiEval: aiEvalView(t, reviewed), aiStatus: aiStatus(t.aiEval),
    qa: { required: !!t.qaRequired, state: qa.state, latest: qa.latest ? { by: qa.latest.by?.name ?? null, at: qa.latest.at, result: qa.latest.result, note: qa.latest.note } : null,
      conditional: t.qaConditional?.at ? { by: t.qaConditional.by?.name ?? null, at: t.qaConditional.at, reason: t.qaConditional.reason } : null },
    canReview: inReview && !isSelfReview(t, req.user.id), mine: isSelfReview(t, req.user.id), xpPreview: preview,
    result: reviewed ? { tlScore: t.tlScore, stars: t.qualityScore, aiScore: t.aiScore ?? null, gap: finalScore({ tlScore: t.tlScore, aiScore: t.aiScore }).gap, flagged: (t.reviewFlags ?? []).some((f) => f.kind === "ai_tl_disagreement"), by: t.reviewedBy?.name ?? null, at: t.reviewedAt, note: t.reviewNote ?? "", xp: xp.filter((x) => x.source === "task_approved").map((x) => ({ name: x.userId?.name ?? "—", amount: x.amount })), tlXp: xp.find((x) => x.source === "tl_review_efficiency" && String(x.userId?._id) === String(req.user.id))?.amount ?? 0 } : null,
    tlReviewXp: TL_REVIEW_XP,
    nextId: next.find((n) => !isSelfReview(n, req.user.id))?._id ?? null,
  });
}

// ── POST /api/teamlead/review/:id/approve { score, feedback } · …/conditional { score, feedback, reason } ──
async function finish(req, res, conditional) {
  const s = await tlScope(req, res); if (!s) return;
  const v = validateApproval({ ...req.body, conditional });
  if (v.error) return res.status(400).json({ error: v.error });
  const t = await Task.findById(req.params.id, "+aiScore").lean();
  const blocked = approvalBlock({ task: t, reviewerId: req.user.id, conditional });
  if (blocked) return res.status(blocked.status).json({ error: blocked.error, code: blocked.code });

  const now = new Date();
  const fs = finalScore({ tlScore: v.value.score, aiScore: t.aiScore, by: req.user.id });
  // Atomic: only one approval moves the task out of In-Review, so a double click cannot award twice.
  const done = await Task.findOneAndUpdate({ _id: t._id, status: "In-Review" }, {
    $set: { status: "Done", reviewNote: v.value.feedback || null, reviewedBy: req.user.id, reviewedAt: now, qualityScore: v.value.stars, tlScore: v.value.score, reviewStage: "none", completedAt: now,
      ...(conditional ? { qaConditional: { by: req.user.id, at: now, reason: v.value.reason } } : {}) },
    ...(fs.flag ? { $push: { reviewFlags: fs.flag } } : {}),
  });
  if (!done) return res.status(409).json({ error: "This task is not waiting for review.", code: "not_in_review" });
  const ids = assigneeIds(t);
  Task.logActivity(t._id, req.user.id, "status", { from: "In-Review", to: "Done", note: conditional ? `Conditional, ${v.value.stars}★: ${v.value.reason}` : `${v.value.stars}★` });
  await GamificationProfile.updateOne({ userId: req.user.id }, { $inc: { "stats.reviewsGiven": 1 } });
  emitter.emit("task.approved", { taskId: t._id, assignees: ids.map(OID), qualityScore: v.value.stars, approverId: req.user.id, orgId: t.orgId, taskTitle: t.title });
  audit(s, req, t, conditional ? "task_conditional_approved" : "task_review_approved", `"${t.title}" ${conditional ? `approved without QA sign-off: ${v.value.reason}` : "approved"} (score ${v.value.score}, ${v.value.stars}★).`,
    { taskId: String(t._id), score: v.value.score, stars: v.value.stars, gap: fs.gap, flagged: !!fs.flag, ...(conditional ? { reason: v.value.reason } : {}) });
  // T-6 (D-148): the reviewer's own XP, through the single award path. Never blocks the approval.
  const tlAward = await awardTLReviewXp({ tlId: req.user.id, orgId: t.orgId, taskId: t._id, stars: v.value.stars, submittedAt: t.submittedAt, approvedAt: now, conditional }).catch((e) => { console.error("[tl xp]", e.message); return { xp: 0, reason: "error" }; });
  res.json({ ok: true, status: "Done", tlScore: v.value.score, stars: v.value.stars, aiScore: t.aiScore ?? null, gap: fs.gap, flagged: !!fs.flag, conditional, tlXp: tlAward.xp, tlXpReason: tlAward.reason,
    rubberStamp: rubberStampWarning({ score: v.value.score, submittedAt: t.submittedAt, now }) });
}
export const approveReview = (req, res) => finish(req, res, false);
export const conditionalApprove = (req, res) => finish(req, res, true);

// ── POST /api/teamlead/review/:id/revision { reason, unmet: [criterion] } → back to In-Progress ──
export async function requestRevision(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const t = await Task.findById(req.params.id).lean();
  if (t.status !== "In-Review") return res.status(409).json({ error: "This task is not waiting for review.", code: "not_in_review" });
  if (isSelfReview(t, req.user.id)) return res.status(403).json({ error: "You worked on this task, so someone else must review it.", code: "self_review" });
  const v = validateRevision(req.body, t.acceptanceCriteria ?? []);
  if (v.error) return res.status(400).json({ error: v.error });
  const u = await sendBack(t, { id: req.user.id, name: req.user.name }, v.value,
    (u2) => audit(s, req, t, "task_review_revision", `Revision requested on "${t.title}": ${v.value.reason}`, { taskId: String(t._id), unmet: v.value.unmet, attempt: u2.resubmissionCount }));
  if (!u) return res.status(409).json({ error: "This task is not waiting for review.", code: "not_in_review" });
  res.json({ ok: true, status: u.status, attempt: u.resubmissionCount, reachedMax: u.reachedMax });
}

// The one way back to In-Progress after a review (T-4, D-059, D-142). source "review" (the Team Lead, D-027): attempt +1,
// the rejection rule (XP and HP) and the limit request at the limit, exactly as before. source "qa" (a failed QA sign-off,
// E-4b D-194, supersedes D-189): back to the assignee with a "QA failed" entry only; no try used, no penalty, no limit request.
// Returns the update, or null when the task was no longer In-Review.
export async function sendBack(t, actor, { reason: why, unmet = [] }, onAudit, source = "review") {
  const plan = revisionPlan(source);
  const u = plan.countsAttempt ? revisionUpdate(t) : { status: "In-Progress", resubmissionCount: t.resubmissionCount ?? 0, reachedMax: false };
  const now = new Date();
  const moved = await Task.findOneAndUpdate({ _id: t._id, status: "In-Review" }, {
    $set: plan.countsAttempt ? { status: u.status, resubmissionCount: u.resubmissionCount, reviewNote: why, reviewedBy: actor.id, reviewedAt: now, reviewStage: "none" } : { status: u.status },
    $push: { revisionHistory: revisionEntry({ by: actor.id, reason: why, unmet, at: now, source }) },
  });
  if (!moved) return null;
  Task.logActivity(t._id, actor.id, "status", { from: "In-Review", to: "In-Progress", note: why });
  const reason = unmet.length ? `${why} Not met: ${unmet.join("; ")}` : why;
  if (plan.penalty) emitter.emit("task.rejected", { taskId: t._id, reviewerId: actor.id, reason, orgId: t.orgId }); // same event as before: notifies and applies the rejection rule
  onAudit?.(u);
  if (plan.limitRequest && u.reachedMax) await openLimitRequest(t, actor, u.resubmissionCount).catch((e) => console.error("[limit request]", e.message)); // D-142
  return u;
}

// ── GET /api/teamlead/modules/:projectId/handoff?module= (Handoff tab + QA checklist) ──
export async function getHandoff(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const p = valid(req.params.projectId) ? projectIn(s, req.params.projectId) : null;
  if (!p) return res.status(404).json({ error: "Module not found in your projects." });
  let mod = null;
  if (req.query.module) {
    mod = valid(req.query.module) ? await Milestone.findOne({ _id: req.query.module, projectId: p._id, teamLeadId: req.user.id }, "_id").lean() : null;
    if (!mod) return res.status(404).json({ error: "Module not found in your projects." });
  }
  const tasks = await Task.find({ ...s.scope.filter, projectId: p._id, ...(mod && (await Task.exists({ milestoneId: mod._id })) ? { milestoneId: mod._id } : {}) }, "title type status dependsOn qaRequired qaSignoffs qaConditional submittedAt assignee assignees").populate("assignee", "name").populate("assignees", "name").sort({ createdAt: 1 }).limit(200).lean();
  res.json(handoffChain(tasks.map((t) => ({ id: String(t._id), title: t.title, type: t.type, status: t.status, dependsOn: (t.dependsOn ?? []).map(String), qaRequired: !!t.qaRequired, qa: qaState(t).state, assignees: people(t).map((x) => x.name) }))));
}
