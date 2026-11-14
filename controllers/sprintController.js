// Manager Sprints (V2 Phase 3 · M-3, UX §6): list, create/edit, planning, start, close, summary.
// Every route: Manager only (route guard) + sprint/project inside the caller's org; tasks must belong to the
// sprint's project. Planning writes only Sprint.tasks; task documents are never changed here (D-027).
// Rules live in services/sprintRules.js.
import { createNotification } from "./notificationController.js";
import mongoose from "mongoose";
import Sprint   from "../models/Sprint.js";
import Task     from "../models/Task.js";
import Project  from "../models/Project.js";
import { orgScope, audit } from "./managerProjectsController.js";
import {
  PAGE_SIZE, ACTIVE_STATUSES, OPEN_STATUSES, STATUS_FILTER, statusLabel, validateSprintInput, overlappingSprints,
  startBlockers, membershipUpdate, teamCapacity, estimatedHours, velocity, progressPct, daysLeft, sprintSummary,
  parseSprintListQuery, canDeleteSprint, sprintNotifyList,
} from "../services/sprintRules.js";

const CLOSED_PROJECT = ["Archived", "Completed", "Deleted"];
const LEADERS = ["Director", "Manager"];
const TASK_FIELDS = "title type priority status xpValue estimatedHours deadline assignees assignee completedAt submittedAt firstSubmittedAt tlScore";

// Sprint for :id in the caller's org (+ its project), or answers 404 and returns null.
async function loadSprint(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: "Sprint not found." }); return null; }
  const scope = await orgScope(req.user.orgId);
  if (!scope) { res.status(404).json({ error: "Organization not found." }); return null; }
  const sprint = await Sprint.findOne({ _id: req.params.id, ...scope.filter });
  if (!sprint) { res.status(404).json({ error: "Sprint not found." }); return null; }
  const project = sprint.projectId
    ? await Project.findOne({ _id: sprint.projectId, ...scope.filter, isDeleted: { $ne: true } }, "title status members managerId").populate("members", "name role status").lean()
    : null;
  return { sprint, project, scope };
}

const team = (project) => (project?.members ?? []).filter((m) => m && m.status !== "deleted" && !LEADERS.includes(m.role));
const teamLeads = (project) => team(project).filter((m) => m.role === "Team Lead");
const taskOut = (t) => ({
  id: t._id, title: t.title, type: t.type, priority: t.priority, status: t.status, xpValue: t.xpValue ?? 0,
  estimatedHours: t.estimatedHours ?? null, deadline: t.deadline ?? null,
  assignees: [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])]
    .filter((p, i, a) => p?._id && a.findIndex((q) => String(q._id) === String(p._id)) === i).map((p) => ({ id: p._id, name: p.name })),
});
// T-6 (D-153): members + Manager hear it, whoever did it (Team Lead or Manager). Never blocks the sprint change.
const notifySprint = (req, project, sprint, type, title, message) => Promise.all(sprintNotifyList({ members: project.members ?? [], managerId: project.managerId, actorId: req.user.id })
  .map((userId) => createNotification({ userId, orgId: req.user.orgId, type, title, message, meta: { sprintId: sprint._id, projectId: project._id } }))).catch((e) => console.error("[sprint notify]", e.message));
const otherActive = (sprint) => Sprint.findOne({ projectId: sprint.projectId, status: { $in: ACTIVE_STATUSES }, _id: { $ne: sprint._id } }, "name").lean();

