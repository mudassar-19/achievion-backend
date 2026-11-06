import Project   from "../models/Project.js";
import { firstLengthError } from "../services/textLimits.js";
import Milestone from "../models/Milestone.js";
import Task      from "../models/Task.js";
import AuditLog  from "../models/AuditLog.js";
import Organization from "../models/Organization.js";
import { healthForProjects } from "../services/projectHealthService.js";
import User from "../models/User.js";
import { setupState, activationBlockers, NOT_MEMBER_ROLES } from "../services/projectSetupRules.js";

// Setup progress of one project: modules (with their Team Lead) + members who are not module leads.
export async function setupFor(project) {
  const [mods, memberCount] = await Promise.all([
    Milestone.find({ projectId: project._id }, "teamLeadId").lean(),
    User.countDocuments({ _id: { $in: (project.members ?? []).map((m) => m?._id ?? m) }, role: { $nin: NOT_MEMBER_ROLES } }),
  ]);
  const input = { modules: mods.map((m) => ({ teamLeadId: m.teamLeadId })), memberCount };
  return { ...setupState(input), input };
}

const IS_OID = /^[0-9a-f]{24}$/i;
function orgFilter(id) {
  return IS_OID.test(id ?? "") ? { _id: id } : { orgId: id };
}

// Build the $or orgId query for project lookups.
async function resolveOrgQuery(orgId) {
  const org = await Organization.findOne(orgFilter(orgId), "_id orgId").lean();
  if (!org) return null;
  const ids = [org._id.toString()];
  if (org.orgId) ids.push(org.orgId);
  const filter = ids.length === 1
    ? { orgId: ids[0] }
    : { $or: ids.map((id) => ({ orgId: id })) };
  return { org, filter };
}

const VALID_STATUSES = [
  "Planning", "Scheduled", "Active",
  "On Hold",  "Delayed",   "In Review",
  "Completed","Archived",  "Frozen",   "Deleted",
];

// ── GET /api/manager/projects/:id ─────────────────────────────────────────────
export async function getProjectById(req, res) {
  const { orgId, id: userId } = req.user;
  const resolved = await resolveOrgQuery(orgId);
  if (!resolved) return res.status(404).json({ error: "Organization not found." });
  const { filter } = resolved;

  const project = await Project.findOne({ _id: req.params.id, ...filter })
    .populate("director",  "name email role avatarSeed")
    .populate("managerId", "name email role avatarSeed")
    .populate("members",   "name email role avatarSeed")
    .lean();

  if (!project) return res.status(404).json({ error: "Project not found." });

  const now = new Date();
  const [milestones, healthMap] = await Promise.all([
    Milestone.find({ projectId: project._id }).sort({ order: 1 }).lean(),
    healthForProjects([project], now), // computed health + task counts (D-077)
  ]);
  const health = healthMap.get(String(project._id));
  const tc = health.byStatus;
  const { total, done } = health;

  return res.json({
    ...project,
    healthScore: health.score, // computed on read (D-077)
    healthBand:  health.band,
    setup:       ["Planning", "Scheduled"].includes(project.status) ? (await setupFor({ ...project, _id: project._id })).steps : null, // U-1 "Needs setup"
    milestones,
    taskCounts: {
      backlog:    tc["Backlog"]     ?? 0,
      todo:       tc["To-Do"]       ?? 0,
      inProgress: tc["In-Progress"] ?? 0,
      inReview:   tc["In-Review"]   ?? 0,
      done,
      total,
    },
    completion: total > 0 ? Math.round((done / total) * 100) : 0,
  });
}

// PATCH /api/manager/projects/:id (edit) lives in managerProjectsController.editProject (M-2: deadline via extension only).

