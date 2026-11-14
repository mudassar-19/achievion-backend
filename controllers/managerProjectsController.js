// Manager Projects (V2 Phase 3 · M-2, UX §5): list, edit, archive/restore, overview extras, team, modules,
// sprints, history, read-only task detail, deadline extension. Every route: Manager only + project in the
// caller's org (resolved the same way as projectController). Rules live in services/projectRules.js.
import mongoose     from "mongoose";
import Organization from "../models/Organization.js";
import Project      from "../models/Project.js";
import Milestone    from "../models/Milestone.js";
import Task         from "../models/Task.js";
import Sprint       from "../models/Sprint.js";
import User         from "../models/User.js";
import XpLog        from "../models/XpLog.js";
import AuditLog     from "../models/AuditLog.js";
import ExtensionRequest from "../models/ExtensionRequest.js";
import { createNotification } from "./notificationController.js";
import { healthForProjects }  from "../services/projectHealthService.js";
import { setupState, NOT_MEMBER_ROLES } from "../services/projectSetupRules.js";
import { parseListQuery, validateProjectInput, extensionDecision, archiveTransition, PAGE_SIZE } from "../services/projectRules.js";
import { isDisagreement } from "../services/aiEvalRules.js";

const IS_OID = /^[0-9a-f]{24}$/i;
const OPEN = { $ne: "Done" };
const LEADERS = ["Director", "Manager"];

export async function orgScope(orgId) {
  const org = await Organization.findOne(IS_OID.test(orgId) ? { _id: orgId } : { orgId }, "_id orgId extensionRules workingTime workloadThresholdPct").lean();
  if (!org) return null;
  const ids = [String(org._id), ...(org.orgId ? [org.orgId] : [])];
  return { org, filter: { orgId: { $in: ids } } };
}

// Loads the project for :id inside the caller's org, or answers 404 and returns null.
async function loadProject(req, res, fields) {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: "Project not found." }); return null; }
  const scope = await orgScope(req.user.orgId);
  if (!scope) { res.status(404).json({ error: "Organization not found." }); return null; }
  const project = await Project.findOne({ _id: req.params.id, ...scope.filter, isDeleted: { $ne: true } }, fields).lean();
  if (!project) { res.status(404).json({ error: "Project not found." }); return null; }
  return { project, org: scope.org };
}

export const audit = (org, req, project, action, detail, extra = {}) => AuditLog.create({
  action, orgId: org._id, performedBy: req.user.id, targetProjectId: project._id, projectTitle: project.title, detail, scope: "project", ...extra,
}).catch((e) => console.error("[audit]", e.message));

// M-6: archiving (the Manager's close action) pre-fills the project's Lessons learned with its auto facts (once, never blocks).
const prefill = (org, project, req) => import("../services/reportService.js")
  .then((m) => m.prefillLessons({ org, filter: { orgId: { $in: [String(org._id), ...(org.orgId ? [org.orgId] : [])] } } }, project._id, req.user.id))
  .catch((e) => console.error("[lessons-prefill]", e.message));

// Org user that may join a project (not Director/Manager, not deleted).
const orgMember = (orgId, userId) => (IS_OID.test(String(userId ?? ""))
  ? User.findOne({ _id: userId, orgId, status: { $ne: "deleted" }, role: { $nin: LEADERS } }, "_id name role").lean()
  : null);

