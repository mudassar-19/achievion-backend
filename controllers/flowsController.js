// QA4 Round 4: Change Team Lead (Y-6), Request reallocation / Nudge (Y-7, Manager), Reassign (Y-7, Team Lead only), Remove member (Y-8).
// Shapes are in ~/Achievion-runbook/API_CONTRACT_QA4.md. Rules (pure) are in services/flowRules.js. Names are read from ids, never stored in text.
import mongoose from "mongoose";
import Task from "../models/Task.js";
import User from "../models/User.js";
import Project from "../models/Project.js";
import Milestone from "../models/Milestone.js";
import Risk from "../models/Risk.js";
import Notification from "../models/Notification.js";
import AuditLog from "../models/AuditLog.js";
import ReallocationRequest from "../models/ReallocationRequest.js";
import ChatCommunity from "../models/ChatCommunity.js";
import ChatChannel from "../models/ChatChannel.js";
import { getIo } from "../utils/io.js";
import { getBulkWorkloadSnapshots } from "../services/workloadService.js";
import { orgWorkTime, workingDaysLeft } from "../services/workloadRules.js";
import { orgScope } from "./managerProjectsController.js";
import { cooldownLeft, remainingHours, needsExtension, reassignError, removeBlockers, changeLeadError } from "../services/flowRules.js";
import { effectiveThreshold } from "../services/resourceRules.js";
import { getAlertSettings } from "../services/alertRules.js";

const valid = (id) => mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(String(id));
const nameOf = async (id) => (id ? (await User.findById(id, "name").lean())?.name ?? "Former member" : null);
const oid = (id) => new mongoose.Types.ObjectId(String(id));

// A bell item (needs_action for things somebody must answer) that also reaches an open page through the socket.
async function notify(userId, orgId, type, title, message, { tier = "fyi", meta = {}, deepLink = null } = {}) {
  const n = await Notification.create({ userId, orgId: String(orgId), type, title, message, tier, meta, deepLink });
  getIo()?.to(`user:${userId}`).emit("notification:new", n.toObject());
  return n;
}
const audit = (req, action, detail, extra = {}) => AuditLog.create({ action, orgId: oid(req.user.orgId), performedBy: oid(req.user.id), detail, scope: "project", ...extra }).catch((e) => console.error("[audit]", e.message));

async function loadModule(req, res) {
  if (!valid(req.params.id) || !valid(req.params.moduleId)) { res.status(404).json({ error: "Module not found." }); return null; }
  const [project, module] = await Promise.all([Project.findById(req.params.id, "title status members orgId").lean(), Milestone.findOne({ _id: req.params.moduleId, projectId: req.params.id })]);
  if (!project || !module) { res.status(404).json({ error: "Module not found." }); return null; }
  return { project, module };
}

// ── Y-6: the system-built handover summary (no AI) ───────────────────────────────
export async function buildHandoverSummary(project, module) {
  const tasks = await Task.find({ milestoneId: module._id }, "title status deadline reviewedAt tlScore qualityScore reviewFlags updatedAt").lean();
  const now = new Date(), by = { "To-Do": 0, "In-Progress": 0, "In-Review": 0, Done: 0, Backlog: 0 };
  for (const t of tasks) by[t.status] = (by[t.status] ?? 0) + 1;
  const open = tasks.filter((t) => t.status !== "Done");
  const done = by.Done ?? 0, total = tasks.length;
  const risks = await Risk.countDocuments({ projectId: project._id, status: { $in: ["open", "escalated"] } });
  return {
    moduleTitle: module.title, projectTitle: project.title,
    progress: { done, total, pct: total ? Math.round((done / total) * 100) : 0 },
    byStatus: by,
    inReview: tasks.filter((t) => t.status === "In-Review").slice(0, 5).map((t) => ({ id: t._id, title: t.title })),
    overdue: open.filter((t) => t.deadline && new Date(t.deadline) < now).length,
    dueDate: module.dueDate ?? module.endDate ?? null,
    nextDeadlines: open.filter((t) => t.deadline).sort((a, b) => +new Date(a.deadline) - +new Date(b.deadline)).slice(0, 3).map((t) => ({ title: t.title, deadline: t.deadline })),
    openRisks: risks,
    openFlags: tasks.reduce((n, t) => n + (t.reviewFlags ?? []).filter((f) => f.status === "open").length, 0),
    lastDecisions: tasks.filter((t) => t.reviewedAt).sort((a, b) => +new Date(b.reviewedAt) - +new Date(a.reviewedAt)).slice(0, 3).map((t) => ({ title: t.title, result: t.status === "Done" ? "approved" : "sent back", at: t.reviewedAt })),
  };
}
const summaryLine = (s) => `${s.progress.done} of ${s.progress.total} tasks done, ${s.inReview.length} in review, ${s.overdue} overdue, ${s.openRisks} open risk${s.openRisks === 1 ? "" : "s"}, ${s.openFlags} open flag${s.openFlags === 1 ? "" : "s"}.`;

