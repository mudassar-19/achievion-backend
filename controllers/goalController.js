import Goal         from "../models/Goal.js";
import Task         from "../models/Task.js";
import Project      from "../models/Project.js";
import Organization from "../models/Organization.js";
import AuditLog     from "../models/AuditLog.js";
import mongoose     from "mongoose";

const IS_OID   = /^[0-9a-f]{24}$/i;
const orgFilter = (orgId) => IS_OID.test(orgId) ? { _id: orgId } : { orgId };

// ── Progress calculator ───────────────────────────────────────────────────────
async function calcProgress(goal) {
  const { orgId, metric, linkedProjectIds, period } = goal;

  // Parse period to date range
  let from, to;
  const now = new Date();
  if (/^\d{4}$/.test(period)) {
    from = new Date(`${period}-01-01`);
    to   = new Date(`${period}-12-31T23:59:59.999Z`);
  } else if (/^\d{4}-Q[1-4]$/.test(period)) {
    const [year, q] = period.split("-Q");
    const startMonth = (parseInt(q) - 1) * 3;
    from = new Date(Date.UTC(parseInt(year), startMonth,    1));
    to   = new Date(Date.UTC(parseInt(year), startMonth + 3, 0, 23, 59, 59, 999));
  } else if (/^\d{4}-\d{2}$/.test(period)) {
    const [year, month] = period.split("-").map(Number);
    from = new Date(Date.UTC(year, month - 1, 1));
    to   = new Date(Date.UTC(year, month,     0, 23, 59, 59, 999));
  } else {
    return 0;
  }

  const projectFilter = linkedProjectIds?.length
    ? { orgId, _id: { $in: linkedProjectIds } }
    : { orgId };

  if (metric === "projects_done") {
    const count = await Project.countDocuments({
      ...projectFilter,
      status: "Completed",
      updatedAt: { $gte: from, $lte: to },
    });
    return count;
  }

  const taskFilter = {
    orgId,
    ...(linkedProjectIds?.length ? { projectId: { $in: linkedProjectIds } } : {}),
    completedAt: { $gte: from, $lte: to },
  };

  if (metric === "on_time_pct") {
    const [onTime, total] = await Promise.all([
      Task.countDocuments({ ...taskFilter, $expr: { $lte: ["$completedAt", "$deadline"] } }),
      Task.countDocuments(taskFilter),
    ]);
    return total > 0 ? Math.round((onTime / total) * 100) : 0;
  }

  if (metric === "quality") {
    const tasks = await Task.find({ ...taskFilter, qualityScore: { $ne: null } }, "qualityScore").lean();
    if (!tasks.length) return 0;
    const mean = tasks.reduce((s, t) => s + t.qualityScore, 0) / tasks.length;
    return Math.round(((mean - 1) / 4) * 100);
  }

  return 0;
}

// ── GET /api/director/goals ───────────────────────────────────────────────────
// Auto-recalculates live progress on every call (KI-003 fix)
export async function listGoals(req, res) {
  const { orgId } = req.user;
  const goals = await Goal.find({ orgId, status: { $ne: "archived" } })
    .sort({ createdAt: -1 })
    .populate("linkedProjectIds", "title status")
    .lean();

  // Compute live progress for each goal and persist if changed
  const updated = await Promise.all(goals.map(async (g) => {
    const live = await calcProgress(g);
    let newStatus = g.status;
    if (g.status !== "archived") {
      if (live >= g.targetValue) newStatus = "achieved";
      else if (live < g.targetValue * 0.6) newStatus = "behind";
      else newStatus = "on_track";
    }
    if (live !== g.currentValue || newStatus !== g.status) {
      await Goal.updateOne({ _id: g._id }, { $set: { currentValue: live, status: newStatus } });
    }
    return { ...g, currentValue: live, status: newStatus };
  }));

  res.json({ goals: updated });
}