// ── GET /api/manager/sprints?status=Planned,Active&project=<id>&page=n ─────────
export async function getSprints(req, res) {
  const q = parseSprintListQuery(req.query);
  const scope = await orgScope(req.user.orgId);
  if (!scope) return res.status(404).json({ error: "Organization not found." });
  const projects = await Project.find({ ...scope.filter, isDeleted: { $ne: true }, status: { $nin: ["Deleted"] } }, "title status").sort({ title: 1 }).lean();
  const filter = { ...scope.filter, projectId: { $in: projects.map((p) => p._id) } };
  if (q.project.length) filter.projectId = { $in: q.project.filter((id) => projects.some((p) => String(p._id) === id)) };
  if (q.status.length) filter.status = { $in: q.status.flatMap((s) => STATUS_FILTER[s]) };
  const [total, sprints] = await Promise.all([
    Sprint.countDocuments(filter),
    Sprint.find(filter, "name goal status startDate endDate projectId tasks closeSummary").populate("tasks", "status xpValue")
      .sort({ startDate: -1, _id: -1 }).skip((q.page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
  ]);
  const title = Object.fromEntries(projects.map((p) => [String(p._id), p.title]));
  res.json({
    total, page: q.page, pageSize: PAGE_SIZE,
    projects: projects.filter((p) => !CLOSED_PROJECT.includes(p.status)).map((p) => ({ id: p._id, title: p.title })),
    items: sprints.map((s) => {
      const tasks = (s.tasks ?? []).filter(Boolean);
      return {
        id: s._id, name: s.name, goal: s.goal, status: statusLabel(s.status), startDate: s.startDate, endDate: s.endDate,
        projectId: s.projectId, projectTitle: title[String(s.projectId)] ?? "—",
        done: s.closeSummary?.done ?? tasks.filter((t) => t.status === "Done").length,
        total: s.closeSummary?.planned ?? tasks.length,
        velocity: s.closeSummary?.velocity ?? velocity(tasks),
      };
    }),
  });
}

// ── POST /api/manager/sprints { name, goal, startDate, endDate, projectId } ───
export async function createSprint(req, res) {
  const { errors, value } = validateSprintInput(req.body, { mode: "create" });
  if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], fields: errors });
  const scope = await orgScope(req.user.orgId);
  if (!scope) return res.status(404).json({ error: "Organization not found." });
  const project = await Project.findOne({ _id: value.projectId, ...scope.filter, isDeleted: { $ne: true } }, "title status").lean();
  if (!project) return res.status(400).json({ error: "Choose a project from your organization.", fields: { projectId: "Choose a project from your organization." } });
  if (CLOSED_PROJECT.includes(project.status)) return res.status(409).json({ error: `"${project.title}" is ${project.status.toLowerCase()}; restore it before planning sprints.` });

  const sprint = await Sprint.create({ ...value, projectId: project._id, status: "Planning", orgId: req.user.orgId, createdBy: req.user.id });
  const siblings = await Sprint.find({ projectId: project._id }, "name status startDate endDate").lean();
  audit(scope.org, req, project, "sprint_created", `Sprint "${sprint.name}" planned in "${project.title}".`);
  res.status(201).json({ id: sprint._id, overlaps: overlappingSprints(siblings, { ...value, excludeId: sprint._id }).map((s) => s.name) });
}

// ── GET /api/manager/sprints/:id ──────────────────────────────────────────────
export async function getSprintDetail(req, res) {
  const loaded = await loadSprint(req, res);
  if (!loaded) return;
  const { sprint, project, scope } = loaded;
  const [tasks, active, siblings] = await Promise.all([
    Task.find({ _id: { $in: sprint.tasks } }, TASK_FIELDS).populate("assignees", "name").populate("assignee", "name").lean(),
    sprint.status === "Planning" && sprint.projectId ? otherActive(sprint) : null,
    sprint.projectId ? Sprint.find({ projectId: sprint.projectId }, "name status startDate endDate").lean() : [],
  ]);
  const wt = scope.org.workingTime ?? {};
  const capacity = teamCapacity({ memberCount: team(project).length, hoursPerDay: wt.hoursPerDay ?? 7, workingDays: wt.workingDays?.length ? wt.workingDays : undefined, startDate: sprint.startDate, endDate: sprint.endDate });
  res.json({
    id: sprint._id, name: sprint.name, goal: sprint.goal, status: statusLabel(sprint.status), startDate: sprint.startDate, endDate: sprint.endDate,
    completedAt: sprint.completedAt,
    project: project ? { id: project._id, title: project.title, status: project.status } : null,
    teamLeads: teamLeads(project).map((m) => ({ id: m._id, name: m.name })),
    tasks: tasks.map(taskOut),
    stats: {
      total: tasks.length, done: tasks.filter((t) => t.status === "Done").length, velocity: velocity(tasks), progressPct: progressPct(tasks),
      daysLeft: daysLeft(sprint.endDate), estimatedHours: estimatedHours(tasks), unestimated: tasks.filter((t) => t.estimatedHours == null).length,
    },
    capacity,
    startBlockers: sprint.status === "Planning" ? startBlockers({ status: sprint.status, teamLeadCount: teamLeads(project).length, taskCount: tasks.length, otherActive: active?.name }) : [],
    overlaps: overlappingSprints(siblings, { startDate: sprint.startDate, endDate: sprint.endDate, excludeId: sprint._id }).map((s) => s.name),
    nextSprints: sprint.projectId ? siblings.filter((s) => s.status === "Planning" && String(s._id) !== String(sprint._id)).map((s) => ({ id: s._id, name: s.name, startDate: s.startDate })) : [],
  });
}

