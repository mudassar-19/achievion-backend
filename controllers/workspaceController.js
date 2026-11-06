// Employee daily loop (E-2, Employee UX §4.1-4.3): Today, My tasks, task drawer. Developers, Designers and Testers only
// (routes/workspaceRoutes.js). Reads only; every write goes through the existing /api/tasks routes (S-1 scope).
// The AI score is never sent (D-075): no query here selects aiScore and reviewView builds its own fields.
import Task from "../models/Task.js";
import Project from "../models/Project.js";
import Sprint from "../models/Sprint.js";
import XpLog from "../models/XpLog.js";
import GamificationProfile from "../models/GamificationProfile.js";
import { getLeaderboard } from "./gamificationController.js";
import { commentsView } from "./teamLeadTaskController.js";
import { capture } from "../utils/capture.js";
import { defaultXpValue } from "../services/xpEngine.js";
import { isBlocked } from "../services/taskFormRules.js";
import { OPEN_STATUSES } from "../services/sprintRules.js";
import { taskPeople } from "../services/taskPeople.js";
import User from "../models/User.js";
import OperationalRequest from "../models/OperationalRequest.js";
import { createNotification } from "./notificationController.js";
import { validateSubmission, extensionAsk, limitAsk, employeeAiFeedback, submissionRow } from "../services/submitRules.js";
import { LIMIT_TYPE, limitRequestFields, limitState } from "../services/reviewRules.js";
import { sortRows, nextBestAction, todayTasks, dueTodayCount, xpTrend, rankCard, dailyInsight, reviewView, latestFeedback } from "../services/employeeRules.js";

const ROW_FIELDS = "title type priority status deadline xpValue dependsOn projectId resubmissionCount maxResubmissions revisionHistory reviewedAt tlScore estimatedHours parentId";
const mineFilter = (req) => ({ orgId: req.user.orgId, $or: [{ assignees: req.user.id }, { assignee: req.user.id }] });
const lastRevision = (t) => (t.revisionHistory ?? []).filter((h) => (h.type ?? "revision_requested") === "revision_requested").at(-1);

// My tasks as rows (+ the open sprints they are in). Shared by Today and My tasks.
async function myRows(req) {
  const tasks = await Task.find(mineFilter(req), ROW_FIELDS).sort({ deadline: 1 }).limit(300).lean();
  const ids = tasks.map((t) => t._id);
  const [prereqs, sprints, projects] = await Promise.all([
    Task.find({ _id: { $in: tasks.flatMap((t) => t.dependsOn ?? []) } }, "status").lean(),
    Sprint.find({ tasks: { $in: ids }, status: { $in: OPEN_STATUSES } }, "name status startDate endDate tasks projectId").lean(),
    Project.find({ _id: { $in: [...new Set(tasks.map((t) => String(t.projectId)).filter((x) => x !== "null"))] } }, "title").lean(),
  ]);
  const statusOf = new Map(prereqs.map((p) => [String(p._id), p.status]));
  const sprintOf = new Map(sprints.flatMap((s) => s.tasks.map((t) => [String(t), s])));
  const titleOf = new Map(projects.map((p) => [String(p._id), p.title]));
  const rows = tasks.map((t) => {
    const s = sprintOf.get(String(t._id));
    const rev = lastRevision(t);
    return {
      id: String(t._id), title: t.title, type: t.type, priority: t.priority, status: t.status, deadline: t.deadline,
      xp: t.xpValue ?? defaultXpValue(t.priority), blocked: isBlocked(t, statusOf), project: titleOf.get(String(t.projectId)) ?? null,
      sprint: s ? { id: String(s._id), name: s.name } : null, estimatedHours: t.estimatedHours ?? null, subtask: !!t.parentId,
      revision: t.status === "In-Progress" && !!rev, reviewedAt: t.reviewedAt, tlScore: t.tlScore, revisionHistory: t.revisionHistory ?? [],
    };
  });
  const mine = new Set(ids.map(String));
  const sprintList = sprints.map((s) => {
    const my = rows.filter((r) => r.sprint?.id === String(s._id));
    return { id: String(s._id), name: s.name, status: s.status, startDate: s.startDate, endDate: s.endDate, project: titleOf.get(String(s.projectId)) ?? null,
      mine: my.length, done: my.filter((r) => r.status === "Done").length, total: s.tasks.filter((t) => mine.has(String(t))).length };
  });
  return { rows, sprints: sprintList };
}
const slim = ({ revisionHistory, reviewedAt, tlScore, ...r }) => r; // eslint-disable-line no-unused-vars

