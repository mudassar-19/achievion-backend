// Manager Challenges + Anomalies (V2 Phase 3 · M-5, UX §8–9). Manager only (route guard); every quest, flag,
// person, project, team and sprint is checked against the caller's org. XP only moves through the engine
// (gamificationService.applyQuestReward / applyFlagReversal); this file never writes XP or the ledger itself.
import mongoose from "mongoose";
import Quest    from "../models/Quest.js";
import Task     from "../models/Task.js";
import User     from "../models/User.js";
import Project  from "../models/Project.js";
import Team     from "../models/Team.js";
import Sprint   from "../models/Sprint.js";
import XpLog    from "../models/XpLog.js";
import AuditLog from "../models/AuditLog.js";
import { createNotification } from "./notificationController.js";
import { orgScope } from "./managerProjectsController.js";
import { applyFlagReversal, BADGE_DEFINITIONS } from "../services/gamificationService.js";
const VALID_BADGE_IDS = new Set(BADGE_DEFINITIONS.map((b) => b.id));
import { resolveParticipants, refreshQuest, sweepQuests } from "../services/questService.js";
import { isReadOnly } from "../middleware/viewAs.js";
import {
  METRICS, PAGE_SIZE, STATUSES, rewardCap, validateQuestInput, publishBlockers, editable, duplicateOf, progressPct,
} from "../services/questRules.js";
import { FLAG_KINDS, FLAG_LABEL, flagReason } from "../services/anomalyRules.js";
import { entryFor } from "../services/questJoinRules.js";

const LEADERS = ["Director", "Manager"];
const valid = (id) => mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(String(id));
const idsOf = (scope) => scope.filter.orgId.$in;

async function scopeOr404(req, res) {
  const scope = await orgScope(req.user.orgId);
  if (!scope) res.status(404).json({ error: "Organization not found." });
  return scope;
}
const log = (scope, req, action, detail, extra = {}) => AuditLog.create({ action, orgId: scope.org._id, performedBy: req.user.id, detail, ...extra })
  .catch((e) => console.error("[audit]", e.message));
const fail = (res, errors) => res.status(400).json({ error: Object.values(errors)[0], fields: errors });

// ════════════════════════════ Challenges ════════════════════════════════════

// Scope target and sprint must be in the org. Returns { errors } or { sprintEnd }.
async function checkRefs(scope, body) {
  const org = { orgId: { $in: idsOf(scope) } };
  const ref = body.scope === "individual" ? { kind: "user", id: body.scopeRef?.id } : body.scopeRef;
  if (body.scope !== "organisation" && ref?.id && valid(ref.id)) {
    const ok = ref.kind === "user" ? await User.exists({ _id: ref.id, ...org, status: "active", role: { $nin: LEADERS } })
      : ref.kind === "project" ? await Project.exists({ _id: ref.id, ...org, isDeleted: { $ne: true } })
      : ref.kind === "team" ? await Team.exists({ _id: ref.id, ...org }) : null;
    if (!ok) return { errors: { scopeRef: "Choose from your organization." } };
  }
  if (body.type === "sprint" && valid(body.sprintId)) {
    const sp = await Sprint.findOne({ _id: body.sprintId, ...org, status: { $ne: "Completed" } }, "endDate").lean();
    if (!sp?.endDate) return { errors: { sprintId: "Choose an open sprint with an end date." } };
    return { sprintEnd: sp.endDate };
  }
  return {};
}

const questOut = (q) => {
  const done = (q.progress ?? []).filter((p) => p.completedAt).length;
  return {
    id: q._id, title: q.title, description: q.description, type: q.type, repeat: q.repeat, sprintId: q.sprintId, metric: q.metric,
    metricLabel: METRICS[q.metric]?.label, target: q.target, scope: q.scope, scopeRef: q.scopeRef?.id ? q.scopeRef : null,
    rewardXp: q.rewardXp, rewardGold: q.rewardGold, startDate: q.startDate, deadline: q.deadline, status: q.status, endedEarly: q.endedEarly,
    participants: q.participants?.length ?? 0, completed: done, publishedAt: q.publishedAt, closedAt: q.closedAt, seriesId: q.seriesId,
  };
};

async function loadQuest(req, res, scope) {
  const q = valid(req.params.id) ? await Quest.findOne({ _id: req.params.id, orgId: { $in: idsOf(scope) } }) : null;
  if (!q) res.status(404).json({ error: "Challenge not found." });
  return q;
}