// ── PATCH /api/manager/sprints/:id { name, goal, startDate, endDate } ────────
// Planned: everything but the project. Active: name, goal, end date. Closed: nothing.
export async function updateSprint(req, res) {
  const loaded = await loadSprint(req, res);
  if (!loaded) return;
  const { sprint } = loaded;
  if (sprint.status === "Completed") return res.status(409).json({ error: "A closed sprint cannot be changed." });
  const active = ACTIVE_STATUSES.includes(sprint.status);
  const merged = { name: sprint.name, goal: sprint.goal, startDate: sprint.startDate, endDate: sprint.endDate, ...req.body };
  if (active) merged.startDate = sprint.startDate;
  const { errors, value } = validateSprintInput(merged, { mode: "edit" });
  if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], fields: errors });
  Object.assign(sprint, value);
  await sprint.save();
  if (loaded.project) audit(loaded.scope.org, req, loaded.project, "sprint_updated", `Sprint "${sprint.name}" edited.`); // T-5 (D-143)
  const siblings = await Sprint.find({ projectId: sprint.projectId }, "name status startDate endDate").lean();
  res.json({ id: sprint._id, overlaps: overlappingSprints(siblings, { ...value, excludeId: sprint._id }).map((s) => s.name) });
}

// ── GET /api/manager/sprints/:id/backlog ──────────────────────────────────────
// The project's open tasks that are in no planned or active sprint.
export async function getSprintBacklog(req, res) {
  const loaded = await loadSprint(req, res);
  if (!loaded) return;
  const { sprint } = loaded;
  if (!sprint.projectId) return res.json({ tasks: [] });
  const busy = await Sprint.find({ projectId: sprint.projectId, status: { $in: OPEN_STATUSES } }, "tasks").lean();
  const tasks = await Task.find({ projectId: sprint.projectId, status: { $ne: "Done" }, _id: { $nin: busy.flatMap((s) => s.tasks ?? []) } }, TASK_FIELDS)
    .populate("assignees", "name").populate("assignee", "name").sort({ priority: 1, deadline: 1 }).limit(200).lean();
  res.json({ tasks: tasks.map(taskOut) });
}