async function candidateInfo(req, scope, project, userId) {
  const u = userId && valid(userId) ? await User.findOne({ _id: userId, orgId: req.user.orgId, status: { $ne: "deleted" } }, "name role status").lean() : null;
  if (!u) return null;
  const [snap] = await getBulkWorkloadSnapshots([u._id], { workTime: orgWorkTime(scope.org) });
  const limit = effectiveThreshold(getAlertSettings(scope.org).overloadLimitPct, null);
  const activeModules = await Milestone.countDocuments({ teamLeadId: u._id, status: { $ne: "Completed" } });
  return { user: u, id: u._id, name: u.name, inProject: (project.members ?? []).map(String).includes(String(u._id)), activeModules, utilisationPct: snap?.utilisation ?? 0, overloaded: (snap?.utilisation ?? 0) > limit, freeHoursPerDay: snap?.availableHours ?? null };
}

// GET /api/manager/projects/:id/modules/:moduleId/change-lead/preview?newTeamLeadId=
export async function changeLeadPreview(req, res) {
  const m = await loadModule(req, res); if (!m) return;
  const scope = await orgScope(req.user.orgId, req.user);
  const cand = await candidateInfo(req, scope, m.project, req.query.newTeamLeadId);
  const summary = await buildHandoverSummary(m.project, m.module);
  const warnings = [];
  if (cand?.overloaded) warnings.push(`${cand.name} is already over capacity (${cand.utilisationPct}%).`);
  if (cand && !cand.inProject) warnings.push(`${cand.name} is not on this project yet and will be added.`);
  if (cand && cand.activeModules >= 3) warnings.push(`${cand.name} already leads ${cand.activeModules} modules.`);
  const pendingExtensions = await (await import("../models/ExtensionRequest.js")).default.countDocuments({ projectId: m.project._id, status: "pending" });
  res.json({ current: m.module.teamLeadId ? { id: m.module.teamLeadId, name: await nameOf(m.module.teamLeadId) } : null,
    candidate: cand ? { id: cand.id, name: cand.name, inProject: cand.inProject, activeModules: cand.activeModules, overloaded: cand.overloaded, utilisationPct: cand.utilisationPct } : null,
    warnings, effects: { inReview: summary.inReview.length, openTasks: summary.progress.total - summary.progress.done, pendingExtensions, openFlags: summary.openFlags }, summary });
}