// GET /api/manager/quests/options
export async function questOptions(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const org = { orgId: { $in: idsOf(scope) } };
  const [projects, teams, people, sprints] = await Promise.all([
    Project.find({ ...org, isDeleted: { $ne: true }, status: { $nin: ["Archived", "Deleted", "Completed"] } }, "title").sort({ title: 1 }).lean(),
    Team.find({ ...org, status: { $ne: "archived" } }, "name").sort({ name: 1 }).lean(),
    User.find({ ...org, status: "active", role: { $nin: LEADERS } }, "name role").sort({ name: 1 }).lean(),
    Sprint.find({ ...org, status: { $ne: "Completed" }, endDate: { $ne: null } }, "name endDate projectId").sort({ endDate: 1 }).lean(),
  ]);
  res.json({
    cap: rewardCap(scope.org), metrics: Object.entries(METRICS).map(([value, m]) => ({ value, label: m.label, unit: m.unit })),
    projects: projects.map((p) => ({ id: p._id, title: p.title })), teams: teams.map((t) => ({ id: t._id, name: t.name })),
    people: people.map((u) => ({ id: u._id, name: u.name, role: u.role })), sprints: sprints.map((s) => ({ id: s._id, name: s.name, endDate: s.endDate })),
    badges: BADGE_DEFINITIONS.map((b) => ({ id: b.id, name: b.name, rarity: b.rarity })),
  });
}

// GET /api/manager/quests?status=draft|active|completed|expired&page=n
export async function listQuests(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const org = { orgId: { $in: idsOf(scope) } };
  if (!isReadOnly()) await sweepQuests(org, idsOf(scope)); // read-time expiry / repeat (not in View as, D-109)
  const status = STATUSES.includes(req.query.status) ? req.query.status : "active";
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const [counts, total, items] = await Promise.all([
    Quest.aggregate([{ $match: org }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    Quest.countDocuments({ ...org, status }),
    Quest.find({ ...org, status }).sort(status === "draft" ? { updatedAt: -1 } : { deadline: status === "active" ? 1 : -1, _id: -1 })
      .skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
  ]);
  res.json({ status, page, pageSize: PAGE_SIZE, total, counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0])), items: items.map(questOut) });
}

// POST /api/manager/quests  → draft
export async function createQuest(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const refs = await checkRefs(scope, req.body ?? {});
  if (refs.errors) return fail(res, refs.errors);
  const { errors, value } = validateQuestInput({ ...req.body, sprintEnd: refs.sprintEnd }, { cap: rewardCap(scope.org), validBadgeIds: VALID_BADGE_IDS });
  if (Object.keys(errors).length) return fail(res, errors);
  const q = await Quest.create({ ...value, orgId: req.user.orgId, status: "draft", createdBy: req.user.id, aiDraft: req.body?.aiDraft === true }); // Batch 3: AI-made → automatic entry
  log(scope, req, "quest_created", `Challenge "${q.title}" drafted.`);
  res.status(201).json(questOut(q));
}

// GET /api/manager/quests/:id  (live progress per member, rewards given, series history)
export async function getQuest(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  let q = await loadQuest(req, res, scope); if (!q) return;
  if (q.status === "active" && !isReadOnly()) q = await refreshQuest(q, { orgIds: idsOf(scope) });
  const ids = q.progress?.length ? q.progress.map((p) => p.userId) : q.participants;
  const [people, rewards, series, refName] = await Promise.all([
    User.find({ _id: { $in: ids } }, "name role").lean(),
    XpLog.find({ source: "quest", questId: q._id }, "userId amount breakdown createdAt").lean(),
    q.seriesId ? Quest.find({ seriesId: q.seriesId, _id: { $ne: q._id } }, "status startDate deadline progress participants").sort({ startDate: -1 }).limit(10).lean() : [],
    q.scopeRef?.id ? (q.scopeRef.kind === "user" ? User.findById(q.scopeRef.id, "name").lean() : q.scopeRef.kind === "project" ? Project.findById(q.scopeRef.id, "title").lean() : Team.findById(q.scopeRef.id, "name").lean()) : null,
  ]);
  const name = Object.fromEntries(people.map((u) => [String(u._id), u]));
  const rewardBy = Object.fromEntries(rewards.map((r) => [String(r.userId), r]));
  const sprint = q.sprintId ? await Sprint.findById(q.sprintId, "name").lean() : null;
  res.json({
    ...questOut(q), daysLeft: q.status === "active" ? Math.max(0, Math.ceil((new Date(q.deadline) - Date.now()) / 86_400_000)) : null, scopeName: refName?.name ?? refName?.title ?? null, sprintName: sprint?.name ?? null, editable: editable(q.status),
    members: (q.progress?.length ? q.progress : (q.participants ?? []).map((u) => ({ userId: u, value: 0, tasks: 0 }))).map((p) => ({
      id: p.userId, name: name[String(p.userId)]?.name ?? "Former member", role: name[String(p.userId)]?.role ?? "",
      value: p.value, tasks: p.tasks, pct: progressPct(p.value, q.target), completedAt: p.completedAt ?? null,
      reward: rewardBy[String(p.userId)] ? { xp: rewardBy[String(p.userId)].amount, gold: rewardBy[String(p.userId)].breakdown?.gold ?? 0, at: rewardBy[String(p.userId)].createdAt } : null,
    })).sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name)),
    rewardsGiven: { people: rewards.length, xp: rewards.reduce((s, r) => s + r.amount, 0), gold: rewards.reduce((s, r) => s + (r.breakdown?.gold ?? 0), 0) },
    history: series.map((s) => ({ id: s._id, status: s.status, startDate: s.startDate, deadline: s.deadline, participants: s.participants?.length ?? 0, completed: (s.progress ?? []).filter((p) => p.completedAt).length })),
  });
}