// ── GET /api/workspace/tasks ─────────────────────────────────────────────────
export async function listTasks(req, res) {
  const { rows, sprints } = await myRows(req);
  res.json({ rows: sortRows(rows).map(slim), sprints });
}

// Daily insight: one line per person per day (numbers only until E-8).
// ponytail: in-memory, resets on restart; move to AICache when the AI version arrives (E-8).
const insightCache = new Map();
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

// ── GET /api/workspace/today ─────────────────────────────────────────────────
export async function today(req, res) {
  const now = new Date();
  const [{ rows }, profile, logs, board] = await Promise.all([
    myRows(req),
    GamificationProfile.findOne({ userId: req.user.id }, "level currentXp maxXp totalXp hp streaks").lean(),
    XpLog.find({ userId: req.user.id, createdAt: { $gte: new Date(now.getTime() - 31 * 86_400_000) } }, "amount createdAt").lean(),
    capture(getLeaderboard, req, { query: { scope: "team", period: "all" } }),
  ]);
  const level = profile?.level ?? 1, currentXp = profile?.currentXp ?? 0, maxXp = profile?.maxXp ?? 100;
  const hp = profile?.hp ?? 100, streak = profile?.streaks?.daily ?? 0;
  const open = rows.filter((r) => r.status !== "Done");
  const dueToday = dueTodayCount(rows, now);
  const xpToNext = Math.max(0, maxXp - currentXp);
  const key = `${req.user.id}:${dayKey(now)}`;
  if (!insightCache.has(key)) {
    if (insightCache.size > 5000) insightCache.clear();
    insightCache.set(key, { ...dailyInsight({ hp, dueToday, xpToNext, level, streak, openTasks: open.length }), date: dayKey(now) });
  }
  const lb = board.status === 200 ? board.body : null;
  res.json({
    tiles: { dueToday, open: open.length, xpToNext, level, currentXp, maxXp, streak },
    next: nextBestAction(rows) ? slim(nextBestAction(rows)) : null,
    today: todayTasks(rows).map(slim),
    feedback: latestFeedback(rows),
    hp,
    trend: { week: xpTrend(logs, "week", now), month: xpTrend(logs, "month", now) },
    rank: lb?.enough ? rankCard(lb.rows ?? [], req.user.id) : null,
    insight: insightCache.get(key),
  });
}

