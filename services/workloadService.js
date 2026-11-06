/**
 * WorkloadService — Core Operational Intelligence Engine
 *
 * Calculates real-time employee workload, daily capacity utilisation,
 * validates task assignment feasibility, enforces role eligibility,
 * and generates health scores used across the entire platform.
 */

import mongoose from "mongoose";
import Task     from "../models/Task.js";
import User     from "../models/User.js";
import Project  from "../models/Project.js";
import GamificationProfile from "../models/GamificationProfile.js";
import Organization from "../models/Organization.js";
import {
  WORKLOAD_TIERS, countWorkingDays, dailyHoursForTask, defaultHoursByDifficulty,
  workloadTier, utilisationPct, orgWorkTime, DEFAULT_HOURS_PER_DAY,
} from "./workloadRules.js";

// Re-exported for existing callers; rules live in workloadRules.js (unit-tested).
export { WORKLOAD_TIERS, countWorkingDays };

const IS_OID = /^[0-9a-f]{24}$/i;
// Director Settings → Working Time for this org (hours/day, working days).
export async function loadOrgWorkTime(orgId) {
  if (!orgId) return orgWorkTime(null);
  const id  = String(orgId);
  const org = await Organization.findOne(IS_OID.test(id) ? { _id: id } : { orgId: id }, "workingTime").lean();
  return orgWorkTime(org);
}

// ── Constants ──────────────────────────────────────────────────────────────────
export const STANDARD_DAILY_HOURS  = DEFAULT_HOURS_PER_DAY; // fallback only; real value = org.workingTime.hoursPerDay
export const ACTIVE_TASK_STATUSES  = ["To-Do", "In-Progress", "In-Review"];

// Role → eligible task types mapping (role category level)
export const ROLE_TASK_ELIGIBILITY = {
  developer:  ["Feature", "Bug", "DevOps", "Documentation"],
  designer:   ["Design", "Documentation"],
  tester:     ["Testing", "Bug", "Documentation"],
  team_lead:  ["Feature", "Bug", "Design", "Testing", "DevOps", "Documentation"],
  manager:    ["Feature", "Bug", "Design", "Testing", "DevOps", "Documentation"],
  any:        ["Feature", "Bug", "Design", "Testing", "DevOps", "Documentation"],
};

// Role category map (matches User.js ROLE_CATEGORY_MAP for employee tiers)
export const ROLE_TO_CATEGORY = {
  // ── Canonical roles (current architecture) ──────────────────────────────
  "Developer":         "developer",
  "Senior Developer":  "developer",
  "Junior Developer":  "developer",
  "Designer":          "designer",
  "Senior Designer":   "designer",
  "Junior Designer":   "designer",
  "Tester":            "tester",
  "Senior Tester":     "tester",
  "Junior Tester":     "tester",
  "Team Lead":         "team_lead",
  "Manager":           "manager",
  "Director":          "director",
  // ── Legacy milestone role names (backwards-compat for old DB records) ───
  "Frontend Dev":      "developer",
  "Backend Dev":       "developer",
  "Full-Stack Dev":    "developer",
  "Frontend Developer":"developer",
  "Backend Developer": "developer",
  "Full Stack Developer": "developer",
  "QA / Tester":       "tester",
  "QA Tester":         "tester",
  "QA Engineer":       "tester",
  "UI Designer":       "designer",
  "UX Designer":       "designer",
  "DevOps":            "developer",
  "DevOps Engineer":   "developer",
};

// ── Core: compute single employee capacity snapshot ───────────────────────────
/**
 * Returns a full workload snapshot for one employee.
 *
 * @param {string|ObjectId} userId
 * @param {object} [opts]
 * @param {number} [opts.dailyHours]  - override standard daily hours
 * @returns {Promise<WorkloadSnapshot>}
 */
const SNAP_USER_FIELDS = "name role department orgId status";
const SNAP_TASK_FIELDS = "title estimatedHours difficulty priority status startDate deadline endDate milestoneId projectId assignee assignees";

export async function getEmployeeWorkloadSnapshot(userId, opts = {}) {
  const uid       = new mongoose.Types.ObjectId(userId);

  const [user, activeTasks, profile] = await Promise.all([
    User.findById(uid, SNAP_USER_FIELDS).lean(),
    Task.find(
      { $or: [{ assignee: uid }, { assignees: uid }], status: { $in: ACTIVE_TASK_STATUSES } },
      SNAP_TASK_FIELDS
    ).lean(),
    GamificationProfile.findOne({ userId: uid }, "hp level currentXp").lean(),
  ]);

  if (!user) return null;
  const workTime = opts.workTime ?? await loadOrgWorkTime(user.orgId);
  return buildSnapshot(user, activeTasks, profile, workTime, opts);
}