// POST /api/manager/projects/:id/modules/:moduleId/change-lead { newTeamLeadId, reason }
export async function changeLead(req, res) {
  const m = await loadModule(req, res); if (!m) return;
  const reason = String(req.body?.reason ?? "").trim().slice(0, 500);
  const scope = await orgScope(req.user.orgId, req.user);
  const cand = await candidateInfo(req, scope, m.project, req.body?.newTeamLeadId);
  const err = changeLeadError({ current: m.module.teamLeadId, newLead: cand && { id: cand.id, role: cand.user.role, status: cand.user.status }, reason, project: m.project, module: m.module });
  if (err) return res.status(/closed|Completed|Archived/.test(err) ? 409 : 400).json({ error: err, ...(/closed|Completed|Archived/.test(err) ? { code: "CLOSED" } : {}) });

  const oldId = m.module.teamLeadId, newId = cand.id, now = new Date();
  const summary = await buildHandoverSummary(m.project, m.module);
  m.module.teamLeadId = newId; m.module.tlAcceptedAt = now; // the new Team Lead has the rights at once; the old one is "foreign" on this module from now on
  m.module.leadHistory = [...(m.module.leadHistory ?? []), { from: oldId ?? null, to: newId, by: oid(req.user.id), reason, at: now }];
  await Promise.all([m.module.save(), Project.updateOne({ _id: m.project._id }, { $addToSet: { members: newId } })]);

  // In-flight work: "review needed" bell items of the old Team Lead for this module's tasks move to the new one.
  const reviewIds = summary.inReview.map((t) => t.id), allReviewIds = (await Task.find({ milestoneId: m.module._id, status: "In-Review" }, "_id title").lean());
  let moved = 0;
  if (oldId && allReviewIds.length) {
    const r = await Notification.updateMany({ userId: oldId, read: false, "meta.taskId": { $in: allReviewIds.map((t) => t._id) } }, { $set: { read: true, "meta.resolved": "Moved to the new Team Lead" } });
    moved = r.modifiedCount ?? 0;
    for (const t of allReviewIds.slice(0, 20)) await notify(newId, req.user.orgId, "review_requested", "Review needed", `"${t.title}" is waiting for your review.`, { tier: "needs_action", meta: { taskId: t._id } });
  }
  const names = { actor: await nameOf(req.user.id), oldName: await nameOf(oldId), newName: cand.name };
  await notify(newId, req.user.orgId, "module_lead_changed", `You now lead ${m.module.title}`, `You are now Team Lead of "${m.module.title}" in "${m.project.title}" (changed by ${names.actor}). ${summaryLine(summary)}`, { tier: "needs_action", meta: { projectId: m.project._id, milestoneId: m.module._id }, deepLink: `/teamlead/modules/${m.module._id}` });
  if (oldId) await notify(oldId, req.user.orgId, "module_lead_changed", `You no longer lead ${m.module.title}`, `${cand.name} is now Team Lead of "${m.module.title}" in "${m.project.title}". Your past work stays on your record.`, { meta: { projectId: m.project._id, milestoneId: m.module._id } });
  const members = await Task.distinct("assignee", { milestoneId: m.module._id, assignee: { $ne: null } });
  for (const uid of members.filter((u) => ![String(newId), String(oldId ?? "")].includes(String(u)))) await notify(uid, req.user.orgId, "module_lead_changed", `${m.module.title} has a new Team Lead`, `${cand.name} now leads "${m.module.title}".`, { meta: { milestoneId: m.module._id } });
  audit(req, "module_lead_assigned", `Team Lead of module "${m.module.title}" changed from ${names.oldName ?? "nobody"} to ${cand.name} by ${names.actor}. Reason: ${reason}`, { targetProjectId: m.project._id, projectTitle: m.project.title, targetUserId: newId, before: { teamLeadId: oldId ? String(oldId) : null }, after: { teamLeadId: String(newId), reason } });
  res.status(201).json({ module: { id: m.module._id, title: m.module.title, teamLead: { id: newId, name: cand.name } }, previousTeamLead: oldId ? { id: oldId, name: names.oldName } : null, summary, moved: { reviews: moved } });
}

