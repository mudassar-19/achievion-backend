// UI-B: Director project page + module page. READ-ONLY, Director only, org-scoped.
// D-027: no individual performance score. People rows carry task and hour counts only; quality is a module-level average.
// No email, HP, XP or any other private field leaves this file.
import mongoose from "mongoose";
import User from "../models/User.js";
import Project from "../models/Project.js";
import Milestone from "../models/Milestone.js";
import Task from "../models/Task.js";
import Risk from "../models/Risk.js";
import ExtensionRequest from "../models/ExtensionRequest.js";
import { projectHealth } from "../services/projectHealth.js";

const valid = (id) => mongoose.Types.ObjectId.isValid(id);
const OPEN = ["Backlog", "To-Do", "In-Progress", "In-Review"];
const MIN_SCORED = 3; // fewer scored tasks than this → no module average (it would point at one person)
import { orgProjectScope } from "../services/directorScope.js";
import { pct } from "../services/moduleProgress.js"; // LB-1: one progress formula for Director and Team Lead
const person = (u) => (u ? { id: u._id, name: u.name } : null);

// Same org scope as GET /api/director/projects: the project's director belongs to the caller's organization.
async function loadProject(req, res) {
  if (!valid(req.params.id)) { res.status(400).json({ error: "Invalid project id." }); return null; }
  const dirIds = (await User.find({ orgId: req.user.orgId, role: "Director" }, "_id").lean()).map((d) => d._id);
  const project = await Project.findOne({ _id: req.params.id, ...(await orgProjectScope(req.user.orgId)) }).populate("managerId", "name").lean();
  if (!project) { res.status(404).json({ error: "Project not found." }); return null; }
  return project;
}

// Task counts by status (+ overdue, hours) grouped by `groupBy` ("$milestoneId" or null for the whole match).
async function taskCounts(match, groupBy, now) {
  const is = (s) => ({ $sum: { $cond: [{ $eq: ["$status", s] }, 1, 0] } });
  const open = { $in: ["$status", OPEN] };
  return Task.aggregate([
    { $match: match },
    { $group: {
      _id: groupBy,
      total: { $sum: 1 }, done: is("Done"), inProgress: is("In-Progress"), inReview: is("In-Review"), todo: is("To-Do"), backlog: is("Backlog"),
      overdue: { $sum: { $cond: [{ $and: [open, { $ne: ["$deadline", null] }, { $lt: ["$deadline", now] }] }, 1, 0] } },
      plannedHours: { $sum: { $ifNull: ["$estimatedHours", 0] } },
      openHours: { $sum: { $cond: [open, { $ifNull: ["$estimatedHours", 0] }, 0] } },
      loggedHours: { $sum: { $ifNull: ["$actualHours", 0] } },
    } },
  ]);
}
const ZERO = { total: 0, done: 0, inProgress: 0, inReview: 0, todo: 0, backlog: 0, overdue: 0, plannedHours: 0, openHours: 0, loggedHours: 0 };
const health = (c, startDate, deadline, now) => {
  const h = projectHealth({ startDate, deadline, now, progressPct: pct(c.done, c.total), openTasks: c.total - c.done, overdueTasks: c.overdue, totalTasks: c.total });
  return { score: h.score, band: h.band };
};
// done = every task done (or the module is marked Completed); running = some work started; otherwise remaining.
const moduleState = (m, c) =>
  m.status === "Completed" || (c.total > 0 && c.done === c.total) ? "Done"
    : c.done + c.inProgress + c.inReview > 0 || m.status === "In Progress" || m.status === "Delayed" ? "Running" : "Not started";
const round1 = (n) => Math.round(n * 10) / 10;

// ── GET /api/director/projects/:id/overview ───────────────────────────────────
export async function getProjectOverview(req, res) {
  const project = await loadProject(req, res);
  if (!project) return;
  const now = new Date();
  const [all, perModule, modules, risks, extensions] = await Promise.all([
    taskCounts({ projectId: project._id }, null, now),
    taskCounts({ projectId: project._id, milestoneId: { $ne: null } }, "$milestoneId", now),
    Milestone.find({ projectId: project._id }).sort({ order: 1 }).populate("teamLeadId", "name").lean(),
    Risk.find({ projectId: project._id, status: "open" }).sort({ score: -1 }).limit(10).select("title category score").lean(),
    ExtensionRequest.find({ projectId: project._id }).sort({ createdAt: -1 }).limit(20).populate("taskId", "title").lean(),
  ]);
  const t = all[0] ?? ZERO;
  const byMod = Object.fromEntries(perModule.map((c) => [String(c._id), c]));
  const moduleList = modules.map((m) => {
    const c = byMod[String(m._id)] ?? ZERO;
    return {
      id: m._id, title: m.title, state: moduleState(m, c), teamLead: person(m.teamLeadId),
      startDate: m.startDate ?? null, dueDate: m.dueDate ?? null,
      tasks: c.total, done: c.done, overdue: c.overdue, progressPct: pct(c.done, c.total),
      health: health(c, m.startDate, m.dueDate, now),
    };
  });
  const count = (s) => moduleList.filter((m) => m.state === s).length;
  const leads = new Map(modules.filter((m) => m.teamLeadId).map((m) => [String(m.teamLeadId._id), person(m.teamLeadId)]));

  res.json({
    id: project._id, title: project.title, description: project.description || "",
    status: project.status, priority: project.priority ?? null, category: project.category ?? null,
    startDate: project.startDate ?? null, deadline: project.deadline ?? null,
    manager: person(project.managerId), teamLeads: [...leads.values()],
    health: health(t, project.startDate, project.deadline, now),
    progress: pct(t.done, t.total),
    modules: { total: moduleList.length, done: count("Done"), running: count("Running"), remaining: count("Not started") },
    tasks: { total: t.total, done: t.done, inProgress: t.inProgress, inReview: t.inReview, todo: t.todo, backlog: t.backlog, overdue: t.overdue },
    hours: { planned: round1(t.plannedHours), open: round1(t.openHours), logged: round1(t.loggedHours), tracked: t.loggedHours > 0 }, // QA3 C-12: tracked=false reads "Not tracked", never "Logged 0 h"
    moduleList,
    risks: risks.map((r) => ({ id: r._id, title: r.title, category: r.category ?? null, rating: r.score ?? null })),
    extensions: extensions.map((e) => ({
      id: e._id, subject: e.taskId?.title ?? null, reason: e.reason, requestedDays: e.requestedDays,
      originalDeadline: e.originalDeadline ?? null, status: e.status, requestedAt: e.createdAt, decidedAt: e.decidedAt ?? null,
    })),
  });
}