// ── GET /api/manager/projects/list ───────────────────────────────────────────
export async function listProjects(req, res) {
  const q = parseListQuery(req.query);
  const scope = await orgScope(req.user.orgId);
  if (!scope) return res.status(404).json({ error: "Organization not found." });

  const filter = { ...scope.filter, isDeleted: { $ne: true } };
  filter.status = q.archived ? "Archived" : (q.status.length ? { $in: q.status } : { $nin: ["Archived", "Deleted"] });
  if (q.priority.length) filter.priority = { $in: q.priority };
  if (q.search) filter.title = { $regex: q.search, $options: "i" };

  const [total, projects] = await Promise.all([
    Project.countDocuments(filter),
    Project.find(filter, "title status priority deadline startDate members archivedAt")
      .populate("members", "name role")
      .sort({ [q.sort]: q.dir, _id: 1 }).skip((q.page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
  ]);
  const [health, mods] = await Promise.all([
    healthForProjects(projects, new Date()),
    Milestone.find({ projectId: { $in: projects.map((p) => p._id) } }, "projectId teamLeadId").lean(),
  ]);
  // U-1 (D-132): Planning projects without a module, a Team Lead or a member show "Needs setup".
  const needsSetup = (p) => {
    if (!["Planning", "Scheduled"].includes(p.status)) return false;
    const m = mods.filter((x) => String(x.projectId) === String(p._id));
    return !setupState({ modules: m, memberCount: (p.members ?? []).filter((u) => !NOT_MEMBER_ROLES.includes(u?.role)).length }).complete;
  };
  res.json({
    total, page: q.page, pageSize: PAGE_SIZE,
    items: projects.map((p) => {
      const h = health.get(String(p._id));
      return {
        id: p._id, title: p.title, status: p.status, priority: p.priority, deadline: p.deadline, archivedAt: p.archivedAt ?? null,
        progressPct: h?.progressPct ?? 0, healthScore: h ? h.score : 100, healthBand: h?.band ?? "On track",
        teamSize: (p.members ?? []).length, needsSetup: needsSetup(p),
        teamLeads: (p.members ?? []).filter((m) => m?.role === "Team Lead").map((m) => m.name),
      };
    }),
  });
}

// ── PATCH /api/manager/projects/:id  (edit; deadline via extension, people via Team tab) ──
export async function editProject(req, res) {
  const loaded = await loadProject(req, res, "_id title");
  if (!loaded) return;
  const { errors, value } = validateProjectInput(req.body, { mode: "edit" });
  for (const k of ["category", "visibility", "riskLevel"]) if (req.body[k] !== undefined) value[k] = req.body[k];
  if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], fields: errors });
  if (!Object.keys(value).length) return res.status(400).json({ error: "Nothing to update." });

  const project = await Project.findByIdAndUpdate(loaded.project._id, { $set: value }, { returnDocument: "after", runValidators: true }).lean();
  audit(loaded.org, req, project, "project_updated", `Project "${project.title}" updated: ${Object.keys(value).join(", ")}.`);
  res.json({ project });
}

// ── POST /api/manager/projects/:id/archive | /restore ────────────────────────
export const archiveProject = (req, res) => setArchived(req, res, "archive");
export const restoreProject = (req, res) => setArchived(req, res, "restore");
async function setArchived(req, res, action) {
  const loaded = await loadProject(req, res, "_id title status statusBeforeArchive");
  if (!loaded) return;
  const next = archiveTransition(loaded.project, action);
  if (next.error) return res.status(409).json({ error: next.error });
  const project = await Project.findByIdAndUpdate(loaded.project._id, {
    $set: { status: next.status, statusBeforeArchive: next.statusBeforeArchive, archivedAt: action === "archive" ? new Date() : null },
    $push: { statusHistory: { status: next.status, changedBy: req.user.id, note: action === "archive" ? "Archived" : "Restored" } },
  }, { returnDocument: "after" }).lean();
  audit(loaded.org, req, project, action === "archive" ? "project_archived" : "project_restored",
    `Project "${project.title}" ${action === "archive" ? "archived" : `restored to ${project.status}`}.`,
    { before: { status: loaded.project.status }, after: { status: project.status } });
  if (action === "archive") prefill(loaded.org, project, req);
  res.json({ id: project._id, status: project.status });
}