// PATCH /api/manager/quests/:id  — draft: everything; active: title and description only; closed: nothing.
export async function updateQuest(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const q = await loadQuest(req, res, scope); if (!q) return;
  const mode = editable(q.status);
  if (mode === "none") return res.status(409).json({ error: "A finished challenge cannot be changed." });
  if (mode === "title") {
    const title = String(req.body?.title ?? q.title).trim();
    if (title.length < 3 || title.length > 100) return fail(res, { title: "Give the challenge a title (3–100 characters)." });
    const changed = ["metric", "target", "scope", "scopeRef", "rewardXp", "rewardGold", "type", "startDate", "deadline", "sprintId", "repeat"].filter((k) => k in (req.body ?? {}) && JSON.stringify(req.body[k]) !== JSON.stringify(q[k]));
    if (changed.length) return res.status(409).json({ error: "A running challenge keeps its goal, people, reward and dates. You can change the title, or end it and duplicate." });
    q.title = title; q.description = String(req.body?.description ?? q.description).trim().slice(0, 500);
  } else {
    const body = { ...questOut(q), ...req.body };
    const refs = await checkRefs(scope, body);
    if (refs.errors) return fail(res, refs.errors);
    const { errors, value } = validateQuestInput({ ...body, sprintEnd: refs.sprintEnd }, { cap: rewardCap(scope.org), validBadgeIds: VALID_BADGE_IDS });
    if (Object.keys(errors).length) return fail(res, errors);
    Object.assign(q, value);
  }
  await q.save();
  log(scope, req, "quest_updated", `Challenge "${q.title}" updated.`);
  res.json(questOut(q));
}

export async function deleteQuest(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const q = await loadQuest(req, res, scope); if (!q) return;
  if (q.status !== "draft") return res.status(409).json({ error: "Only a draft can be deleted. End a running challenge instead." });
  await Quest.deleteOne({ _id: q._id, status: "draft" });
  log(scope, req, "quest_deleted", `Draft challenge "${q.title}" deleted.`, { before: questOut(q) });
  res.json({ ok: true });
}

// POST /api/manager/quests/:id/publish  → active, participants fixed from the scope, everyone in it notified
export async function publishQuest(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const q = await loadQuest(req, res, scope); if (!q) return;
  if (q.status === "draft" && q.type === "sprint" && q.sprintId && !(await Sprint.exists({ _id: q.sprintId, status: { $ne: "Completed" } }))) {
    return res.status(409).json({ error: "That sprint is closed. Pick another sprint first." });
  }
  // Batch 3 (E13, UC-17 step 3): a hand-made team / company quest starts empty and people join it; the people in scope are told.
  const inScope = q.status === "draft" ? await resolveParticipants(q, idsOf(scope)) : [];
  const entry = entryFor(q), participants = entry === "join" ? [] : inScope;
  const reasons = publishBlockers(q, { participants: inScope.length });
  if (reasons.length) return res.status(409).json({ error: reasons[0], reasons });
  const done = await Quest.findOneAndUpdate({ _id: q._id, status: "draft" },
    { $set: { status: "active", entry, participants, progress: [], publishedAt: new Date(), seriesId: q.repeat ? q._id : null } }, { returnDocument: "after" });
  if (!done) return res.status(409).json({ error: "Only a draft can be published." });
  for (const uid of inScope) {
    createNotification({ userId: uid, orgId: req.user.orgId, type: "quest_published", title: "New challenge",
      message: `"${done.title}": ${METRICS[done.metric].label.toLowerCase()} ${done.target} by ${done.deadline.toDateString()}. Reward ${done.rewardXp} XP${done.rewardGold ? ` + ${done.rewardGold} gold` : ""}.${entry === "join" ? " Join it on Quests." : ""}`,
      meta: { questId: done._id } }).catch(() => {});
  }
  log(scope, req, "quest_published", `Challenge "${done.title}" published to ${inScope.length} people${entry === "join" ? " (they join it themselves)" : ""}.`);
  res.json({ ...questOut(done), entry, notified: inScope.length });
}