// ── Y-7: Manager asks, Team Lead decides ──────────────────────────────────────────
async function taskForManager(req, res) {
  if (!valid(req.params.id)) { res.status(404).json({ error: "Task not found." }); return null; }
  const task = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId }, "title status projectId milestoneId assignee assignees").lean();
  const project = task && await Project.findOne({ _id: task.projectId, ...(req.user.role === "Manager" ? { managerId: req.user.id } : {}) }, "title").lean();
  if (!task || !project) { res.status(404).json({ error: "Task not found." }); return null; }
  if (["Done", "Cancelled"].includes(task.status)) { res.status(409).json({ error: "A finished task cannot be reallocated." }); return null; }
  const module = task.milestoneId ? await Milestone.findById(task.milestoneId, "title teamLeadId").lean() : null;
  if (!module?.teamLeadId) { res.status(409).json({ error: "This task has no Team Lead yet. Assign a Team Lead to its module first." }); return null; }
  return { task, project, module };
}
async function sendToTeamLead(req, res, kind) {
  const t = await taskForManager(req, res); if (!t) return;
  const last = await ReallocationRequest.findOne({ taskId: t.task._id, requestedBy: req.user.id }).sort({ createdAt: -1 }).lean();
  const next = cooldownLeft(last?.createdAt);
  if (next) return res.status(429).json({ error: "You already asked about this task in the last 24 hours.", code: "COOLDOWN", nextAt: next, lastNudgedAt: last.createdAt });
  const reason = String(req.body?.reason ?? req.body?.message ?? "").trim().slice(0, 1000);
  if (kind === "reallocation" && reason.length < 5) return res.status(400).json({ error: "Give a reason (at least 5 characters)." });
  const from = t.task.assignee ?? t.task.assignees?.[0] ?? null;
  const request = await ReallocationRequest.create({ orgId: String(req.user.orgId), kind, taskId: t.task._id, projectId: t.project._id, milestoneId: t.module ? t.task.milestoneId : null, fromUserId: from,
    suggestedUserId: valid(req.body?.suggestedUserId) ? req.body.suggestedUserId : null, requestedBy: req.user.id, teamLeadId: t.module.teamLeadId, reason });
  const who = await nameOf(req.user.id);
  await notify(t.module.teamLeadId, req.user.orgId, kind === "nudge" ? "nudge_team_lead" : "reallocation_requested", kind === "nudge" ? "A Manager is waiting" : "Reallocation requested",
    kind === "nudge" ? `${who} is waiting for "${t.task.title}" in "${t.project.title}"${reason ? `: ${reason}` : "."}` : `${who} asks you to reallocate "${t.task.title}" in "${t.project.title}": ${reason}`,
    { tier: "needs_action", meta: { taskId: t.task._id, requestId: request._id }, deepLink: `/teamlead/tasks/${t.task._id}` });
  return res.status(201).json(kind === "nudge" ? { nudgedAt: request.createdAt } : { request: await requestOut(request) });
}
export const requestReallocation = (req, res) => sendToTeamLead(req, res, "reallocation");
export const nudgeTeamLead = (req, res) => sendToTeamLead(req, res, "nudge");