// ── POST /api/manager/sprints/:id/tasks { taskId }  ·  DELETE /:id/tasks/:taskId ─
// Only the sprint's task list changes; any other body field is ignored.
async function changeMembership(req, res, action, taskId) {
  const loaded = await loadSprint(req, res);
  if (!loaded) return;
  const { sprint, scope } = loaded;
  if (!OPEN_STATUSES.includes(sprint.status)) return res.status(409).json({ error: "A closed sprint cannot be changed." });
  if (!sprint.projectId) return res.status(409).json({ error: "This sprint has no project." });
  const update = membershipUpdate(action, taskId);
  if (!update) return res.status(400).json({ error: "Pick a task." });
  if (action === "add") {
    const task = await Task.findOne({ _id: taskId, projectId: sprint.projectId, ...scope.filter }, "status").lean();
    if (!task) return res.status(404).json({ error: "That task is not in this sprint's project." });
    if (task.status === "Done") return res.status(409).json({ error: "That task is already done." });
    const elsewhere = await Sprint.findOne({ _id: { $ne: sprint._id }, tasks: task._id, status: { $in: OPEN_STATUSES } }, "name").lean();
    if (elsewhere) return res.status(409).json({ error: `That task is already in "${elsewhere.name}".` });
  }
  const after = await Sprint.findOneAndUpdate({ _id: sprint._id, status: { $in: OPEN_STATUSES } }, update, { returnDocument: "after" }).lean();
  if (!after) return res.status(409).json({ error: "A closed sprint cannot be changed." });
  if (loaded.project) audit(scope.org, req, loaded.project, "sprint_tasks_changed", `Task ${action === "add" ? "added to" : "removed from"} sprint "${sprint.name}".`, { after: { taskId: String(taskId), action } }); // T-5 (D-143)
  res.json({ ok: true, taskCount: after.tasks.length });
}
export const addTaskToSprint = (req, res) => changeMembership(req, res, "add", req.body?.taskId);
export const removeTaskFromSprint = (req, res) => changeMembership(req, res, "remove", req.params.taskId);

// ── DELETE sprint (Team Lead route only, T-5 D-143): a planned sprint; its tasks stay as they are. ──
export async function deleteSprint(req, res) {
  const loaded = await loadSprint(req, res);
  if (!loaded) return;
  const { sprint, project, scope } = loaded;
  if (!canDeleteSprint(sprint.status)) return res.status(409).json({ error: "Only a planned sprint can be deleted." });
  const r = await Sprint.deleteOne({ _id: sprint._id, status: "Planning" });
  if (!r.deletedCount) return res.status(409).json({ error: "Only a planned sprint can be deleted." });
  if (project) audit(scope.org, req, project, "sprint_deleted", `Sprint "${sprint.name}" deleted.`);
  res.json({ ok: true });
}

// ── POST /api/manager/sprints/:id/start ───────────────────────────────────────
export async function startSprint(req, res) {
  const loaded = await loadSprint(req, res);
  if (!loaded) return;
  const { sprint, project, scope } = loaded;
  if (!project) return res.status(409).json({ error: "This sprint has no project.", reasons: ["This sprint has no project."] });
  const [taskCount, active] = await Promise.all([
    Task.countDocuments({ _id: { $in: sprint.tasks } }),
    otherActive(sprint),
  ]);
  const reasons = startBlockers({ status: sprint.status, teamLeadCount: teamLeads(project).length, taskCount, otherActive: active?.name });
  if (reasons.length) return res.status(409).json({ error: reasons[0], reasons });
  // ponytail: check-then-set; two Managers starting two sprints of one project in the same instant could both pass.
  // A partial unique index on { projectId, status: "Active" } closes it once old duplicate data is cleaned.
  const r = await Sprint.updateOne({ _id: sprint._id, status: "Planning" }, { $set: { status: "Active" } });
  if (!r.modifiedCount) return res.status(409).json({ error: "Only a planned sprint can be started.", reasons: ["Only a planned sprint can be started."] });
  audit(scope.org, req, project, "sprint_started", `Sprint "${sprint.name}" started in "${project.title}".`);
  notifySprint(req, project, sprint, "sprint_started", "Sprint started", `"${sprint.name}" started in "${project.title}".`);
  res.json({ ok: true, status: "Active" });
}