// POST /api/manager/quests/:id/end  → pays anything already earned, then closes (Expired, ended early). No repeat.
export async function endQuest(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  let q = await loadQuest(req, res, scope); if (!q) return;
  if (q.status !== "active") return res.status(409).json({ error: "Only a running challenge can be ended." });
  q = await refreshQuest(q, { by: req.user.id, orgIds: idsOf(scope) });
  const done = await Quest.findOneAndUpdate({ _id: q._id, status: "active" }, { $set: { status: "expired", endedEarly: true, closedAt: new Date(), repeat: false } }, { returnDocument: "after" });
  if (!done) return res.status(409).json({ error: "This challenge has already finished." });
  log(scope, req, "quest_ended", `Challenge "${done.title}" ended early. Rewards already earned were kept.`);
  res.json(questOut(done));
}

export async function duplicateQuest(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const q = await loadQuest(req, res, scope); if (!q) return;
  const copy = await Quest.create({ ...duplicateOf(q.toObject()), orgId: req.user.orgId, createdBy: req.user.id });
  log(scope, req, "quest_created", `Challenge "${copy.title}" drafted from "${q.title}".`);
  res.status(201).json(questOut(copy));
}

// ════════════════════════════ Anomalies ═════════════════════════════════════

const flagMatch = (scope, extra = {}) => ({ orgId: { $in: idsOf(scope) }, "reviewFlags.0": { $exists: true }, ...extra });

// Awards a flag is about: the named person, or every award of the task (task-wide flags).
const awardsFor = (taskId, flag) => XpLog.find({ taskId, source: "task_approved", ...(flag.userId ? { userId: flag.userId } : {}) }).lean();

// GET /api/manager/anomalies?status=open|reviewed&reason=<kind,kind>&page=n
export async function listAnomalies(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const kinds = String(req.query.reason ?? "").split(",").filter((k) => FLAG_KINDS.includes(k));
  const status = req.query.status === "reviewed" ? { $in: ["dismissed", "confirmed"] } : req.query.status === "all" ? { $exists: true } : "open";
  const rows = await Task.aggregate([
    { $match: flagMatch(scope) }, { $unwind: "$reviewFlags" },
    { $match: { "reviewFlags.status": status, ...(kinds.length ? { "reviewFlags.kind": { $in: kinds } } : {}) } },
    { $sort: { "reviewFlags.createdAt": -1 } },
    { $facet: { total: [{ $count: "n" }], items: [{ $skip: (page - 1) * PAGE_SIZE }, { $limit: PAGE_SIZE },
      { $project: { title: 1, assignees: 1, assignee: 1, flag: "$reviewFlags" } }] } },
  ]);
  const items = rows[0]?.items ?? [];
  const logs = await XpLog.find({ taskId: { $in: items.map((t) => t._id) }, source: "task_approved" }, "taskId userId amount").lean();
  const users = await User.find({ _id: { $in: [...new Set([...items.flatMap((t) => [t.flag.userId, t.flag.reviewedBy, ...(t.assignees ?? []), t.assignee]), ...logs.map((l) => l.userId)].filter(Boolean).map(String))] } }, "name").lean();
  const nameOf = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
  res.json({
    page, pageSize: PAGE_SIZE, total: rows[0]?.total?.[0]?.n ?? 0,
    items: items.map((t) => {
      const mine = logs.filter((l) => String(l.taskId) === String(t._id) && (!t.flag.userId || String(l.userId) === String(t.flag.userId)));
      const people = t.flag.userId ? [t.flag.userId] : mine.length ? mine.map((l) => l.userId) : [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])];
      return {
        id: t.flag._id, taskId: t._id, task: t.title, kind: t.flag.kind, reason: FLAG_LABEL[t.flag.kind], status: t.flag.status, date: t.flag.createdAt,
        people: [...new Set(people.map(String))].map((id) => ({ id, name: nameOf[id] ?? "Former member" })),
        xp: t.flag.xp ?? (mine.length ? mine.reduce((s, l) => s + l.amount, 0) : null),
        // Batch 5 (D9): who decided and when (null while the flag is open)
        decidedBy: t.flag.status !== "open" && t.flag.reviewedBy ? nameOf[String(t.flag.reviewedBy)] ?? "Former member" : null, decidedAt: t.flag.status !== "open" ? t.flag.reviewedAt ?? null : null,
      };
    }),
  });
}