// Pure assembly from already-loaded rows (shared by the single and bulk paths).
function buildSnapshot(user, activeTasks, profile, workTime, opts = {}) {
  const uid = user._id;
  const stdHours = opts.dailyHours ?? workTime.hoursPerDay;
  const now      = new Date();

  // Sum DAILY-distributed hours from active tasks (total hours ÷ task duration in working days)
  // This prevents a multi-day task from inflating a single day's utilisation.
  const allocatedHours = activeTasks.reduce(
    (sum, t) => sum + dailyHoursForTask(t, now, workTime.workingDays),
    0
  );

  // Allow >100 % so genuine overload is visible, not silently capped
  const utilisation     = utilisationPct(allocatedHours, stdHours);
  const availableHours  = Math.max(0, Math.round((stdHours - allocatedHours) * 10) / 10);
  const tier            = workloadTier(utilisation);
  const burnoutRisk     = _burnoutRisk(utilisation, profile?.hp ?? 100, activeTasks);
  const roleCategory    = ROLE_TO_CATEGORY[user.role] ?? "developer";

  return {
    userId:         uid,
    name:           user.name,
    role:           user.role,
    roleCategory,
    department:     user.department,
    status:         user.status,

    // Capacity
    dailyCapacityHours: stdHours,
    workingDays:        workTime.workingDays,
    allocatedHours:     Math.round(allocatedHours * 10) / 10,
    availableHours,
    utilisation,              // 0–100 %

    // Tier
    workloadTier:   tier.label,
    workloadColor:  tier.color,

    // Gamification health
    hp:             profile?.hp    ?? 100,
    level:          profile?.level ?? 1,

    // Risk
    burnoutRisk,              // "Low" | "Moderate" | "High" | "Critical"
    activeTaskCount: activeTasks.length,
    activeTasks:    activeTasks.map((t) => ({
      id:             t._id,
      title:          t.title,
      estimatedHours: t.estimatedHours ?? defaultHoursByDifficulty(t.difficulty ?? "Medium"),
      difficulty:     t.difficulty ?? "Medium",
      priority:       t.priority,
      status:         t.status,
      deadline:       t.deadline,
    })),
  };
}

// ── Bulk: org-wide or project-scoped workload ─────────────────────────────────
/**
 * Returns workload snapshots for a list of userIds, in parallel.
 */
// Perf (D-078): 3 queries for the whole list instead of 3 per user (N+1).
export async function getBulkWorkloadSnapshots(userIds, opts = {}) {
  if (!userIds?.length) return [];
  const uids = userIds.map((id) => new mongoose.Types.ObjectId(id));
  const [users, tasks, profiles] = await Promise.all([
    User.find({ _id: { $in: uids } }, SNAP_USER_FIELDS).lean(),
    Task.find({ $or: [{ assignee: { $in: uids } }, { assignees: { $in: uids } }], status: { $in: ACTIVE_TASK_STATUSES } }, SNAP_TASK_FIELDS).lean(),
    GamificationProfile.find({ userId: { $in: uids } }, "userId hp level currentXp").lean(),
  ]);
  const workTime = opts.workTime ?? await loadOrgWorkTime(users[0]?.orgId); // bulk calls are always one org
  const userMap = new Map(users.map((u) => [String(u._id), u]));
  const profMap = new Map(profiles.map((p) => [String(p.userId), p]));
  const tasksBy = new Map(uids.map((u) => [String(u), []]));
  for (const t of tasks) {
    const owners = new Set([t.assignee, ...(t.assignees ?? [])].filter(Boolean).map(String));
    for (const o of owners) tasksBy.get(o)?.push(t);
  }
  return uids.map((u) => {
    const user = userMap.get(String(u));
    return user ? buildSnapshot(user, tasksBy.get(String(u)), profMap.get(String(u)), workTime, opts) : null;
  }).filter(Boolean);
}

// ── Validate task assignment ──────────────────────────────────────────────────
/**
 * Validates whether a task can be assigned to an employee.
 * Returns { ok, warnings, errors, snapshot }.
 */