// ── POST /api/manager/sprints/:id/close { unfinished: "backlog" | "next", nextSprintId } ─
export async function closeSprint(req, res) {
  const loaded = await loadSprint(req, res);
  if (!loaded) return;
  const { sprint, project, scope } = loaded;
  if (!ACTIVE_STATUSES.includes(sprint.status)) return res.status(409).json({ error: "Only an active sprint can be closed." });
  const choice = req.body?.unfinished;
  if (!["backlog", "next"].includes(choice)) return res.status(400).json({ error: "Choose where the unfinished tasks go." });
  let next = null;
  if (choice === "next") {
    next = mongoose.isValidObjectId(req.body?.nextSprintId)
      ? await Sprint.findOne({ _id: req.body.nextSprintId, projectId: sprint.projectId, status: "Planning", ...scope.filter }, "name").lean()
      : null;
    if (!next) return res.status(400).json({ error: "Pick a planned sprint of this project for the unfinished tasks." });
  }
  const tasks = await Task.find({ _id: { $in: sprint.tasks } }, `${TASK_FIELDS} +aiScore`).populate("assignees", "name").populate("assignee", "name").lean();
  const now = new Date();
  const summary = sprintSummary(tasks, { endDate: sprint.endDate && sprint.endDate < now ? sprint.endDate : now, now });
  const unfinished = tasks.filter((t) => t.status !== "Done").map((t) => t._id);
  summary.unfinishedMovedTo = unfinished.length ? (next ? next.name : "Backlog") : null;

  const r = await Sprint.updateOne({ _id: sprint._id, status: { $in: ACTIVE_STATUSES } }, {
    $set: { status: "Completed", completedAt: now, velocity: summary.velocity, closeSummary: summary },
    $pull: { tasks: { $in: unfinished } },
  });
  if (!r.modifiedCount) return res.status(409).json({ error: "Only an active sprint can be closed." });
  if (next && unfinished.length) await Sprint.updateOne({ _id: next._id }, { $addToSet: { tasks: { $each: unfinished } } });
  if (project) audit(scope.org, req, project, "sprint_closed", `Sprint "${sprint.name}" closed: ${summary.done}/${summary.planned} done; ${unfinished.length} unfinished → ${summary.unfinishedMovedTo ?? "none"}.`);
  if (project) notifySprint(req, project, sprint, "sprint_closed", "Sprint closed", `"${sprint.name}" closed in "${project.title}": ${summary.done} of ${summary.planned} tasks done.`);
  res.json({ ok: true, moved: unfinished.length, movedTo: summary.unfinishedMovedTo });
}

// ── GET /api/manager/sprints/:id/summary ──────────────────────────────────────
// Frozen numbers from close (legacy closed sprints are computed from their tasks) + velocity history.
export async function getSprintSummary(req, res) {
  const loaded = await loadSprint(req, res);
  if (!loaded) return;
  const { sprint, project } = loaded;
  if (sprint.status !== "Completed") return res.status(409).json({ error: "The summary is ready once the sprint is closed." });
  let summary = sprint.closeSummary;
  if (!summary) {
    const tasks = await Task.find({ _id: { $in: sprint.tasks } }, `${TASK_FIELDS} +aiScore`).populate("assignees", "name").populate("assignee", "name").lean();
    summary = { ...sprintSummary(tasks, { endDate: sprint.endDate ?? sprint.completedAt }), unfinishedMovedTo: null };
  }
  const past = sprint.projectId
    ? await Sprint.find({ projectId: sprint.projectId, status: "Completed" }, "name endDate completedAt closeSummary tasks").populate("tasks", "status xpValue").sort({ endDate: -1, completedAt: -1 }).limit(8).lean()
    : [];
  res.json({
    id: sprint._id, name: sprint.name, goal: sprint.goal, startDate: sprint.startDate, endDate: sprint.endDate, completedAt: sprint.completedAt,
    project: project ? { id: project._id, title: project.title } : null,
    summary,
    history: past.reverse().map((s) => {
      const t = (s.tasks ?? []).filter(Boolean);
      return { id: s._id, name: s.name, velocity: s.closeSummary?.velocity ?? velocity(t), planned: s.closeSummary?.planned ?? t.length, done: s.closeSummary?.done ?? t.filter((x) => x.status === "Done").length, current: String(s._id) === String(sprint._id) };
    }),
  });
}