// ── GET /api/workspace/tasks/:id/full ─── (router.param: employeeTaskScope, 404 outside it)
export async function fullTask(req, res) {
  const me = String(req.user.id);
  const t = await Task.findById(req.params.id, "title description type priority status difficulty deadline startDate estimatedHours xpValue acceptanceCriteria benchmark qaRequired dependsOn parentId projectId assignees assignee attachments timeLogs activity submissionNote submissionLinks submissionFiles submittedAt reviewNote tlScore reviewedAt resubmissionCount maxResubmissions revisionHistory aiEval extensionRequests designHandoffs")
    .populate("assignees", "name").populate("assignee", "name").populate("timeLogs.user", "name").populate("activity.by", "name").populate("attachments.by", "name").lean();
  const people = [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].filter((p, i, a) => p && a.findIndex((x) => String(x._id) === String(p._id)) === i);
  const mine = people.some((p) => String(p._id) === me);
  const [subtasks, prereqs, blocks, parent, sprint, project, xpLogs, comments, limitReqs] = await Promise.all([
    Task.find({ parentId: t._id }, "title status").lean(),
    Task.find({ _id: { $in: t.dependsOn ?? [] } }, "title status").lean(),
    Task.find({ dependsOn: t._id }, "title status").lean(),
    t.parentId ? Task.findById(t.parentId, "title status").lean() : null,
    Sprint.findOne({ tasks: t._id, status: { $in: OPEN_STATUSES } }, "name").lean(),
    t.projectId ? Project.findById(t.projectId, "title").lean() : null,
    mine ? XpLog.find({ userId: req.user.id, taskId: t._id }, "amount source breakdown createdAt").sort({ createdAt: 1 }).lean() : [],
    commentsView(t, me),
    mine ? OperationalRequest.find({ taskId: t._id, type: LIMIT_TYPE }, "status attempts managerNote createdAt resolvedAt").sort({ createdAt: 1 }).lean() : [],
  ]);
  const view = (x) => ({ id: String(x._id), title: x.title, status: x.status });
  const statusOf = new Map(prereqs.map((p) => [String(p._id), p.status]));
  const blocked = isBlocked(t, statusOf);
  const review = mine ? reviewView(t, xpLogs) : null;
  const minutes = (t.timeLogs ?? []).reduce((s, l) => s + (l.minutes ?? 0), 0);
  const action = !mine ? null : t.status === "To-Do" ? (blocked ? "blocked" : "start") : t.status === "In-Progress" ? (review.lastRevision ? "resubmit" : "submit") : t.status === "In-Review" ? "view" : null;
  res.json({
    id: String(t._id), title: t.title, description: t.description ?? "", type: t.type, priority: t.priority, status: t.status, difficulty: t.difficulty,
    deadline: t.deadline, startDate: t.startDate, estimatedHours: t.estimatedHours ?? null, xp: t.xpValue ?? defaultXpValue(t.priority),
    acceptanceCriteria: t.acceptanceCriteria ?? [], benchmark: t.benchmark ?? "", qaRequired: !!t.qaRequired,
    project: project ? { id: String(project._id), title: project.title } : null, sprint: sprint ? { id: String(sprint._id), name: sprint.name } : null,
    assignees: people.map((p) => ({ id: String(p._id), name: p.name })), mine, action, blocked,
    parent: parent ? view(parent) : null, subtasks: subtasks.map(view), dependsOn: prereqs.map(view), blocks: blocks.map(view),
    attachments: (t.attachments ?? []).map((a) => ({ id: String(a._id), name: a.name, url: a.url, by: a.by?.name ?? null, at: a.at })),
    time: { minutes, mine: (t.timeLogs ?? []).filter((l) => String(l.user?._id) === me).reduce((s, l) => s + (l.minutes ?? 0), 0),
      logs: (t.timeLogs ?? []).slice(-30).reverse().map((l) => ({ who: l.user?.name ?? "Someone", minutes: l.minutes, note: l.note ?? "", at: l.loggedAt })) },
    history: (t.activity ?? []).slice(-50).reverse().map((a) => ({ kind: a.kind, who: a.by?.name ?? "Someone", at: a.at, from: a.from, to: a.to, note: a.note ?? "" })),
    submission: mine ? { note: t.submissionNote ?? "", at: t.submittedAt ?? null, links: (t.submissionLinks ?? []).map((l) => ({ label: l.label, url: l.url })), files: (t.submissionFiles ?? []).map((f) => ({ name: f.filename, url: f.url ?? null })) } : null,
    review, triesLeft: Math.max(0, (t.maxResubmissions ?? 3) - (t.resubmissionCount ?? 0)),
    // E-3: AI feedback text only after the TL scored (Q6), never a score; own extension requests; one more try state.
    aiFeedback: mine ? employeeAiFeedback(t) : null,
    // E-3b (D-185): what approved designs handed to this task; anyone who may read the task sees it (files still go through /api/files/sign).
    fromDesign: (t.designHandoffs ?? []).map((h) => ({ fromTask: String(h.fromTask), fromTitle: h.fromTitle, by: h.by, note: h.note, links: h.links ?? [], files: h.files ?? [], at: h.at })),
    extensions: mine ? (t.extensionRequests ?? []).filter((e) => String(e.requestedBy) === me).map((e) => ({ status: e.status, requestedDeadline: e.requestedDeadline, reason: e.reason, note: e.approvalNote ?? "", at: e.createdAt })) : [],
    canAskExtension: mine && extensionAsk({ task: t, newDeadline: new Date(Math.max(Date.now(), new Date(t.deadline ?? 0).getTime()) + 86_400_000), reason: "placeholder reason" }).ok === true,
    moreTries: mine ? { state: limitState(limitReqs.at(-1)), note: limitReqs.at(-1)?.managerNote ?? "", canAsk: limitAsk({ task: t, requests: limitReqs, reason: "placeholder reason" }).ok === true } : null,
    ...comments,
  });
}


