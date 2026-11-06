// Team Lead portal T-1 (V2 Phase 4, UX TL §2-3, D-113..D-116): home, modules, task list + detail, team workload
// + reassign, sprints (read-only). Scope on every route: Team Lead role (router), the caller's org, and the
// projects the TL is a member of; "team" = non-leader members of those projects (teamLeadRules.teamOf).
// Reassign / member / task detail / sprint reads reuse the Manager handlers after the TL scope check, so the
// rules (D-095 assignee-only reassign, D-075 score reveal) and numbers are the same.
import mongoose from "mongoose";
import Project from "../models/Project.js";
import User from "../models/User.js";
import Milestone from "../models/Milestone.js";
import Task from "../models/Task.js";
import Sprint from "../models/Sprint.js";
import AuditLog from "../models/AuditLog.js";
import { orgScope, getTaskDetail as mgrTaskDetail } from "./managerProjectsController.js";
import { workloadView, getMember, getCandidates, reassignTask } from "./managerResourcesController.js";
import { getSprintDetail, getSprintSummary, createSprint as mgrCreateSprint, updateSprint as mgrUpdateSprint, deleteSprint as mgrDeleteSprint, addTaskToSprint, removeTaskFromSprint, getSprintBacklog, startSprint as mgrStartSprint, closeSprint as mgrCloseSprint } from "./sprintController.js";
import { getProjectSprints } from "./managerProjectsController.js";
import { tlSprintBlock } from "../services/sprintRules.js";
import OperationalRequest from "../models/OperationalRequest.js";
import { LIMIT_TYPE } from "../services/reviewRules.js";
import { getAlerts, getActivity } from "./teamLeadController.js";
import { createNotification } from "./notificationController.js";
import { healthForProjects } from "../services/projectHealthService.js";
import { capture, passOn } from "../utils/capture.js";
import { teamOf, parseTaskQuery, moduleState, TASK_PAGE, QUESTION_MAX } from "../services/teamLeadRules.js";
import { canDeleteTask, isBlocked } from "../services/taskFormRules.js";

const valid = (id) => mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(String(id));
const CLOSED = ["Archived", "Deleted"];
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The TL's projects (member), their team and the org scope. Answers 404 itself when the org is missing.
export async function tlScope(req, res, { open = false } = {}) {
  const scope = await orgScope(req.user.orgId);
  if (!scope) { res.status(404).json({ error: "Organization not found." }); return null; }
  const projects = await Project.find({ ...scope.filter, members: req.user.id, isDeleted: { $ne: true }, status: { $nin: open ? [...CLOSED, "Completed"] : ["Deleted"] } },
    "title description status deadline startDate createdAt managerId members").populate("members", "name role").populate("managerId", "name").lean();
  const ids = new Set(projects.map((p) => String(p._id)));
  return { scope, projects, ids, team: teamOf(projects, req.user.id) };
}
export const projectIn = (s, id) => s.projects.find((p) => String(p._id) === String(id)) ?? null;
// Task inside the TL's projects, else 404 (also for another org's task).
export async function taskIn(s, id, res) {
  const task = valid(id) ? await Task.findOne({ _id: id, ...s.scope.filter, projectId: { $in: [...s.ids].map((x) => new mongoose.Types.ObjectId(x)) } }, "_id").lean() : null;
  if (!task) res.status(404).json({ error: "Task not found in your projects." });
  return task;
}

// Open tasks of these projects that wait for an unfinished prerequisite (T-2, D-124).
export async function blockedTaskIds(scope, pids) {
  const waiting = await Task.find({ ...scope.filter, projectId: { $in: pids }, status: { $ne: "Done" }, "dependsOn.0": { $exists: true } }, "dependsOn").lean();
  if (!waiting.length) return [];
  const pre = await Task.find({ _id: { $in: [...new Set(waiting.flatMap((t) => t.dependsOn.map(String)))] } }, "status").lean();
  const statusOf = new Map(pre.map((p) => [String(p._id), p.status]));
  return waiting.filter((t) => isBlocked(t, statusOf)).map((t) => t._id);
}