// ── GET /api/manager/projects/:id/overview  (recent activity, top contributors, pending extension) ──
export async function getOverview(req, res) {
  const loaded = await loadProject(req, res, "_id title");
  if (!loaded) return;
  const pid = loaded.project._id;
  const taskIds = await Task.find({ projectId: pid }, "_id").lean();
  const [activity, xp, extensions] = await Promise.all([
    AuditLog.find({ targetProjectId: pid }, "action detail createdAt").sort({ createdAt: -1 }).limit(8).lean(),
    XpLog.aggregate([
      { $match: { taskId: { $in: taskIds.map((t) => t._id) }, amount: { $gt: 0 } } },
      { $group: { _id: "$userId", xp: { $sum: "$amount" } } },
      { $sort: { xp: -1 } }, { $limit: 10 },
    ]),
    ExtensionRequest.find({ projectId: pid, taskId: null }, "status requestedDays reason createdAt directorNote").sort({ createdAt: -1 }).limit(5).lean(),
  ]);
  const users = await User.find({ _id: { $in: xp.map((r) => r._id) }, role: { $nin: LEADERS } }, "name role").lean();
  const byId = Object.fromEntries(users.map((u) => [String(u._id), u]));
  res.json({
    recentActivity: activity.map((a) => ({ id: a._id, action: a.action, detail: a.detail, at: a.createdAt })),
    topContributors: xp.filter((r) => byId[String(r._id)]).slice(0, 5).map((r) => ({ id: r._id, name: byId[String(r._id)].name, role: byId[String(r._id)].role, xp: r.xp })),
    extensions,
  });
}

// ── GET /api/manager/projects/:id/history?page= ──────────────────────────────
export async function getHistory(req, res) {
  const loaded = await loadProject(req, res, "_id");
  if (!loaded) return;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const filter = { targetProjectId: loaded.project._id };
  const [total, rows] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.find(filter, "action detail performedBy createdAt before after").sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
  ]);
  const actorIds = rows.map((r) => String(r.performedBy)).filter((x) => IS_OID.test(x));
  const actors = Object.fromEntries((await User.find({ _id: { $in: actorIds } }, "name role").lean()).map((u) => [String(u._id), u]));
  res.json({
    total, page, pageSize: PAGE_SIZE,
    items: rows.map((r) => ({ id: r._id, action: r.action, detail: r.detail, at: r.createdAt, by: actors[String(r.performedBy)]?.name ?? "System" })),
  });
}

// ── Team ─────────────────────────────────────────────────────────────────────
export async function getTeam(req, res) {
  const loaded = await loadProject(req, res, "_id members");
  if (!loaded) return;
  const ids = loaded.project.members ?? [];
  const [users, open] = await Promise.all([
    User.find({ _id: { $in: ids } }, "name role email avatarSeed status").lean(),
    Task.aggregate([
      { $match: { projectId: loaded.project._id, status: OPEN } },
      { $project: { who: { $setUnion: [{ $ifNull: ["$assignees", []] }, { $cond: [{ $ifNull: ["$assignee", false] }, ["$assignee"], []] }] } } },
      { $unwind: "$who" }, { $group: { _id: "$who", n: { $sum: 1 } } },
    ]),
  ]);
  const openBy = Object.fromEntries(open.map((r) => [String(r._id), r.n]));
  res.json({ members: users.map((u) => ({ id: u._id, name: u.name, role: u.role, email: u.email, avatarSeed: u.avatarSeed, openTasks: openBy[String(u._id)] ?? 0 })) });
}

export async function addMember(req, res) {
  const loaded = await loadProject(req, res, "_id title members");
  if (!loaded) return;
  const user = await orgMember(req.user.orgId, req.body?.userId);
  if (!user) return res.status(400).json({ error: "Pick a team member from your organization." });
  if ((loaded.project.members ?? []).some((m) => String(m) === String(user._id))) return res.status(409).json({ error: `${user.name} is already on this project.` });
  await Project.updateOne({ _id: loaded.project._id }, { $addToSet: { members: user._id } });
  audit(loaded.org, req, loaded.project, "project_member_added", `${user.name} (${user.role}) added to "${loaded.project.title}".`, { targetUserId: user._id });
  createNotification({ userId: user._id, orgId: req.user.orgId, type: "project_member_added", title: "Added to a project",
    message: `You were added to "${loaded.project.title}".`, meta: { projectId: loaded.project._id } }).catch(() => {});
  res.status(201).json({ id: user._id, name: user.name, role: user.role });
}