// ── E-3: submit, my submissions, extension, one more try (D-178..D-181) ─────────────────────────────────────────
const parseList = (v) => { try { const x = JSON.parse(v ?? "[]"); return Array.isArray(x) ? x : null; } catch { return null; } };
const isMine = (t, uid) => (t.assignees ?? []).some((a) => String(a) === uid) || String(t.assignee ?? "") === uid;


// POST /api/workspace/tasks/:id/submit (multipart, after upload): the role form becomes note / links / content / checklist,
// then taskController.submitTask does the rest (assignee and limit checks, status, lateness, review notice, AI evaluation).
export async function prepareSubmit(req, res, next) {
  const t = await Task.findById(req.params.id, "acceptanceCriteria type qaRequired assignee assignees").lean();
  // Same answer as submitTask for a project member who is not the assignee, before any form check.
  if (!isMine(t, String(req.user.id))) return res.status(403).json({ error: "Only the assignee can submit this task" });
  const criteria = parseList(req.body?.criteria), design = parseList(req.body?.design);
  if (!criteria || !design) return res.status(400).json({ error: "The checklist could not be read.", field: "criteria" });
  const fields = { ...Object.fromEntries(["link", "branch", "summary", "tests", "version", "rationale", "handoff"].map((k) => [k, req.body?.[k]])), criteria, design };
  const v = validateSubmission({ kind: req.user.roleCategory, task: t, fields, files: (req.files ?? []).map((f) => ({ name: f.originalname, size: f.size })) });
  if (v.error) return res.status(400).json({ error: v.error, field: v.field });
  req.body = { note: v.note, links: JSON.stringify(v.links), content: v.content, checklist: JSON.stringify(v.checklist), handoff: req.user.roleCategory === "designer" ? String(fields.handoff ?? "").trim() : "" };
  next();
}

// GET /api/workspace/submissions
export async function listSubmissions(req, res) {
  const tasks = await Task.find({ orgId: req.user.orgId, $and: [{ $or: mineFilter(req).$or }, { $or: [{ submittedAt: { $ne: null } }, { firstSubmittedAt: { $ne: null } }] }] },
    "title status submittedAt firstSubmittedAt resubmissionCount tlScore reviewNote reviewedAt revisionHistory projectId").sort({ submittedAt: -1 }).limit(300).lean();
  const projects = new Map((await Project.find({ _id: { $in: tasks.map((t) => t.projectId).filter(Boolean) } }, "title").lean()).map((p) => [String(p._id), p.title]));
  const rows = tasks.map((t) => { const r = submissionRow(t); return r && { ...r, project: projects.get(String(t.projectId)) ?? null }; }).filter(Boolean);
  const count = (tab) => rows.filter((r) => r.tab === tab).length;
  res.json({ rows, counts: { waiting: count("waiting"), revision: count("revision"), approved: count("approved") } });
}