// ── PATCH /api/manager/projects/:id/status ────────────────────────────────────
export async function updateProjectStatus(req, res) {
  const { orgId, id: userId } = req.user;
  const { status, note = "" } = req.body ?? {};

  if (!VALID_STATUSES.includes(status))
    return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(", ")}.` });

  const resolved = await resolveOrgQuery(orgId);
  if (!resolved) return res.status(404).json({ error: "Organization not found." });
  const { org, filter } = resolved;

  // U-1 (D-132): Planning → Active only once the project is set up (≥1 module with a Team Lead, ≥1 member).
  if (status === "Active") {
    const cur = await Project.findOne({ _id: req.params.id, ...filter }, "status members").lean();
    if (!cur) return res.status(404).json({ error: "Project not found." });
    if (["Planning", "Scheduled"].includes(cur.status)) {
      const st = await setupFor(cur);
      if (!st.complete) return res.status(409).json({ error: `This project is not set up yet. ${activationBlockers(st.input).join(" ")}`, code: "needs_setup", blockers: activationBlockers(st.input) });
    }
  }

  const historyEntry = { status, changedAt: new Date(), changedBy: userId, note };

  const project = await Project.findOneAndUpdate(
    { _id: req.params.id, ...filter },
    {
      $set:  { status, ...(status === "Archived" ? { archivedAt: new Date() } : {}) },
      $push: { statusHistory: historyEntry },
    },
    { returnDocument: "after" }
  ).lean();

  if (!project) return res.status(404).json({ error: "Project not found." });

  AuditLog.create({
    action:          "project_status_changed",
    orgId:           org._id,
    performedBy:     userId,
    targetProjectId: project._id,
    projectTitle:    project.title,
    detail:          `Status changed to "${status}".${note ? ` Note: ${note}` : ""}`,
  }).catch(() => {});

  return res.json({ success: true, status: project.status, statusHistory: project.statusHistory });
}

// ── GET /api/manager/projects/:id/milestones ──────────────────────────────────
export async function getMilestones(req, res) {
  const { orgId } = req.user;
  const resolved  = await resolveOrgQuery(orgId);
  if (!resolved) return res.json([]);
  const { filter } = resolved;

  const project = await Project.findOne({ _id: req.params.id, ...filter }, "_id").lean();
  if (!project) return res.status(404).json({ error: "Project not found." });

  const milestones = await Milestone.find({ projectId: project._id }).sort({ order: 1 }).lean();
  return res.json(milestones);
}

// ── POST /api/manager/projects/:id/milestones ─────────────────────────────────
export async function createMilestone(req, res) {
  const { orgId, id: userId } = req.user;
  const { title, description = "", notes = "", startDate, dueDate, order = 0 } = req.body ?? {};
  // M-2: role mix (work types) per module; only known roles are kept.
  const activeRoles = (Array.isArray(req.body?.activeRoles) ? req.body.activeRoles : []).filter((r) => ["Team Lead", "Developer", "Designer", "Tester"].includes(r));

  if (!title?.trim()) return res.status(400).json({ error: "Milestone title is required." });
  const tooLong = firstLengthError([["Module name", title, "name"], ["Description", description, "description"]]);
  if (tooLong) return res.status(400).json({ error: tooLong });

  const resolved = await resolveOrgQuery(orgId);
  if (!resolved) return res.status(404).json({ error: "Organization not found." });
  const { org, filter } = resolved;

  const project = await Project.findOne({ _id: req.params.id, ...filter }, "_id orgId").lean();
  if (!project) return res.status(404).json({ error: "Project not found." });

  const milestone = await Milestone.create({
    title:       title.trim(),
    description: description.trim(),
    notes:       notes.trim(),
    projectId:   project._id,
    orgId:       project.orgId,
    startDate:   startDate ? new Date(startDate) : null,
    dueDate:     dueDate   ? new Date(dueDate)   : null,
    createdBy:   userId,
    activeRoles,
    order,
  });

  return res.status(201).json(milestone);
}

// ── PATCH /api/manager/projects/:id/milestones/:milestoneId ──────────────────
export async function updateMilestone(req, res) {
  const { orgId } = req.user;
  const { milestoneId } = req.params;

  const allowed = ["title", "description", "notes", "status", "startDate", "dueDate", "progress", "order"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (req.body.status === "Completed") updates.completedAt = new Date();

  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: "No valid fields provided." });
  const tooLong = firstLengthError([["Module name", updates.title, "name"], ["Description", updates.description, "description"]]);
  if (tooLong) return res.status(400).json({ error: tooLong });

  const milestone = await Milestone.findOneAndUpdate(
    { _id: milestoneId, projectId: req.params.id },
    { $set: updates },
    { returnDocument: "after", runValidators: true }
  ).lean();

  if (!milestone) return res.status(404).json({ error: "Milestone not found." });
  return res.json(milestone);
}

// ── DELETE /api/manager/projects/:id/milestones/:milestoneId ─────────────────
export async function deleteMilestone(req, res) {
  const { milestoneId } = req.params;

  const milestone = await Milestone.findOneAndDelete({
    _id: milestoneId, projectId: req.params.id,
  }).lean();

  if (!milestone) return res.status(404).json({ error: "Milestone not found." });
  return res.json({ success: true });
}

// ── POST /api/manager/projects/:id/freeze ────────────────────────────────────
// Manager only. Toggles project freeze state.
export async function freezeProject(req, res) {
  const { orgId, id: userId, role } = req.user;
  if (role !== "Manager") return res.status(403).json({ error: "Only Managers can freeze projects." });

  const { reason = "" } = req.body ?? {};
  const resolved = await resolveOrgQuery(orgId);
  if (!resolved) return res.status(404).json({ error: "Organization not found." });
  const { org, filter } = resolved;

  const project = await Project.findOne({ _id: req.params.id, ...filter, isDeleted: { $ne: true } }).lean();
  if (!project) return res.status(404).json({ error: "Project not found." });

  const now     = new Date();
  const isFrozen = !project.isFrozen; // toggle
  const update  = {};

  if (isFrozen) {
    // Freezing needs a reason (FE-R033); unfreezing needs no payload.
    if (!(reason ?? "").trim()) return res.status(400).json({ error: "A reason is required to freeze a project." });
    update.isFrozen     = true;
    update.frozenAt     = now;
    update.frozenBy     = userId;
    update.freezeReason = (reason ?? "").trim();
    update.status       = "Frozen";
    update.unfrozenAt   = null;
  } else {
    // Unfreezing — extend deadline by freeze duration
    const freezeDurationMs = project.frozenAt ? now - new Date(project.frozenAt) : 0;
    const newTotalFrozen   = (project.totalFrozenMs ?? 0) + freezeDurationMs;
    const previousStatus   = project.statusHistory?.length
      ? project.statusHistory.at(-1)?.status ?? "Active"
      : "Active";
    const resumeStatus     = ["Frozen","Deleted"].includes(previousStatus) ? "Active" : previousStatus;

    update.isFrozen      = false;
    update.unfrozenAt    = now;
    update.totalFrozenMs = newTotalFrozen;
    update.status        = resumeStatus;

    // Extend deadline if set
    if (project.deadline && freezeDurationMs > 0) {
      update.deadline = new Date(new Date(project.deadline).getTime() + freezeDurationMs);
    }
  }

  const historyEntry = {
    status:    update.status,
    changedAt: now,
    changedBy: userId,
    note:      isFrozen ? `Project frozen. Reason: ${reason || "—"}` : "Project unfrozen. Deadline extended by freeze duration.",
  };

  const updated = await Project.findOneAndUpdate(
    { _id: req.params.id, ...filter },
    { $set: update, $push: { statusHistory: historyEntry } },
    { returnDocument: "after" }
  ).lean();

  AuditLog.create({
    action:          isFrozen ? "project_frozen" : "project_unfrozen",
    orgId:           org._id,
    performedBy:     userId,
    targetProjectId: updated._id,
    projectTitle:    updated.title,
    detail:          historyEntry.note,
  }).catch(() => {});

  return res.json({ success: true, isFrozen, project: updated });
}

// ── DELETE /api/manager/projects/:id ─────────────────────────────────────────
// Soft delete — Manager only. Moves to deleted state with audit trail.
export async function deleteProject(req, res) {
  const { orgId, id: userId, role } = req.user;
  if (role !== "Manager") return res.status(403).json({ error: "Only Managers can delete projects." });

  const { reason } = req.body ?? {};
  if (!reason?.trim()) return res.status(400).json({ error: "Deletion reason is required." });

  const resolved = await resolveOrgQuery(orgId);
  if (!resolved) return res.status(404).json({ error: "Organization not found." });
  const { org, filter } = resolved;

  const now = new Date();
  const historyEntry = {
    status:    "Deleted",
    changedAt: now,
    changedBy: userId,
    note:      `Deleted by manager. Reason: ${reason.trim()}`,
  };

  const project = await Project.findOneAndUpdate(
    { _id: req.params.id, ...filter, isDeleted: { $ne: true } },
    {
      $set:  {
        isDeleted:    true,
        deletedAt:    now,
        deletedBy:    userId,
        deleteReason: reason.trim(),
        status:       "Deleted",
      },
      $push: { statusHistory: historyEntry },
    },
    { returnDocument: "after" }
  ).lean();

  if (!project) return res.status(404).json({ error: "Project not found or already deleted." });

  // Pause all non-Done tasks
  await Task.updateMany(
    { projectId: project._id, status: { $ne: "Done" } },
    { $set: { isPaused: true } }
  );

  AuditLog.create({
    action:          "project_deleted",
    orgId:           org._id,
    performedBy:     userId,
    targetProjectId: project._id,
    projectTitle:    project.title,
    detail:          `Project "${project.title}" soft-deleted. Reason: ${reason.trim()}`,
  }).catch(() => {});

  return res.json({ success: true, message: "Project moved to Deleted Projects Log." });
}