async function requestOut(r) {
  const [task, project, from, tl] = await Promise.all([Task.findById(r.taskId, "title").lean(), Project.findById(r.projectId, "title").lean(), nameOf(r.fromUserId), nameOf(r.teamLeadId)]);
  return { id: r._id, kind: r.kind, status: r.status, task: { id: r.taskId, title: task?.title ?? "Task" }, project: { id: r.projectId, title: project?.title ?? "Project" },
    from: r.fromUserId ? { id: r.fromUserId, name: from } : null, teamLead: { id: r.teamLeadId, name: tl }, reason: r.reason, declineReason: r.declineReason, createdAt: r.createdAt, decidedAt: r.decidedAt };
}
// GET /api/manager/reallocation-requests
export async function listSent(req, res) {
  const rows = await ReallocationRequest.find({ requestedBy: req.user.id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ items: await Promise.all(rows.map(requestOut)) });
}
// GET /api/teamlead/reallocation-requests?status=pending|all
export async function listForTeamLead(req, res) {
  const rows = await ReallocationRequest.find({ teamLeadId: req.user.id, ...(req.query.status === "all" ? {} : { status: "pending" }) }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ items: await Promise.all(rows.map(requestOut)) });
}
// POST /api/teamlead/reallocation-requests/:id/decline { reason }
export async function declineRequest(req, res) {
  const r = valid(req.params.id) ? await ReallocationRequest.findOne({ _id: req.params.id, teamLeadId: req.user.id }) : null;
  if (!r) return res.status(404).json({ error: "Request not found." });
  if (r.status !== "pending") return res.status(409).json({ error: "This request was already answered." });
  const reason = String(req.body?.reason ?? "").trim().slice(0, 1000);
  if (reason.length < 5) return res.status(400).json({ error: "Give a reason for declining (at least 5 characters)." });
  r.status = "declined"; r.declineReason = reason; r.decidedAt = new Date(); await r.save();
  const task = await Task.findById(r.taskId, "title").lean();
  await notify(r.requestedBy, req.user.orgId, "reallocation_declined", "Reallocation declined", `${await nameOf(req.user.id)} declined to reallocate "${task?.title ?? "the task"}": ${reason}`, { meta: { taskId: r.taskId, requestId: r._id }, deepLink: `/manager/tasks/${r.taskId}` });
  res.json({ request: await requestOut(r) });
}

// ── Y-7: Reassign (Team Lead only) ────────────────────────────────────────────────
async function tlTask(req, res) {
  if (!valid(req.params.id)) { res.status(404).json({ error: "Task not found." }); return null; }
  const task = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId });
  const project = task && await Project.findById(task.projectId, "title members status").lean();
  if (!task || !project) { res.status(404).json({ error: "Task not found." }); return null; }
  const module = task.milestoneId ? await Milestone.findById(task.milestoneId, "title teamLeadId").lean() : null;
  const mine = module ? String(module.teamLeadId) === String(req.user.id) : (project.members ?? []).map(String).includes(String(req.user.id));
  if (!mine) { res.status(403).json({ error: "Only the Team Lead of this module can reassign its tasks." }); return null; }
  return { task, project, module };
}
const loggedHoursOf = (task) => Math.round(((task.timeLogs ?? []).reduce((s, l) => s + (l.minutes ?? 0), 0) / 60) * 100) / 100;

// GET /api/teamlead/tasks/:id/reassign/preview?toUserId=
export async function reassignPreview(req, res) {
  const t = await tlTask(req, res); if (!t) return;
  const scope = await orgScope(req.user.orgId);
  const cand = await candidateInfo(req, scope, t.project, req.query.toUserId);
  const logged = loggedHoursOf(t.task), remaining = remainingHours(t.task.estimatedHours, logged);
  const wt = orgWorkTime(scope.org), hoursUntilDue = t.task.deadline ? Math.max(0, workingDaysLeft(new Date(), t.task.deadline, wt)) * (wt.hoursPerDay ?? 8) : null;
  const prevId = t.task.assignee ?? t.task.assignees?.[0] ?? null;
  res.json({
    task: { id: t.task._id, title: t.task.title, status: t.task.status, estimatedHours: t.task.estimatedHours ?? 0, loggedHours: logged, remainingHours: remaining, hoursUntilDue, deadline: t.task.deadline ?? null, needsExtension: hoursUntilDue == null ? false : needsExtension(remaining, hoursUntilDue) },
    previous: prevId ? { id: prevId, name: await nameOf(prevId), loggedHours: logged, notes: t.task.submissionNote ?? null } : null,
    candidate: cand ? { id: cand.id, name: cand.name, freeHoursPerDay: cand.freeHoursPerDay, utilisationPct: cand.utilisationPct, overCapacity: cand.overloaded, inProject: cand.inProject } : null,
    reassignCount: (t.task.reassignments ?? []).length,
  });
}