// ── GET /api/teamlead/home  (Dashboard) ─────────────────────────────────────
export async function getHome(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const pids = [...s.ids].map((x) => new mongoose.Types.ObjectId(x));
  const now = new Date();
  const [stats, overdue, unassigned, modules, wl, alerts, activity] = await Promise.all([
    Task.aggregate([{ $match: { ...s.scope.filter, projectId: { $in: pids }, isDeleted: { $ne: true } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    Task.countDocuments({ ...s.scope.filter, projectId: { $in: pids }, status: { $ne: "Done" }, deadline: { $lt: now, $ne: null } }),
    Task.countDocuments({ ...s.scope.filter, projectId: { $in: pids }, status: { $ne: "Done" }, assignee: null, $or: [{ assignees: { $size: 0 } }, { assignees: { $exists: false } }] }),
    moduleRows(req, s),
    s.team.size ? workloadView(s.scope, req.user.id, { userIds: [...s.team.keys()], projectIds: pids }) : { members: [] },
    capture(getAlerts, req),
    capture(getActivity, req, { query: { limit: "8" } }),
  ]);
  const blocked = await blockedTaskIds(s.scope, pids);
  const by = Object.fromEntries(stats.map((r) => [r._id, r.n]));
  const total = Object.values(by).reduce((a, n) => a + n, 0);
  const alertList = alerts.status === 200 ? [...(alerts.body.alerts ?? [])] : [];
  if (blocked.length) alertList.push({ type: "blocked_dependency", severity: "Medium", message: `${blocked.length} ${blocked.length === 1 ? "task is" : "tasks are"} blocked by an unfinished prerequisite.`, to: "/teamlead/tasks?blocked=1" });
  res.json({
    isNew: s.projects.length === 0,
    tasks: { total, inProgress: by["In-Progress"] ?? 0, inReview: by["In-Review"] ?? 0, overdue, done: by.Done ?? 0 },
    reviewQueue: by["In-Review"] ?? 0,
    overloaded: wl.members.filter((m) => m.status === "Overloaded").length,
    unassigned,
    newModules: modules.filter((m) => m.state === "New").length,
    alerts: { count: alertList.length, critical: alertList.filter((a) => a.severity === "Critical").length, top: alertList.slice(0, 5).map((a) => ({ type: a.type, severity: a.severity, message: a.message, to: a.to ?? null })) },
    blocked: blocked.length,
    activeModules: modules.filter((m) => m.state !== "Completed").slice(0, 6),
    activity: activity.status === 200 ? (activity.body.events ?? []).slice(0, 8).map((e) => ({ id: e.id, type: e.type, who: e.actor?.name ?? null, subject: e.subject, at: e.timestamp })) : [],
  });
}

// ── Modules: modules the TL leads + projects where they are on the team ────
async function moduleRows(req, s) {
  const [mods, health] = await Promise.all([
    Milestone.find({ teamLeadId: req.user.id, projectId: { $in: [...s.ids].map((x) => new mongoose.Types.ObjectId(x)) } }, "title projectId dueDate status progress tlAcceptedAt").lean(),
    healthForProjects(s.projects.filter((p) => !CLOSED.includes(p.status))),
  ]);
  const withModule = new Set(mods.map((m) => String(m.projectId)));
  const rows = mods.map((m) => {
    const p = projectIn(s, m.projectId);
    return { key: `m-${m._id}`, kind: "module", id: m._id, projectId: m.projectId, title: m.title, project: p?.title ?? "—", deadline: m.dueDate ?? p?.deadline ?? null,
      progress: m.progress ?? 0, acceptedAt: m.tlAcceptedAt ?? null, manager: p?.managerId?.name ?? null, state: moduleState({ kind: "module", acceptedAt: m.tlAcceptedAt, status: m.status, progress: m.progress }) };
  });
  for (const p of s.projects) {
    if (withModule.has(String(p._id)) || CLOSED.includes(p.status)) continue;
    const h = health.get(String(p._id));
    rows.push({ key: `p-${p._id}`, kind: "project", id: p._id, projectId: p._id, title: p.title, project: p.title, deadline: p.deadline ?? null,
      progress: h?.progressPct ?? 0, acceptedAt: null, manager: p.managerId?.name ?? null, state: moduleState({ kind: "project", status: p.status, progress: h?.progressPct }) });
  }
  return rows.sort((a, b) => (a.state === "New" ? -1 : 0) - (b.state === "New" ? -1 : 0) || (a.deadline ? +new Date(a.deadline) : Infinity) - (b.deadline ? +new Date(b.deadline) : Infinity));
}
export async function listModules(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  res.json({ modules: await moduleRows(req, s) });
}

// ── GET /api/teamlead/modules/:projectId?module=<moduleId> ──────────────────
export async function getModule(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const p = valid(req.params.projectId) ? projectIn(s, req.params.projectId) : null;
  if (!p) return res.status(404).json({ error: "Module not found in your projects." });
  let mod = null;
  if (req.query.module) {
    mod = valid(req.query.module) ? await Milestone.findOne({ _id: req.query.module, projectId: p._id, teamLeadId: req.user.id }).lean() : null;
    if (!mod) return res.status(404).json({ error: "Module not found in your projects." });
  }
  const [tasks, health, wl] = await Promise.all([
    Task.find({ ...s.scope.filter, projectId: p._id, ...(mod && (await Task.exists({ milestoneId: mod._id })) ? { milestoneId: mod._id } : {}) }, "title status priority deadline startDate createdAt estimatedHours assignee assignees isLate dependsOn")
      .populate("assignee", "name").populate("assignees", "name").sort({ deadline: 1 }).limit(100).lean(),
    healthForProjects([p]),
    workloadView(s.scope, req.user.id, { userIds: (p.members ?? []).filter((m) => !["Director", "Manager", "Team Lead"].includes(m.role)).map((m) => m._id), projectIds: [p._id] }),
  ]);
  const by = tasks.reduce((a, t) => ({ ...a, [t.status]: (a[t.status] ?? 0) + 1 }), {});
  const done = by.Done ?? 0;
  res.json({
    kind: mod ? "module" : "project", projectId: p._id, moduleId: mod?._id ?? null,
    title: mod?.title ?? p.title, project: { id: p._id, title: p.title, status: p.status },
    brief: (mod?.description || p.description || "").trim(), deadline: mod?.dueDate ?? p.deadline ?? null,
    manager: p.managerId ? { id: p.managerId._id, name: p.managerId.name } : null,
    acceptedAt: mod?.tlAcceptedAt ?? null, qaReadyAt: mod?.qaReadyAt ?? null, startDate: mod?.startDate ?? p.startDate ?? null, state: moduleState({ kind: mod ? "module" : "project", acceptedAt: mod?.tlAcceptedAt, status: p.status, progress: mod?.progress }),
    progress: { done, total: tasks.length, pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0, byStatus: by, health: health.get(String(p._id)) ?? null },
    tasks: tasks.map((t) => ({ id: t._id, title: t.title, status: t.status, priority: t.priority, deadline: t.deadline, isLate: !!t.isLate,
      startDate: t.startDate ?? t.createdAt ?? null, estimatedHours: t.estimatedHours ?? null, hasDependencies: (t.dependsOn ?? []).length > 0,
      assignees: [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].filter((x, i, a) => x && a.findIndex((y) => String(y._id) === String(x._id)) === i).map((x) => x.name) })),
    team: wl.members.map((m) => ({ id: m.id, name: m.name, role: m.role, activeTasks: m.activeTasks, label: m.label, tone: m.tone, status: m.status })),
  });
}

// ── POST /api/teamlead/modules/:moduleId/accept ─────────────────────────────
export async function acceptModule(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const mod = valid(req.params.moduleId) ? await Milestone.findOne({ _id: req.params.moduleId, teamLeadId: req.user.id }, "title projectId tlAcceptedAt").lean() : null;
  const p = mod && projectIn(s, mod.projectId);
  if (!mod || !p) return res.status(404).json({ error: "Module not found in your projects." });
  const r = await Milestone.updateOne({ _id: mod._id, teamLeadId: req.user.id, tlAcceptedAt: null }, { $set: { tlAcceptedAt: new Date() } });
  if (!r.modifiedCount) return res.status(409).json({ error: "You already accepted this module." });
  AuditLog.create({ action: "module_accepted", orgId: s.scope.org._id, performedBy: req.user.id, targetProjectId: p._id, projectTitle: p.title, detail: `${req.user.name ?? "The Team Lead"} accepted module "${mod.title}".`, scope: "project" })
    .catch((e) => console.error("[audit]", e.message));
  if (p.managerId) createNotification({ userId: p.managerId._id, orgId: req.user.orgId, type: "module_accepted", title: "Module accepted",
    message: `${req.user.name ?? "The Team Lead"} accepted "${mod.title}" in "${p.title}".`, meta: { projectId: p._id, milestoneId: mod._id } }).catch(() => {});
  res.json({ ok: true, acceptedAt: new Date() });
}

// ── POST /api/teamlead/modules/:projectId/question { text, moduleId? } ──────
export async function askQuestion(req, res) {
  const text = String(req.body?.text ?? "").trim();
  if (text.length < 5 || text.length > QUESTION_MAX) return res.status(400).json({ error: `Write a question of 5 to ${QUESTION_MAX} characters.`, fields: { text: `5 to ${QUESTION_MAX} characters.` } });
  const s = await tlScope(req, res); if (!s) return;
  const p = valid(req.params.projectId) ? projectIn(s, req.params.projectId) : null;
  if (!p) return res.status(404).json({ error: "Module not found in your projects." });
  const mod = req.body?.moduleId ? (valid(req.body.moduleId) ? await Milestone.findOne({ _id: req.body.moduleId, projectId: p._id }, "title").lean() : null) : null;
  if (req.body?.moduleId && !mod) return res.status(404).json({ error: "Module not found in your projects." });
  if (!p.managerId) return res.status(409).json({ error: "This project has no Manager yet, so there is nobody to ask." });
  await createNotification({ userId: p.managerId._id, orgId: req.user.orgId, type: "module_question", tier: "needs_action", title: `Question from ${req.user.name ?? "your Team Lead"}`,
    message: `${mod ? `"${mod.title}" in ` : ""}"${p.title}": ${text}`, meta: { projectId: p._id, milestoneId: mod?._id ?? null, from: req.user.id } });
  res.json({ ok: true, to: p.managerId.name });
}

// ── GET /api/teamlead/tasks/list?tab&status&assignee&module&overdue&q&page ──
export async function listTasks(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const q = parseTaskQuery(req.query);
  if (q.module && !s.ids.has(q.module)) return res.status(404).json({ error: "Module not found in your projects." });
  const pids = (q.module ? [q.module] : [...s.ids]).map((x) => new mongoose.Types.ObjectId(x));
  const f = { ...s.scope.filter, projectId: { $in: pids }, isDeleted: { $ne: true } };
  if (q.tab === "created") f.createdBy = new mongoose.Types.ObjectId(req.user.id);
  if (q.tab === "review") f.status = "In-Review";
  if (q.tab === "done") f.status = "Done";
  if (q.status && q.tab === "all") f.status = q.status;
  if (q.assignee === "none") Object.assign(f, { assignee: null, $or: [{ assignees: { $size: 0 } }, { assignees: { $exists: false } }] });
  else if (q.assignee) f.$and = [{ $or: [{ assignee: q.assignee }, { assignees: q.assignee }] }];
  // Overdue = past the deadline and not Done (so "Completed" + overdue is always empty).
  if (q.overdue) Object.assign(f, { deadline: { $lt: new Date(), $ne: null }, status: f.status === "Done" ? "__none__" : { $ne: "Done" } });
  if (q.search) f.title = { $regex: escapeRx(q.search), $options: "i" };
  // T-2: tag, blocked by a dependency, in a sprint of the TL's projects
  const tag = String(req.query.tag ?? "").trim().toLowerCase().slice(0, 24);
  if (tag) f.tags = tag;
  if (req.query.blocked === "1") f._id = { $in: await blockedTaskIds(s.scope, pids) };
  if (req.query.sprint) {
    const sp = valid(req.query.sprint) ? await Sprint.findOne({ _id: req.query.sprint, ...s.scope.filter }, "projectId tasks").lean() : null;
    if (!sp || !s.ids.has(String(sp.projectId))) return res.status(404).json({ error: "Sprint not found in your projects." });
    f._id = f._id ? { $in: f._id.$in.filter((x) => sp.tasks.some((y) => String(y) === String(x))) } : { $in: sp.tasks };
  }
  const [total, items] = await Promise.all([
    Task.countDocuments(f),
    Task.find(f, "title status priority type deadline isLate projectId assignee assignees createdBy tags dependsOn groupTag").populate("assignee", "name").populate("assignees", "name").populate("createdBy", "name")
      .sort({ deadline: 1, createdAt: -1 }).skip((q.page - 1) * TASK_PAGE).limit(TASK_PAGE).lean(),
  ]);
  const titleOf = Object.fromEntries(s.projects.map((p) => [String(p._id), p.title]));
  // T-5 (D-142): tasks waiting for the Manager at the resubmission limit.
  const waiting = new Set((await OperationalRequest.find({ taskId: { $in: items.map((t) => t._id) }, type: LIMIT_TYPE, status: { $in: ["Pending", "In Progress"] } }, "taskId").lean()).map((r) => String(r.taskId)));
  res.json({
    total, page: q.page, pageSize: TASK_PAGE,
    items: items.map((t) => ({ waitingManager: waiting.has(String(t._id)), id: t._id, title: t.title, status: t.status, priority: t.priority, type: t.type, deadline: t.deadline, isLate: !!t.isLate,
      project: { id: t.projectId, title: titleOf[String(t.projectId)] ?? "—" }, createdBy: t.createdBy?.name ?? null,
      tags: t.tags ?? [], hasDependencies: (t.dependsOn ?? []).length > 0, groupTag: t.groupTag ?? null,
      assignees: [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].filter((x, i, a) => x && a.findIndex((y) => String(y._id) === String(x._id)) === i).map((x) => ({ id: x._id, name: x.name })) })),
    options: {
      modules: s.projects.filter((p) => !CLOSED.includes(p.status)).map((p) => ({ id: p._id, title: p.title })).sort((a, b) => a.title.localeCompare(b.title)),
      sprints: (await Sprint.find({ ...s.scope.filter, projectId: { $in: pids }, status: { $ne: "Completed" } }, "name status projectId").sort({ startDate: -1 }).limit(50).lean())
        .map((x) => ({ id: x._id, name: x.name, status: x.status, project: titleOf[String(x.projectId)] ?? "—" })),
      assignees: [...s.team.keys()].map((id) => ({ id, name: s.projects.flatMap((p) => p.members ?? []).find((m) => String(m._id) === id)?.name ?? "—" })).sort((a, b) => a.name.localeCompare(b.name)),
    },
  });
}

// ── GET /api/teamlead/tasks/:id/detail (read-only drawer) ───────────────────
export async function taskDetail(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  if (!(await taskIn(s, req.params.id, res))) return;
  passOn(res, await capture(mgrTaskDetail, req, { params: { id: req.params.id } }));
}

// ── Team (workload) + member drawer + reassign (Manager handlers, TL scope) ─
export async function getTeam(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  if (!s.team.size) return res.json({ threshold: { pct: 100 }, workTime: null, projects: [], members: [] });
  const { threshold, workTime, projects, members } = await workloadView(s.scope, req.user.id, { userIds: [...s.team.keys()], projectIds: [...s.ids].map((x) => new mongoose.Types.ObjectId(x)) });
  res.json({ threshold, workTime, projects, members });
}
export async function getTeamMember(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  if (!s.team.has(String(req.params.userId))) return res.status(404).json({ error: "Person not found in your team." });
  const r = await capture(getMember, req, { params: { userId: req.params.userId } });
  if (r.status !== 200) return passOn(res, r);
  // The person's load counts every task; the TL may reassign only tasks of their own projects.
  res.json({ ...r.body, tasks: r.body.tasks.map((t) => (t.project && s.ids.has(String(t.project.id)) ? t : { ...t, reassignable: false, note: "Not your project" })) });
}
export async function taskCandidates(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  if (!(await taskIn(s, req.params.id, res))) return;
  return getCandidates(req, res);
}
export async function taskReassign(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  if (!(await taskIn(s, req.params.id, res))) return;
  return reassignTask(req, res);
}

// ── Sprint reads (D-116; writes below, D-143) ──────────────────────────────────────────────
const LABEL = { Planning: "Planned", Active: "Active", Completed: "Closed" };
export async function listSprints(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const sprints = await Sprint.find({ ...s.scope.filter, projectId: { $in: [...s.ids].map((x) => new mongoose.Types.ObjectId(x)) } }, "name status startDate endDate projectId tasks")
    .populate("tasks", "status").sort({ startDate: -1 }).limit(200).lean();
  const titleOf = Object.fromEntries(s.projects.map((p) => [String(p._id), p.title]));
  const order = { Active: 0, Planning: 1, Completed: 2 };
  res.json({ projects: s.projects.filter((p) => !["Archived", "Completed", "Deleted"].includes(p.status)).map((p) => ({ id: p._id, title: p.title })), sprints: sprints.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3)).map((x) => {
    const t = (x.tasks ?? []).filter(Boolean);
    return { id: x._id, name: x.name, status: LABEL[x.status] ?? x.status, startDate: x.startDate, endDate: x.endDate, project: { id: x.projectId, title: titleOf[String(x.projectId)] ?? "—" },
      total: t.length, done: t.filter((y) => y.status === "Done").length };
  }) });
}
async function sprintIn(req, res) {
  const s = await tlScope(req, res); if (!s) return false;
  const sp = valid(req.params.id) ? await Sprint.findOne({ _id: req.params.id, ...s.scope.filter }, "projectId").lean() : null;
  if (!sp || !s.ids.has(String(sp.projectId))) { res.status(404).json({ error: "Sprint not found in your projects." }); return false; }
  return true;
}
export async function sprintDetail(req, res) {
  if (!(await sprintIn(req, res))) return;
  const r = await capture(getSprintDetail, req, { params: { id: req.params.id } });
  if (r.status !== 200) return passOn(res, r);
  const sp = await Sprint.findById(req.params.id, "createdBy").lean();
  const creator = sp?.createdBy ? await User.findById(sp.createdBy, "role").lean() : null;
  res.json({ ...r.body, canWrite: !tlSprintBlock({ createdBy: sp?.createdBy, creatorRole: creator?.role, userId: req.user.id }) });
}
export async function sprintSummary(req, res) {
  if (!(await sprintIn(req, res))) return;
  passOn(res, await capture(getSprintSummary, req, { params: { id: req.params.id } }));
}

// ── Sprint writes (T-5, D-143, D-121): the Manager's M-3 handlers (D-089..D-092) behind the TL scope. ─────
// 404 for a sprint outside the TL's projects or made by another Team Lead. Done is never set here.
async function writableSprint(req, res, id = req.params.id) {
  const s = await tlScope(req, res); if (!s) return null;
  const sp = valid(id) ? await Sprint.findOne({ _id: id, ...s.scope.filter }, "projectId createdBy status tasks name").lean() : null;
  const creator = sp?.createdBy ? await User.findById(sp.createdBy, "role").lean() : null;
  if (!sp || !s.ids.has(String(sp.projectId)) || tlSprintBlock({ createdBy: sp.createdBy, creatorRole: creator?.role, userId: req.user.id })) {
    res.status(404).json({ error: "Sprint not found in your projects." }); return null;
  }
  return { s, sprint: sp };
}
export { writableSprint };
// A task of another Team Lead's module is not the TL's to plan.
const notMineModule = async (task, me) => {
  if (!task?.milestoneId) return false;
  const m = await Milestone.findById(task.milestoneId, "teamLeadId").lean();
  return !!m?.teamLeadId && String(m.teamLeadId) !== String(me);
};
export async function tlCreateSprint(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const id = req.body?.projectId;
  if (id !== undefined && id !== "" && (!valid(id) || !s.ids.has(String(id)))) return res.status(404).json({ error: "Project not found in your projects." });
  passOn(res, await capture(mgrCreateSprint, req, { body: req.body }));
}
export async function tlUpdateSprint(req, res) {
  if (await writableSprint(req, res)) passOn(res, await capture(mgrUpdateSprint, req, { params: req.params, body: req.body }));
}
export async function tlDeleteSprint(req, res) {
  if (await writableSprint(req, res)) passOn(res, await capture(mgrDeleteSprint, req, { params: req.params }));
}
export async function tlSprintBacklog(req, res) {
  const w = await writableSprint(req, res); if (!w) return;
  const r = await capture(getSprintBacklog, req, { params: req.params });
  if (r.status !== 200) return passOn(res, r);
  const mods = await Milestone.find({ projectId: w.sprint.projectId, teamLeadId: { $nin: [null, req.user.id] } }, "_id").lean();
  const foreign = mods.length ? new Set((await Task.find({ milestoneId: { $in: mods.map((m) => m._id) } }, "_id").lean()).map((t) => String(t._id))) : new Set();
  res.json({ tasks: r.body.tasks.filter((t) => !foreign.has(String(t.id))) });
}
export async function tlAddSprintTask(req, res) {
  const w = await writableSprint(req, res); if (!w) return;
  const task = valid(req.body?.taskId) ? await Task.findById(req.body.taskId, "milestoneId").lean() : null;
  if (await notMineModule(task, req.user.id)) return res.status(404).json({ error: "That task is not in this sprint's project." });
  passOn(res, await capture(addTaskToSprint, req, { params: req.params, body: req.body }));
}
export async function tlRemoveSprintTask(req, res) {
  if (await writableSprint(req, res)) passOn(res, await capture(removeTaskFromSprint, req, { params: req.params }));
}
export async function tlStartSprint(req, res) {
  if (await writableSprint(req, res)) passOn(res, await capture(mgrStartSprint, req, { params: req.params }));
}
export async function tlCloseSprint(req, res) {
  if (await writableSprint(req, res)) passOn(res, await capture(mgrCloseSprint, req, { params: req.params, body: req.body }));
}
export async function tlProjectSprints(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  if (!valid(req.params.id) || !s.ids.has(String(req.params.id))) return res.status(404).json({ error: "Project not found in your projects." });
  passOn(res, await capture(getProjectSprints, req, { params: req.params }));
}

// ── Scope guards for the older TL routes (T-1 audit, D-117) ─────────────────
// Before T-1 these routes checked only the org: a TL could read, review, comment on, move or delete any task of
// the org, list another project's tasks and read anyone's capacity. Now: task / project in the TL's projects,
// person in the TL's team, else 404.
export async function ownTask(req, res, next) {
  const s = await tlScope(req, res); if (!s) return;
  if (await taskIn(s, req.params.id, res)) next();
}
export async function ownProject(req, res, next) {
  const s = await tlScope(req, res); if (!s) return;
  const id = req.params.id ?? req.body?.projectId;
  if (req.params.id === undefined && !id) return next(); // task create without a project: createTask decides
  if (!valid(id) || !s.ids.has(String(id))) return res.status(404).json({ error: "Project not found in your projects." });
  next();
}
export async function ownTeamMember(req, res, next) {
  const s = await tlScope(req, res); if (!s) return;
  if (!s.team.has(String(req.params.id))) return res.status(404).json({ error: "Person not found in your team." });
  next();
}

// T-2 (D-125): a Team Lead deletes only Backlog / To-Do tasks (confirm in the UI).
export async function deletableTask(req, res, next) {
  const t = valid(req.params.id) ? await Task.findById(req.params.id, "status").lean() : null;
  if (t && !canDeleteTask(t.status)) return res.status(409).json({ error: "Only tasks in Backlog or To Do can be deleted. Started work stays for the record." });
  next();
}