export async function anomalyCount(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const [r] = await Task.aggregate([{ $match: flagMatch(scope) }, { $unwind: "$reviewFlags" }, { $match: { "reviewFlags.status": "open" } }, { $count: "n" }]);
  res.json({ open: r?.n ?? 0 });
}

async function loadFlag(req, res, scope, fields = "") {
  if (!valid(req.params.flagId)) { res.status(404).json({ error: "Flag not found." }); return null; }
  const task = await Task.findOne({ orgId: { $in: idsOf(scope) }, "reviewFlags._id": req.params.flagId }, `title status projectId assignee assignees submittedAt reviewedAt completedAt reviewedBy qualityScore tlScore reviewFlags ${fields}`).lean();
  if (!task) { res.status(404).json({ error: "Flag not found." }); return null; }
  return { task, flag: task.reviewFlags.find((f) => String(f._id) === req.params.flagId) };
}

// GET /api/manager/anomalies/:flagId  (evidence drawer; AI score only when the TL also scored, D-075)
export async function getAnomaly(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const loaded = await loadFlag(req, res, scope, "+aiScore"); if (!loaded) return;
  const { task, flag } = loaded;
  const awards = await awardsFor(task._id, flag);
  const reversals = await XpLog.find({ reversalOf: { $in: awards.map((a) => a._id) } }, "reversalOf amount createdAt").lean();
  const people = [...new Set((flag.userId ? [flag.userId] : awards.length ? awards.map((a) => a.userId) : [...(task.assignees ?? []), task.assignee].filter(Boolean)).map(String))];
  const since = new Date(Date.now() - 90 * 86_400_000);
  const [users, reviewer, history, otherFlags] = await Promise.all([
    User.find({ _id: { $in: people } }, "name role").lean(),
    (task.reviewedBy ?? flag.by) ? User.findById(task.reviewedBy ?? flag.by, "name").lean() : null,
    XpLog.aggregate([{ $match: { userId: { $in: people.map((p) => new mongoose.Types.ObjectId(p)) }, source: "task_approved", createdAt: { $gte: since } } },
      { $group: { _id: "$userId", tasks: { $sum: 1 }, avgXp: { $avg: "$amount" }, avgStars: { $avg: "$qualityScore" }, late: { $sum: { $cond: ["$isLate", 1, 0] } } } }]),
    Task.aggregate([{ $match: flagMatch(scope) }, { $unwind: "$reviewFlags" },
      { $match: { "reviewFlags._id": { $ne: flag._id }, $or: [{ "reviewFlags.userId": { $in: people.map((p) => new mongoose.Types.ObjectId(p)) } }, { assignees: { $in: people.map((p) => new mongoose.Types.ObjectId(p)) } }] } }, { $count: "n" }]),
  ]);
  const scored = task.tlScore != null;
  const evidence = { ...(flag.evidence ?? {}), ...(flag.kind === "ai_tl_disagreement" ? { aiScore: flag.aiScore, tlScore: flag.tlScore, gap: flag.gap } : {}) };
  res.json({
    id: flag._id, kind: flag.kind, label: FLAG_LABEL[flag.kind], reason: flagReason(flag.kind, evidence), status: flag.status, date: flag.createdAt,
    note: flag.note ?? "", reviewedAt: flag.reviewedAt ?? null,
    task: { id: task._id, title: task.title, status: task.status, submittedAt: task.submittedAt, approvedAt: task.reviewedAt ?? task.completedAt,
      minutesToApprove: task.submittedAt && (task.reviewedAt ?? task.completedAt) ? Math.round((new Date(task.reviewedAt ?? task.completedAt) - new Date(task.submittedAt)) / 60_000) : null,
      stars: task.qualityScore ?? awards[0]?.qualityScore ?? null, tlScore: task.tlScore, aiScore: scored ? task.aiScore ?? null : null, reviewer: reviewer?.name ?? null },
    awards: awards.map((a) => ({ id: a._id, userId: a.userId, name: users.find((u) => String(u._id) === String(a.userId))?.name ?? "Former member", xp: a.amount, gold: a.breakdown?.gold ?? 0, at: a.createdAt,
      reversed: reversals.find((r) => String(r.reversalOf) === String(a._id))?.amount ?? null })),
    people: users.map((u) => {
      const h = history.find((x) => String(x._id) === String(u._id));
      return { id: u._id, name: u.name, role: u.role, last90: { tasks: h?.tasks ?? 0, avgXp: h ? Math.round(h.avgXp) : 0, avgStars: h?.avgStars ? Math.round(h.avgStars * 10) / 10 : null, late: h?.late ?? 0 } };
    }),
    otherFlags: otherFlags[0]?.n ?? 0,
  });
}