export async function removeMember(req, res) {
  const loaded = await loadProject(req, res, "_id title members");
  if (!loaded) return;
  const uid = req.params.userId;
  if (!IS_OID.test(uid) || !(loaded.project.members ?? []).some((m) => String(m) === uid)) return res.status(404).json({ error: "This person is not on the project." });
  const user = await User.findById(uid, "name role").lean();
  const openTasks = await Task.countDocuments({ projectId: loaded.project._id, status: OPEN, $or: [{ assignees: uid }, { assignee: uid }] });
  if (openTasks) return res.status(409).json({ error: `${user?.name ?? "This person"} still has ${openTasks} open task${openTasks === 1 ? "" : "s"}. Reassign them first.`, openTasks });
  if (user?.role === "Team Lead") {
    const leads = await User.countDocuments({ _id: { $in: loaded.project.members }, role: "Team Lead" });
    if (leads <= 1) return res.status(409).json({ error: "A project needs a Team Lead. Add another Team Lead before removing this one." });
  }
  await Promise.all([
    Project.updateOne({ _id: loaded.project._id }, { $pull: { members: new mongoose.Types.ObjectId(uid) } }),
    Milestone.updateMany({ projectId: loaded.project._id, teamLeadId: uid }, { $set: { teamLeadId: null } }),
  ]);
  audit(loaded.org, req, loaded.project, "project_member_removed", `${user?.name ?? uid} removed from "${loaded.project.title}".`, { targetUserId: uid });
  res.json({ ok: true });
}

// ── Modules (milestones shown as modules) ────────────────────────────────────
export async function getModules(req, res) {
  const loaded = await loadProject(req, res, "_id");
  if (!loaded) return;
  const [mods, counts] = await Promise.all([
    Milestone.find({ projectId: loaded.project._id }).sort({ order: 1 }).populate("teamLeadId", "name").lean(),
    Task.aggregate([
      { $match: { projectId: loaded.project._id, milestoneId: { $ne: null } } },
      { $group: { _id: "$milestoneId", total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ["$status", "Done"] }, 1, 0] } } } },
    ]),
  ]);
  const byMod = Object.fromEntries(counts.map((c) => [String(c._id), c]));
  res.json({ modules: mods.map((m) => {
    const c = byMod[String(m._id)] ?? { total: 0, done: 0 };
    return {
      id: m._id, title: m.title, description: m.description, status: m.status, dueDate: m.dueDate, roles: m.activeRoles ?? [],
      tasks: c.total, done: c.done, progressPct: c.total ? Math.round((c.done / c.total) * 100) : 0,
      teamLead: m.teamLeadId ? { id: m.teamLeadId._id, name: m.teamLeadId.name } : null,
    };
  }) });
}