// ── POST /api/director/goals ──────────────────────────────────────────────────
export async function createGoal(req, res) {
  const { orgId, id: userId } = req.user;
  const { title, metric, targetValue, period, linkedProjectIds, visibleTo, isTeamQuest } = req.body ?? {};

  if (!title?.trim() || !metric || !targetValue || !period)
    return res.status(400).json({ error: "title, metric, targetValue, period required." });

  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  const goal = await Goal.create({
    orgId, title: title.trim(), metric, targetValue, period,
    linkedProjectIds: linkedProjectIds ?? [],
    visibleTo: visibleTo ?? "managers",
    isTeamQuest: isTeamQuest ?? false,
    createdBy: new mongoose.Types.ObjectId(userId),
  });

  await AuditLog.create({
    action:      "goal_created",
    orgId:       org._id,
    performedBy: new mongoose.Types.ObjectId(userId),
    detail:      `Goal "${goal.title}" created (metric: ${metric}, target: ${targetValue})`,
    scope:       "org",
  });

  res.status(201).json({ goal });
}

// ── PATCH /api/director/goals/:id  — edit or archive ─────────────────────────
export async function updateGoal(req, res) {
  const { orgId, id: userId } = req.user;
  const goal = await Goal.findById(req.params.id).lean();
  if (!goal || goal.orgId !== orgId) return res.status(404).json({ error: "Goal not found." });
  if (goal.status === "archived") return res.status(409).json({ error: "Goal is archived." });

  const { title, targetValue, visibleTo, linkedProjectIds, action } = req.body ?? {};
  const update = {};

  const oldTarget = goal.targetValue;
  if (title?.trim())        update.title    = title.trim();
  if (targetValue != null)  update.targetValue = targetValue;
  if (visibleTo)            update.visibleTo = visibleTo;
  if (linkedProjectIds)     update.linkedProjectIds = linkedProjectIds;

  let auditAction = null;
  if (action === "archive") {
    update.status     = "archived";
    update.archivedAt = new Date();
    auditAction       = "goal_created"; // reuse, spec says only create/close/target
  }

  const updated = await Goal.findByIdAndUpdate(goal._id, { $set: update }, { new: true });

  // AuditLog only on target change (D-022c analogy)
  if (targetValue != null && targetValue !== oldTarget) {
    await AuditLog.create({
      action:      "goal_created",
      orgId:       goal.orgId,
      performedBy: new mongoose.Types.ObjectId(userId),
      detail:      `Goal "${goal.title}" target changed`,
      before:      { targetValue: oldTarget },
      after:       { targetValue },
      scope:       "org",
    });
  }

  res.json({ goal: updated });
}

// ── POST /api/director/goals/:id/recalculate  — compute live progress ─────────
export async function recalculateGoal(req, res) {
  const { orgId, id: userId } = req.user;
  const goal = await Goal.findById(req.params.id).lean();
  if (!goal || goal.orgId !== orgId) return res.status(404).json({ error: "Goal not found." });

  const newValue = await calcProgress(goal);
  let newStatus = "on_track";
  if (newValue >= goal.targetValue) newStatus = "achieved";
  else if (newValue < goal.targetValue * 0.6) newStatus = "behind";

  const wasAchieved = goal.status !== "achieved" && newStatus === "achieved";
  const updated = await Goal.findByIdAndUpdate(
    goal._id,
    { $set: { currentValue: newValue, status: newStatus } },
    { new: true }
  );

  if (wasAchieved) {
    await AuditLog.create({
      action:      "goal_achieved",
      orgId:       goal.orgId,
      performedBy: new mongoose.Types.ObjectId(userId),
      detail:      `Goal "${goal.title}" achieved (${newValue}/${goal.targetValue})`,
      scope:       "org",
    });
  }

  res.json({ goal: updated, wasAchieved });
}

// ── GET /api/manager/goals  — Manager read-only ───────────────────────────────
export async function listManagerGoals(req, res) {
  const { orgId } = req.user;
  const goals = await Goal.find({
    orgId,
    status: { $ne: "archived" },
    visibleTo: { $in: ["managers", "all"] },
  })
    .sort({ createdAt: -1 })
    .lean();
  res.json({ goals });
}