// ── GET /api/director/projects/:id/modules/:moduleId ──────────────────────────
export async function getProjectModule(req, res) {
  if (!valid(req.params.moduleId)) return res.status(400).json({ error: "Invalid module id." });
  const project = await loadProject(req, res);
  if (!project) return;
  const mod = await Milestone.findOne({ _id: req.params.moduleId, projectId: project._id }).populate("teamLeadId", "name").lean();
  if (!mod) return res.status(404).json({ error: "Module not found." });
  const now = new Date();
  // ponytail: 300 newest-deadline tasks per module; add paging when a module grows past that.
  const tasks = await Task.find({ projectId: project._id, milestoneId: mod._id },
    "title status priority deadline completedAt estimatedHours actualHours assignee assignees tlScore")
    .populate("assignee", "name role").populate("assignees", "name role").sort({ deadline: 1 }).limit(300).lean();

  const c = { ...ZERO };
  const people = new Map();
  const scored = [];
  const rows = tasks.map((t) => {
    const open = t.status !== "Done";
    const overdue = open && !!t.deadline && t.deadline < now;
    const key = { "In-Progress": "inProgress", "In-Review": "inReview", "To-Do": "todo", Backlog: "backlog", Done: "done" }[t.status];
    c.total++; c[key]++; if (overdue) c.overdue++;
    c.plannedHours += t.estimatedHours ?? 0; c.loggedHours += t.actualHours ?? 0; if (open) c.openHours += t.estimatedHours ?? 0;
    if (!open && typeof t.tlScore === "number") scored.push(t.tlScore);
    const who = [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].filter((u, i, a) => u && a.findIndex((x) => String(x._id) === String(u._id)) === i);
    for (const u of who) {
      const p = people.get(String(u._id)) ?? { id: u._id, name: u.name, role: u.role, tasks: { total: 0, done: 0, open: 0, overdue: 0 }, hours: { planned: 0, logged: 0 } };
      p.tasks.total++; p.tasks[open ? "open" : "done"]++; if (overdue) p.tasks.overdue++;
      // A shared task's hours are split evenly between its assignees.
      p.hours.planned += (t.estimatedHours ?? 0) / who.length; p.hours.logged += (t.actualHours ?? 0) / who.length;
      people.set(String(u._id), p);
    }
    return { id: t._id, title: t.title, status: t.status, priority: t.priority, deadline: t.deadline ?? null, completedAt: t.completedAt ?? null,
      overdue, estimatedHours: t.estimatedHours ?? null, assignees: who.map((u) => u.name) };
  });

  res.json({
    id: mod._id, title: mod.title, description: mod.description || "", state: moduleState(mod, c),
    project: { id: project._id, title: project.title },
    startDate: mod.startDate ?? null, dueDate: mod.dueDate ?? null, completedAt: mod.completedAt ?? null,
    teamLead: person(mod.teamLeadId), acceptedAt: mod.tlAcceptedAt ?? null,
    progress: { total: c.total, done: c.done, inProgress: c.inProgress, inReview: c.inReview, todo: c.todo, backlog: c.backlog, overdue: c.overdue, pct: pct(c.done, c.total) },
    hours: { planned: round1(c.plannedHours), open: round1(c.openHours), logged: round1(c.loggedHours), tracked: c.loggedHours > 0 },
    health: health(c, mod.startDate, mod.dueDate, now),
    avgQuality: scored.length >= MIN_SCORED ? { avg: Math.round(scored.reduce((a, b) => a + b, 0) / scored.length), count: scored.length } : null,
    tasks: rows,
    people: [...people.values()].map((p) => ({ ...p, hours: { planned: round1(p.hours.planned), logged: round1(p.hours.logged) } }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}