// Atomic status move for one flag; returns true when this call changed it.
async function setFlag(scope, flagId, from, set) {
  const r = await Task.updateOne({ orgId: { $in: idsOf(scope) }, reviewFlags: { $elemMatch: { _id: flagId, status: { $in: from } } } },
    { $set: Object.fromEntries(Object.entries(set).map(([k, v]) => [`reviewFlags.$.${k}`, v])) });
  return r.modifiedCount === 1;
}

// POST /api/manager/anomalies/:flagId/dismiss { note }  (reversible: /reopen)
export async function dismissAnomaly(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const loaded = await loadFlag(req, res, scope); if (!loaded) return;
  const note = String(req.body?.note ?? "").trim().slice(0, 500);
  if (!await setFlag(scope, loaded.flag._id, ["open"], { status: "dismissed", note, reviewedBy: req.user.id, reviewedAt: new Date() })) return res.status(409).json({ error: "This flag was already reviewed." });
  log(scope, req, "flag_dismissed", `Flag on "${loaded.task.title}" (${FLAG_LABEL[loaded.flag.kind]}) dismissed.${note ? ` Note: ${note}` : ""}`, { targetProjectId: loaded.task.projectId ?? null });
  res.json({ ok: true, status: "dismissed" });
}

export async function reopenAnomaly(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const loaded = await loadFlag(req, res, scope); if (!loaded) return;
  if (!await setFlag(scope, loaded.flag._id, ["dismissed"], { status: "open", note: "", reviewedBy: null, reviewedAt: null })) return res.status(409).json({ error: "Only a dismissed flag can be reopened." });
  log(scope, req, "flag_reopened", `Flag on "${loaded.task.title}" reopened.`, { targetProjectId: loaded.task.projectId ?? null });
  res.json({ ok: true, status: "open" });
}

// POST /api/manager/anomalies/:flagId/confirm { note }  → XP reversal through the engine, once per award.
export async function confirmAnomaly(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const loaded = await loadFlag(req, res, scope); if (!loaded) return;
  const { task, flag } = loaded;
  if (flag.status === "confirmed") return res.json({ ok: true, already: true, reversed: [] });
  const reversed = [];
  // T-6 (D-148): the reviewer's XP for this review goes back with it (reversalOf is unique, so once).
  const reviewAwards = await XpLog.find({ taskId: task._id, source: "tl_review_efficiency" }).lean();
  for (const original of [...await awardsFor(task._id, flag), ...reviewAwards]) {
    const plan = await applyFlagReversal({ original, flagId: flag._id, by: req.user.id, orgId: req.user.orgId, taskTitle: task.title });
    if (plan) reversed.push({ userId: original.userId, xp: plan.amount, gold: plan.goldDelta });
  }
  const note = String(req.body?.note ?? "").trim().slice(0, 500);
  const changed = await setFlag(scope, flag._id, ["open", "dismissed"], { status: "confirmed", note, reviewedBy: req.user.id, reviewedAt: new Date() });
  if (!changed && !reversed.length) return res.json({ ok: true, already: true, reversed: [] });
  log(scope, req, "flag_confirmed", `Flag on "${task.title}" (${FLAG_LABEL[flag.kind]}) confirmed: ${reversed.map((r) => `${r.xp} XP`).join(", ") || "no XP to reverse"}.${note ? ` Note: ${note}` : ""}`,
    { targetProjectId: task.projectId ?? null, after: { reversed } });
  res.json({ ok: true, already: false, reversed });
}