// POST /api/workspace/tasks/:id/extension { newDeadline, reason }: stored on the task (extensionRequests), sent to the task's
// Team Lead; the Manager gets an FYI (Q4, D-027). Also answers the older POST /api/tasks/:id/extension-request.
export async function askExtension(req, res) {
  const t = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId }, "title status deadline assignee assignees extensionRequests projectId milestoneId").lean();
  if (!t) return res.status(404).json({ error: "Task not found." });
  if (!isMine(t, String(req.user.id))) return res.status(403).json({ error: "Only the assignee can ask for more time." });
  const v = extensionAsk({ task: t, newDeadline: req.body?.newDeadline, reason: req.body?.reason });
  if (!v.ok) return res.status(v.status ?? 400).json({ error: v.error, field: v.field });
  const entry = { requestedBy: req.user.id, reason: v.reason, requestedDeadline: v.newDeadline, status: "PENDING", createdAt: new Date() };
  // Atomic: two quick clicks give one request.
  const saved = await Task.updateOne({ _id: t._id, "extensionRequests.status": { $ne: "PENDING" } }, { $push: { extensionRequests: entry } });
  if (!saved.modifiedCount) return res.status(409).json({ error: "You already asked for more time on this task. Wait for the answer." });
  Task.logActivity(t._id, req.user.id, "extension", { note: `Asked until ${v.newDeadline.toISOString().slice(0, 10)}` });
  const { leads, managerId } = await taskPeople(t);
  const when = v.newDeadline.toISOString().slice(0, 10), who = req.user.name ?? "Someone";
  await Promise.all([
    ...leads.map((uid) => createNotification({ userId: uid, orgId: req.user.orgId, type: "extension_requested", title: "More time requested", message: `${who} asks to move "${t.title}" to ${when}: ${v.reason.slice(0, 200)}`, meta: { taskId: t._id, projectId: t.projectId } }).catch(() => {})),
    managerId ? createNotification({ userId: managerId, orgId: req.user.orgId, type: "extension_requested_fyi", title: "Extension asked (for your information)", message: `${who} asked the Team Lead to move "${t.title}" to ${when}.`, meta: { taskId: t._id, projectId: t.projectId } }).catch(() => {}) : null,
  ]);
  res.status(201).json({ ok: true, status: "PENDING", requestedDeadline: v.newDeadline, sentTo: leads.length });
}

// POST /api/workspace/tasks/:id/more-tries { reason }: one open "Resubmission limit reached" request; the Team Lead (or the
// Manager, D-142) decides. Notifies the task's Team Lead and the Manager.
export async function askMoreTries(req, res) {
  const t = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId }, "title status assignee assignees resubmissionCount maxResubmissions projectId milestoneId").lean();
  if (!t) return res.status(404).json({ error: "Task not found." });
  if (!isMine(t, String(req.user.id))) return res.status(403).json({ error: "Only the assignee can ask for another try." });
  const requests = await OperationalRequest.find({ taskId: t._id, type: LIMIT_TYPE }, "status attempts").lean();
  const v = limitAsk({ task: t, requests, reason: req.body?.reason });
  if (!v.ok) return res.status(v.status ?? 400).json({ error: v.error, field: v.field });
  const { leads, managerId } = await taskPeople(t);
  const tl = leads[0] ? await User.findById(leads[0], "name").lean() : null;
  const base = limitRequestFields({ taskTitle: t.title, assigneeName: req.user.name, tlName: tl?.name, attempts: t.resubmissionCount, max: t.maxResubmissions ?? 3 });
  // ponytail: two requests in the same millisecond could both pass; the composer disables the button. Unique index if it ever matters.
  const request = await OperationalRequest.create({ ...base, message: `${base.message} The assignee asks: ${v.reason}`.slice(0, 2000), orgId: req.user.orgId, status: "Pending",
    requesterId: req.user.id, projectId: t.projectId ?? null, milestoneId: t.milestoneId ?? null, taskId: t._id, attempts: t.resubmissionCount });
  Task.logActivity(t._id, req.user.id, "edited", { note: "Asked for one more try" });
  await Promise.all([...new Set([...leads, managerId].filter(Boolean))].map((uid) => createNotification({ userId: uid, orgId: req.user.orgId, type: "more_tries_requested", title: "One more try requested",
    message: `${req.user.name ?? "Someone"} reached the limit on "${t.title}" and asks for one more try: ${v.reason.slice(0, 200)}`, meta: { taskId: t._id, projectId: t.projectId, requestId: request._id } }).catch(() => {})));
  res.status(201).json({ ok: true, state: "waiting" });
}