// PATCH /api/manager/projects/:id/modules/:moduleId/lead  { teamLeadId, dueDate }
export async function assignModuleLead(req, res) {
  const loaded = await loadProject(req, res, "_id title deadline");
  if (!loaded) return;
  const { teamLeadId, dueDate } = req.body ?? {};
  if (!mongoose.isValidObjectId(req.params.moduleId)) return res.status(404).json({ error: "Module not found." });
  const mod = await Milestone.findOne({ _id: req.params.moduleId, projectId: loaded.project._id });
  if (!mod) return res.status(404).json({ error: "Module not found." });
  const lead = await orgMember(req.user.orgId, teamLeadId);
  if (!lead || lead.role !== "Team Lead") return res.status(400).json({ error: "Pick a Team Lead." });
  const due = dueDate ? new Date(dueDate) : null;
  if (dueDate && Number.isNaN(+due)) return res.status(400).json({ error: "The module deadline is not a valid date." });
  if (due && loaded.project.deadline && due > loaded.project.deadline) return res.status(400).json({ error: "The module deadline cannot be after the project deadline." });

  const before = mod.teamLeadId ? String(mod.teamLeadId) : null;
  mod.teamLeadId = lead._id;
  if (due) { mod.dueDate = due; mod.endDate = due; }
  await Promise.all([mod.save(), Project.updateOne({ _id: loaded.project._id }, { $addToSet: { members: lead._id } })]);
  audit(loaded.org, req, loaded.project, "module_lead_assigned", `Module "${mod.title}" assigned to ${lead.name}.`, { targetUserId: lead._id, before: { teamLeadId: before }, after: { teamLeadId: String(lead._id), dueDate: due } });
  createNotification({ userId: lead._id, orgId: req.user.orgId, type: "project_module_assigned", title: "New module for you",
    message: `You lead "${mod.title}" in "${loaded.project.title}"${due ? `, due ${due.toDateString()}` : ""}.`,
    meta: { projectId: loaded.project._id, milestoneId: mod._id } }).catch(() => {});
  res.json({ id: mod._id, teamLead: { id: lead._id, name: lead.name }, dueDate: mod.dueDate });
}

// ── GET /api/manager/projects/:id/sprints  (read-only list; creating sprints is M-3) ──
export async function getProjectSprints(req, res) {
  const loaded = await loadProject(req, res, "_id");
  if (!loaded) return;
  const sprints = await Sprint.find({ projectId: loaded.project._id }, "name goal status startDate endDate tasks").populate("tasks", "status").sort({ startDate: -1 }).lean();
  res.json({ sprints: sprints.map((s) => {
    const total = s.tasks?.length ?? 0, done = (s.tasks ?? []).filter((t) => t?.status === "Done").length;
    return { id: s._id, name: s.name, goal: s.goal, status: s.status, startDate: s.startDate, endDate: s.endDate, total, done };
  }) });
}

// ── GET /api/manager/tasks/:id/detail  (read-only drawer) ────────────────────
// The AI score is shown only after the Team Lead scored (D-075: no anchoring), together with the gap chip.
export async function getTaskDetail(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Task not found." });
  const t = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId }).select("+aiScore")
    .populate("assignees", "name role").populate("assignee", "name role").populate("comments.author", "name role")
    .populate("timeLogs.user", "name").populate("reviewedBy", "name").populate("activity.by", "name").lean();
  if (!t) return res.status(404).json({ error: "Task not found." });
  const people = [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].filter((p, i, a) => p && a.findIndex((x) => String(x._id) === String(p._id)) === i);
  const scored = t.tlScore != null;
  res.json({
    id: t._id, title: t.title, description: t.description, status: t.status, priority: t.priority, type: t.type,
    deadline: t.deadline, submittedAt: t.submittedAt, completedAt: t.completedAt, isLate: t.isLate,
    assignees: people.map((p) => ({ id: p._id, name: p.name, role: p.role })),
    comments: (t.comments ?? []).map((c) => ({ id: c._id, author: c.author?.name ?? "Someone", text: c.text, at: c.createdAt })),
    time: { minutes: (t.timeLogs ?? []).reduce((s, l) => s + (l.minutes ?? 0), 0), logs: (t.timeLogs ?? []).slice(-10).map((l) => ({ who: l.user?.name ?? "Someone", minutes: l.minutes, at: l.loggedAt, note: l.note ?? "" })) },
    submission: { note: t.submissionNote ?? "", links: (t.submissionLinks ?? []).map((l) => ({ label: l.label, url: l.url })), files: (t.submissionFiles ?? []).map((f) => ({ name: f.filename, url: f.url ?? null })) },
    history: (t.activity ?? []).slice(-30).reverse().map((a) => ({ kind: a.kind, who: a.by?.name ?? "Someone", at: a.at, from: a.from, to: a.to })), // T-1 drawer
    review: { tlScore: t.tlScore ?? null, aiScore: scored ? (t.aiScore ?? null) : null, disagree: scored && t.aiScore != null && isDisagreement(t.aiScore, t.tlScore), reviewedBy: t.reviewedBy?.name ?? null, reviewedAt: t.reviewedAt ?? null, note: t.reviewNote ?? null },
  });
}