export async function validateTaskAssignment({ assigneeId, estimatedHours, taskType, difficulty, deadline, orgId }) {
  const snapshot = await getEmployeeWorkloadSnapshot(assigneeId);
  if (!snapshot) return { ok: false, errors: ["Assignee not found"], warnings: [], snapshot: null };

  const errors   = [];
  const warnings = [];

  // ── Role eligibility check ─────────────────────────────────────────────
  if (taskType) {
    const eligible = ROLE_TASK_ELIGIBILITY[snapshot.roleCategory] ?? ROLE_TASK_ELIGIBILITY.any;
    if (!eligible.includes(taskType)) {
      errors.push(
        `${snapshot.role} is not eligible for "${taskType}" tasks. Eligible types: ${eligible.join(", ")}.`
      );
    }
  }

  // ── Capacity check (daily-distribution model) ────────────────────────
  // Compute how many hours/day this task contributes based on its deadline.
  // If no deadline is given we treat it as a 1-day task (worst-case).
  const totalHours = estimatedHours ?? defaultHoursByDifficulty(difficulty);
  let   dailyContrib = totalHours;
  let   taskWorkingDays = 1;
  if (deadline) {
    taskWorkingDays = Math.max(1, countWorkingDays(new Date(), new Date(deadline), snapshot.workingDays));
    dailyContrib    = totalHours / taskWorkingDays;
  }

  if (dailyContrib > snapshot.availableHours) {
    if (dailyContrib > snapshot.dailyCapacityHours) {
      warnings.push(
        `Task requires ~${dailyContrib.toFixed(1)}h/day but ${snapshot.name}'s full daily capacity is only ${snapshot.dailyCapacityHours}h.`
      );
    } else {
      warnings.push(
        `${snapshot.name} has ${snapshot.availableHours}h free today but this task needs ~${dailyContrib.toFixed(1)}h/day. They will exceed daily capacity.`
      );
    }
  }

  // ── Overload tier warnings ─────────────────────────────────────────────
  const projectedUtil = snapshot.dailyCapacityHours > 0
    ? Math.round(((snapshot.allocatedHours + dailyContrib) / snapshot.dailyCapacityHours) * 100)
    : 100;
  const projectedTier = workloadTier(projectedUtil);

  if (projectedTier.label === "Critical Overload") {
    errors.push(`Assigning this task will push ${snapshot.name} into Critical Overload (${projectedUtil}% daily capacity).`);
  } else if (projectedTier.label === "Busy") {
    warnings.push(`${snapshot.name} will be fully booked (${projectedUtil}% daily capacity) after this assignment.`);
  }

  // ── HP critical warning ────────────────────────────────────────────────
  if (snapshot.hp <= 20) {
    warnings.push(`${snapshot.name}'s HP is critically low (${snapshot.hp}/100). Assigning more work risks burnout.`);
  }

  // ── Deadline feasibility check ─────────────────────────────────────────
  if (deadline) {
    const totalCapacity = taskWorkingDays * snapshot.availableHours;
    if (totalHours > totalCapacity) {
      warnings.push(
        `With ${snapshot.availableHours}h/day free, completing ${totalHours}h over ${taskWorkingDays} working days is infeasible.`
      );
    }
  }

  const ok = errors.length === 0;
  return { ok, errors, warnings, snapshot, projectedUtilisation: projectedUtil, projectedTier: projectedTier.label };
}

// ── Validate milestone capacity ───────────────────────────────────────────────
/**
 * Checks if the team assigned to a milestone can realistically deliver it.
 * Returns { feasible, totalRequiredHours, totalAvailableHours, warnings, memberBreakdown }.
 */
export async function validateMilestoneCapacity({ milestoneId, memberIds, startDate, dueDate, orgId }) {
  if (!memberIds?.length) {
    return { feasible: false, warnings: ["No team members assigned to this milestone."], memberBreakdown: [] };
  }

  // Working days between dates (Mon–Fri only)
  const workTime    = await loadOrgWorkTime(orgId);
  const workingDays = countWorkingDays(startDate ? new Date(startDate) : new Date(), new Date(dueDate), workTime.workingDays);

  // Get all tasks in this milestone that have estimated hours
  const milestoneTasks = milestoneId
    ? await Task.find({ milestoneId, status: { $nin: ["Done"] } }, "estimatedHours difficulty assignee").lean()
    : [];

  const totalRequiredHours = milestoneTasks.reduce(
    (s, t) => s + (t.estimatedHours ?? defaultHoursByDifficulty(t.difficulty ?? "Medium")), 0
  );

  // Get member snapshots
  const snapshots   = await getBulkWorkloadSnapshots(memberIds, { workTime });
  const totalFreeH  = snapshots.reduce((s, snap) => s + snap.availableHours * workingDays, 0);

  const warnings = [];
  if (totalRequiredHours > totalFreeH) {
    warnings.push(
      `Milestone requires ${Math.round(totalRequiredHours)}h but team has only ${Math.round(totalFreeH)}h available over ${workingDays} working days.`
    );
  }

  const overloaded = snapshots.filter((s) => s.workloadTier === "Critical Overload");
  if (overloaded.length > 0) {
    warnings.push(`${overloaded.length} team member(s) are already at Critical Overload: ${overloaded.map((s) => s.name).join(", ")}.`);
  }

  return {
    feasible:            totalRequiredHours <= totalFreeH,
    workingDays,
    totalRequiredHours:  Math.round(totalRequiredHours * 10) / 10,
    totalAvailableHours: Math.round(totalFreeH * 10) / 10,
    warnings,
    memberBreakdown:     snapshots.map((s) => ({
      userId:          s.userId,
      name:            s.name,
      role:            s.role,
      availableHoursPerDay: s.availableHours,
      totalAvailableHours:  Math.round(s.availableHours * workingDays * 10) / 10,
      workloadTier:    s.workloadTier,
      workloadColor:   s.workloadColor,
      activeTaskCount: s.activeTaskCount,
    })),
  };
}