// POST /api/teamlead/tasks/:id/reassign { toUserId, reason, handoverSharePct?, acknowledgeDeadline?, requestId? }
export async function reassign(req, res) {
  const t = await tlTask(req, res); if (!t) return;
  const { toUserId, requestId } = req.body ?? {};
  const reason = String(req.body?.reason ?? "").trim().slice(0, 500), sharePct = req.body?.handoverSharePct === undefined ? 0 : Number(req.body.handoverSharePct);
  const scope = await orgScope(req.user.orgId);
  const cand = await candidateInfo(req, scope, t.project, toUserId);
  const prevId = t.task.assignee ?? t.task.assignees?.[0] ?? null;
  const err = reassignError({ task: { status: t.task.status, assignee: prevId }, toUserId, reason, sharePct, to: cand && { role: cand.user.role, status: cand.user.status, inProject: cand.inProject } });
  if (err) return res.status(/finished/.test(err) ? 409 : 400).json({ error: err });
  const logged = loggedHoursOf(t.task), remaining = remainingHours(t.task.estimatedHours, logged);
  const wt = orgWorkTime(scope.org), hoursUntilDue = t.task.deadline ? Math.max(0, workingDaysLeft(new Date(), t.task.deadline, wt)) * (wt.hoursPerDay ?? 8) : null;
  const tight = hoursUntilDue != null && needsExtension(remaining, hoursUntilDue);
  if (tight && req.body?.acknowledgeDeadline !== true) return res.status(409).json({ error: "The work left does not fit before the deadline. Ask for more time first.", code: "DEADLINE_TOO_TIGHT", remainingHours: remaining, hoursUntilDue });

  const now = new Date(), count = (t.task.reassignments ?? []).length + 1;
  t.task.assignee = cand.id; t.task.assignees = [cand.id];
  t.task.reassignments = [...(t.task.reassignments ?? []), { from: prevId, to: cand.id, by: oid(req.user.id), reason, loggedHours: logged, sharePct, at: now }];
  t.task.handover = sharePct > 0 && prevId ? { fromUserId: prevId, sharePct, reason, by: oid(req.user.id), at: now } : t.task.handover ?? null;
  if (count >= 3) t.task.reviewFlags.push({ kind: "reassign_churn", status: "open", evidence: { count }, note: `Reassigned ${count} times.`, createdAt: now });
  await t.task.save();

  const [byName, fromName] = await Promise.all([nameOf(req.user.id), nameOf(prevId)]);
  await notify(cand.id, req.user.orgId, "task_reassigned", "Task reassigned to you", `"${t.task.title}" was reassigned to you${fromName ? ` from ${fromName}` : ""} by ${byName}: ${reason}. ${logged} of ${t.task.estimatedHours ?? 0} h already done.${t.task.submissionNote ? ` Notes: ${t.task.submissionNote}` : ""}`,
    { tier: "needs_action", meta: { taskId: t.task._id }, deepLink: `/workspace/tasks?task=${t.task._id}` });
  if (prevId) await notify(prevId, req.user.orgId, "task_reassigned", "Task taken back", `"${t.task.title}" was taken back by ${byName}. No penalty. Your logged time stays on the task.`, { meta: { taskId: t.task._id } });
  if (valid(requestId)) {
    const r = await ReallocationRequest.findOne({ _id: requestId, teamLeadId: req.user.id, status: "pending" });
    if (r) { r.status = "accepted"; r.decidedAt = now; await r.save(); await notify(r.requestedBy, req.user.orgId, "reallocation_accepted", "Reallocation accepted", `${byName} reassigned "${t.task.title}" to ${cand.name}.`, { meta: { taskId: t.task._id, requestId: r._id } }); }
  }
  audit(req, "task_reassigned", `Task "${t.task.title}" reassigned from ${fromName ?? "nobody"} to ${cand.name} by ${byName}. Reason: ${reason}${sharePct ? ` Handover share ${sharePct}%.` : ""}`, { targetProjectId: t.project._id, projectTitle: t.project.title, targetUserId: cand.id });
  res.json({ task: { id: t.task._id, assignee: { id: cand.id, name: cand.name } }, reassignCount: count, needsExtension: tight, handover: t.task.handover ? { fromUserId: t.task.handover.fromUserId, sharePct: t.task.handover.sharePct } : null });
}