// ── POST /api/manager/projects/:id/extension  { newDeadline, reason } ────────
export async function requestProjectExtension(req, res) {
  const loaded = await loadProject(req, res, "_id title startDate deadline status");
  if (!loaded) return;
  const { project, org } = loaded;
  const reason = String(req.body?.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) return res.status(400).json({ error: "Write a reason of 10 to 500 characters.", fields: { reason: "Write a reason of 10 to 500 characters." } });
  if (["Archived", "Completed", "Deleted"].includes(project.status)) return res.status(409).json({ error: "Closed projects cannot be extended." });
  if (await ExtensionRequest.exists({ projectId: project._id, taskId: null, status: "pending" }))
    return res.status(409).json({ error: "An extension for this project is already waiting for the Director." });

  const given = await ExtensionRequest.aggregate([
    { $match: { projectId: project._id, taskId: null, status: { $in: ["approved", "auto_applied"] } } },
    { $group: { _id: null, days: { $sum: { $ifNull: ["$counterDays", "$requestedDays"] } } } },
  ]);
  const decision = extensionDecision({ startDate: project.startDate, deadline: project.deadline, newDeadline: req.body?.newDeadline, extendedDaysSoFar: given[0]?.days ?? 0, rules: org.extensionRules ?? {} });
  if (decision.error) return res.status(400).json({ error: decision.error, fields: { newDeadline: decision.error } });
  if (decision.days > 365) return res.status(400).json({ error: "An extension can be at most 365 days.", fields: { newDeadline: "An extension can be at most 365 days." } });

  const base = { orgId: org._id, taskId: null, projectId: project._id, requestedBy: req.user.id, reason, requestedDays: decision.days, originalDeadline: project.deadline };
  if (decision.withinLimit) {
    const newDeadline = new Date(project.deadline.getTime() + decision.days * 86_400_000);
    const [ext] = await Promise.all([
      ExtensionRequest.create({ ...base, status: "auto_applied", autoApplied: true }),
      Project.updateOne({ _id: project._id }, { $set: { deadline: newDeadline } }),
    ]);
    await AuditLog.create({ action: "extension_requested", orgId: org._id, performedBy: req.user.id, targetProjectId: project._id, projectTitle: project.title, scope: "extension",
      detail: `Project deadline extended by ${decision.days} day(s) within the Manager limit: ${reason}`, before: { deadline: project.deadline }, after: { deadline: newDeadline } });
    return res.json({ applied: true, extension: ext, deadline: newDeadline });
  }

  const ext = await ExtensionRequest.create(base);
  const directors = await User.find({ orgId: req.user.orgId, role: "Director", status: { $ne: "deleted" } }, "_id").lean();
  await Promise.all(directors.map((d) => createNotification({ userId: d._id, orgId: req.user.orgId, type: "needs_action", title: "Extension Request",
    message: `Manager asks +${decision.days} day(s) on project "${project.title}".`, meta: { extensionRequestId: ext._id, projectId: project._id } })));
  await AuditLog.create({ action: "extension_requested", orgId: org._id, performedBy: req.user.id, targetProjectId: project._id, projectTitle: project.title, scope: "extension",
    detail: `Project extension of ${decision.days} day(s) sent to the Director (${decision.reasons.join(" ")}): ${reason}` });
  res.status(201).json({ applied: false, extension: ext, reasons: decision.reasons });
}