// ── Smart assignment suggestions ──────────────────────────────────────────────
/**
 * Returns sorted list of eligible employees for a task (least loaded first).
 */
export async function getSmartAssignmentSuggestions({ orgId, taskType, estimatedHours, difficulty, milestoneId, limit = 5 }) {
  // Get all active employees in org (excluding management)
  const employees = await User.find(
    { orgId, status: "active", role: { $nin: ["Director", "Manager", "Team Lead"] } },
    "_id name role department"
  ).lean();

  if (!employees.length) return [];

  const snapshots = await getBulkWorkloadSnapshots(employees.map((e) => e._id));
  const hours     = estimatedHours ?? defaultHoursByDifficulty(difficulty ?? "Medium");

  // Filter by role eligibility
  const eligible = snapshots.filter((s) => {
    if (!taskType) return true;
    const allowed = ROLE_TASK_ELIGIBILITY[s.roleCategory] ?? [];
    return allowed.includes(taskType);
  });

  // Sort: available hours DESC, then utilisation ASC
  eligible.sort((a, b) => {
    if (b.availableHours !== a.availableHours) return b.availableHours - a.availableHours;
    return a.utilisation - b.utilisation;
  });

  return eligible.slice(0, limit).map((s) => ({
    userId:          s.userId,
    name:            s.name,
    role:            s.role,
    department:      s.department,
    availableHours:  s.availableHours,
    utilisation:     s.utilisation,
    workloadTier:    s.workloadTier,
    workloadColor:   s.workloadColor,
    activeTaskCount: s.activeTaskCount,
    hp:              s.hp,
    canHandle:       s.availableHours >= hours,
  }));
}

// ── Org-wide workload health report ──────────────────────────────────────────
/**
 * Returns health scores and risk flags for the entire org's workforce.
 */
export async function getOrgWorkloadHealth(orgId) {
  // Team Lead is excluded — they are a supervisor, not a capacity unit
  const employees = await User.find(
    { orgId, status: "active", role: { $nin: ["Director", "Manager", "Team Lead"] } },
    "_id name role department"
  ).lean();

  if (!employees.length) return { members: [], summary: _emptySummary() };

  const snapshots = await getBulkWorkloadSnapshots(employees.map((e) => e._id));

  const summary = {
    total:           snapshots.length,
    free:            snapshots.filter((s) => s.workloadTier === "Free").length,
    moderate:        snapshots.filter((s) => s.workloadTier === "Moderate Load").length,
    high:            snapshots.filter((s) => s.workloadTier === "Busy").length,
    critical:        snapshots.filter((s) => s.workloadTier === "Critical Overload").length,
    avgUtilisation:  snapshots.length
      ? Math.round(snapshots.reduce((s, m) => s + m.utilisation, 0) / snapshots.length)
      : 0,
    avgHp: snapshots.length
      ? Math.round(snapshots.reduce((s, m) => s + m.hp, 0) / snapshots.length)
      : 100,
    burnoutRiskCount: snapshots.filter((s) => s.burnoutRisk === "High" || s.burnoutRisk === "Critical").length,
  };

  return {
    members: snapshots.map((s) => ({
      userId:         s.userId,
      name:           s.name,
      role:           s.role,
      department:     s.department,
      allocatedHours: s.allocatedHours,
      availableHours: s.availableHours,
      utilisation:    s.utilisation,
      workloadTier:   s.workloadTier,
      workloadColor:  s.workloadColor,
      activeTaskCount:s.activeTaskCount,
      hp:             s.hp,
      level:          s.level,
      burnoutRisk:    s.burnoutRisk,
    })),
    summary,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────
function _burnoutRisk(utilisation, hp, activeTasks) {
  const overdueTasks = activeTasks.filter(
    (t) => t.deadline && new Date(t.deadline) < new Date() && t.status !== "Done"
  ).length;

  const riskScore = (utilisation > 85 ? 2 : utilisation > 65 ? 1 : 0)
    + (hp <= 20 ? 2 : hp <= 40 ? 1 : 0)
    + (overdueTasks >= 2 ? 2 : overdueTasks === 1 ? 1 : 0);

  if (riskScore >= 5) return "Critical";
  if (riskScore >= 3) return "High";
  if (riskScore >= 1) return "Moderate";
  return "Low";
}

function _emptySummary() {
  return { total: 0, free: 0, moderate: 0, high: 0, critical: 0, avgUtilisation: 0, avgHp: 100, burnoutRiskCount: 0 };
}