// ── Y-8: Remove member from project ───────────────────────────────────────────────
async function memberContext(req, res) {
  if (!valid(req.params.id) || !valid(req.params.userId)) { res.status(404).json({ error: "Person not found in this project." }); return null; }
  const project = await Project.findOne({ _id: req.params.id, orgId: { $in: [String(req.user.orgId)] } }, "title status members managerId").lean() ?? await Project.findById(req.params.id, "title status members managerId").lean();
  if (!project || !(project.members ?? []).map(String).includes(req.params.userId)) { res.status(404).json({ error: "Person not found in this project." }); return null; }
  const person = await User.findById(req.params.userId, "name role").lean();
  const [openTasks, ledModules] = await Promise.all([
    Task.find({ projectId: project._id, status: { $nin: ["Done", "Cancelled"] }, $or: [{ assignee: req.params.userId }, { assignees: req.params.userId }] }, "title status milestoneId").populate("milestoneId", "title").lean(),
    Milestone.find({ projectId: project._id, teamLeadId: req.params.userId }, "title").lean(),
  ]);
  return { project, person, blockers: removeBlockers({ openTasks: openTasks.map((t) => ({ id: t._id, title: t.title, status: t.status, module: t.milestoneId?.title ?? null })), ledModules: ledModules.map((m) => ({ id: m._id, title: m.title })) }) };
}
// GET /api/manager/projects/:id/members/:userId/remove-check
export async function removeCheck(req, res) {
  const c = await memberContext(req, res); if (!c) return;
  res.json({ canRemove: c.blockers.length === 0, blockers: c.blockers, willKeep: ["tasks done", "XP", "badges", "on-time record", "AI evaluations"] });
}
// DELETE /api/manager/projects/:id/members/:userId { reason? }
export async function removeMember(req, res) {
  const c = await memberContext(req, res); if (!c) return;
  if (c.blockers.length) return res.status(409).json({ error: c.blockers[0].message, code: "BLOCKED", blockers: c.blockers });
  const now = new Date(), reason = String(req.body?.reason ?? "").trim().slice(0, 500);
  await Project.updateOne({ _id: c.project._id }, { $pull: { members: oid(req.params.userId) }, $push: { formerMembers: { userId: oid(req.params.userId), removedAt: now, removedBy: oid(req.user.id), reason } } });
  // The person leaves the project chat (old messages stay).
  const coms = await ChatCommunity.find({ projectId: c.project._id }, "_id").lean().catch(() => []);
  if (coms.length) {
    await ChatCommunity.updateMany({ _id: { $in: coms.map((x) => x._id) } }, { $pull: { memberIds: oid(req.params.userId) } }).catch(() => {});
    await ChatChannel.updateMany({ communityId: { $in: coms.map((x) => x._id) } }, { $pull: { memberIds: oid(req.params.userId) } }).catch(() => {});
  }
  await notify(req.params.userId, req.user.orgId, "removed_from_project", "Removed from a project", `You are no longer on "${c.project.title}". Your past work, XP and badges stay on your record.`, { meta: { projectId: c.project._id } });
  const tls = await Milestone.distinct("teamLeadId", { projectId: c.project._id, teamLeadId: { $ne: null } });
  for (const tl of tls) await notify(tl, req.user.orgId, "removed_from_project", "Team member removed", `${c.person?.name ?? "A person"} was removed from "${c.project.title}".`, { meta: { projectId: c.project._id } });
  audit(req, "project_member_removed", `${c.person?.name ?? "A person"} removed from the project by ${await nameOf(req.user.id)}.${reason ? ` Reason: ${reason}` : ""}`, { targetProjectId: c.project._id, projectTitle: c.project.title, targetUserId: oid(req.params.userId) });
  res.json({ removed: true, formerMember: { id: req.params.userId, name: c.person?.name ?? "Former member", removedAt: now } });
}
