/**
 * WorkloadController — REST API for the Workload Engine
 *
 * Endpoints consumed by Team Lead portal, Manager portal, and Workforce pages.
 */

import mongoose from "mongoose";
import User     from "../models/User.js";
import Task     from "../models/Task.js";
import Milestone from "../models/Milestone.js";
import Project  from "../models/Project.js";
import AuditLog from "../models/AuditLog.js";
import {
  getEmployeeWorkloadSnapshot,
  getBulkWorkloadSnapshots,
  validateTaskAssignment,
  validateMilestoneCapacity,
  getSmartAssignmentSuggestions,
  getOrgWorkloadHealth,
  ROLE_TASK_ELIGIBILITY,
  ROLE_TO_CATEGORY,
} from "../services/workloadService.js";

// ── GET /api/workload/org ─────────────────────────────────────────────────────
// Full org-wide workload health (Manager / Director)
export async function getOrgWorkload(req, res) {
  const { orgId } = req.user;
  const report = await getOrgWorkloadHealth(orgId);
  res.json(report);
}

// ── GET /api/workload/employee/:id ────────────────────────────────────────────
// Single employee snapshot (TL, Manager, Director)
export async function getEmployeeWorkload(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id))
    return res.status(400).json({ error: "Invalid user ID." });

  const snapshot = await getEmployeeWorkloadSnapshot(id);
  if (!snapshot) return res.status(404).json({ error: "Employee not found." });

  // Org guard — requester must be in same org
  const user = await User.findById(id, "orgId").lean();
  if (user?.orgId?.toString() !== req.user.orgId?.toString())
    return res.status(403).json({ error: "Cross-org access denied." });

  res.json(snapshot);
}

// ── POST /api/workload/validate-assignment ────────────────────────────────────
// Validate before assigning a task (TL, Manager)
export async function validateAssignment(req, res) {
  const { assigneeId, estimatedHours, taskType, difficulty, deadline } = req.body;
  if (!assigneeId) return res.status(400).json({ error: "assigneeId is required." });

  const result = await validateTaskAssignment({
    assigneeId,
    estimatedHours: estimatedHours != null ? +estimatedHours : null,
    taskType,
    difficulty,
    deadline,
    orgId: req.user.orgId,
  });

  res.json(result);
}

// ── POST /api/workload/validate-milestone ─────────────────────────────────────
// Check if milestone is feasible given team capacity (TL, Manager)
export async function validateMilestone(req, res) {
  const { milestoneId, memberIds, startDate, dueDate } = req.body;
  if (!dueDate)        return res.status(400).json({ error: "dueDate is required." });
  if (!memberIds?.length) return res.status(400).json({ error: "memberIds array is required." });

  const result = await validateMilestoneCapacity({
    milestoneId,
    memberIds,
    startDate,
    dueDate,
    orgId: req.user.orgId,
  });

  res.json(result);
}

// ── GET /api/workload/suggestions ─────────────────────────────────────────────
// Smart assignment suggestions (TL creating a task)
export async function getSuggestions(req, res) {
  const { taskType, estimatedHours, difficulty, milestoneId, limit = 8 } = req.query;

  const suggestions = await getSmartAssignmentSuggestions({
    orgId:          req.user.orgId,
    taskType,
    estimatedHours: estimatedHours ? +estimatedHours : null,
    difficulty,
    milestoneId,
    limit:          +limit,
  });

  res.json({ suggestions });
}

// ── GET /api/workload/team ────────────────────────────────────────────────────
// Workload for all employees visible to requesting TL (same dept) or Manager (all)
export async function getTeamWorkload(req, res) {
  const { id: userId, orgId, role } = req.user;

  let filter = { orgId, status: "active", role: { $nin: ["Director", "Manager"] } };

  // Team Lead sees only their department
  if (role === "Team Lead") {
    const tl = await User.findById(userId, "department").lean();
    if (tl?.department) filter.department = tl.department;
    filter.role = { $nin: ["Director", "Manager", "Team Lead"] };
  }

  const employees = await User.find(filter, "_id name role department").lean();
  if (!employees.length) return res.json({ members: [], summary: {} });

  const snapshots = await getBulkWorkloadSnapshots(employees.map((e) => e._id));

  // Summary
  const summary = {
    total:            snapshots.length,
    free:             snapshots.filter((s) => s.workloadTier === "Free").length,
    moderate:         snapshots.filter((s) => s.workloadTier === "Moderate Load").length,
    high:             snapshots.filter((s) => s.workloadTier === "Busy").length,
    critical:         snapshots.filter((s) => s.workloadTier === "Critical Overload").length,
    avgUtilisation:   snapshots.length
      ? Math.round(snapshots.reduce((s, m) => s + m.utilisation, 0) / snapshots.length) : 0,
    burnoutRiskCount: snapshots.filter((s) => ["High", "Critical"].includes(s.burnoutRisk)).length,
  };

  res.json({ members: snapshots, summary });
}

// ── GET /api/workload/project/:id/capacity ────────────────────────────────────
// Project member capacity breakdown (Manager, TL)
export async function getProjectCapacity(req, res) {
  const { id: projectId } = req.params;
  const { orgId }         = req.user;

  const project = await Project.findOne(
    { _id: projectId, orgId, isDeleted: { $ne: true } },
    "title members workingHoursPerDay"
  ).lean();
  if (!project) return res.status(404).json({ error: "Project not found." });

  const memberIds = project.members ?? [];
  if (!memberIds.length) return res.json({ members: [], summary: {}, project: project.title });

  // 4.2a: the project's own hours/day if set, else the org's Working Time (no hard-coded 8 h).
  const snapshots = await getBulkWorkloadSnapshots(memberIds, {
    ...(project.workingHoursPerDay ? { dailyHours: project.workingHoursPerDay } : {}),
  });

  const summary = {
    totalMembers:    snapshots.length,
    avgUtilisation:  snapshots.length
      ? Math.round(snapshots.reduce((s, m) => s + m.utilisation, 0) / snapshots.length) : 0,
    overloadedCount: snapshots.filter((s) => s.workloadTier === "Critical Overload").length,
    freeCount:       snapshots.filter((s) => s.workloadTier === "Free").length,
  };

  res.json({ project: project.title, members: snapshots, summary });
}

// ── GET /api/workload/role-eligibility ───────────────────────────────────────
// Returns role → task type eligibility map (used in UI dropdowns)
export async function getRoleEligibility(req, res) {
  res.json({ eligibility: ROLE_TASK_ELIGIBILITY });
}
