import mongoose from "mongoose";
import { reviewAudit } from "./taskController.js";
import { approvalBlock } from "../services/reviewRules.js";
import { sortAlerts } from "../services/teamLeadRules.js";
import { firstLengthError } from "../services/textLimits.js";
import Project   from "../models/Project.js";
import Milestone from "../models/Milestone.js";
import Task      from "../models/Task.js";
import User      from "../models/User.js";
import Sprint    from "../models/Sprint.js";
import GamificationProfile from "../models/GamificationProfile.js";
import XpLog         from "../models/XpLog.js";
import Approval      from "../models/Approval.js";
import Organization  from "../models/Organization.js";
import { createNotification } from "./notificationController.js";
import emitter                from "../utils/emitter.js";
import { awardTLXp, checkTLBadges, checkTLTitles, TL_BADGE_DEFINITIONS, awardTLReviewXp } from "../services/tlGamificationService.js";
import { getIo }              from "../utils/io.js";
import { aiEvalView, finalScore } from "../services/aiEvalService.js";
import { healthForProjects } from "../services/projectHealthService.js";
import { parseTlScore }       from "../services/aiEvalRules.js";
import { getBulkWorkloadSnapshots, ROLE_TO_CATEGORY, ROLE_TASK_ELIGIBILITY, countWorkingDays, loadOrgWorkTime } from "../services/workloadService.js";

// ── Helper: verify TL is a member of the project ─────────────────────────────
async function assertTLProject(projectId, userId, orgId) {
  const project = await Project.findOne({
    _id:       projectId,
    orgId,
    members:   new mongoose.Types.ObjectId(userId),
    isDeleted: { $ne: true },
  }, "_id orgId").lean();
  return project;
}

// ── GET /api/teamlead/review-submissions ──────────────────────────────────────
// Returns all In-Review tasks from the TL's projects, scoped to this org.
export async function getReviewSubmissions(req, res) {
  const { id: userId, orgId } = req.user;

  const myProjects = await Project.find({
    orgId,
    isDeleted: { $ne: true },
    members:   new mongoose.Types.ObjectId(userId),
  }, "_id title").lean();

  const projectIds = myProjects.map((p) => p._id);
  const projectMap = Object.fromEntries(myProjects.map((p) => [p._id.toString(), p.title]));

  const tasks = await Task.find({
    projectId: { $in: projectIds },
    orgId,
    status:    "In-Review",
    isDeleted: { $ne: true },
  })
    .populate("assignee",  "name role department")
    .populate("assignees", "name role department")
    .populate("milestoneId", "title")
    .sort({ submittedAt: -1, updatedAt: -1 })
    .lean();

  res.json({
    submissions: tasks.map((t) => ({
      id:             t._id,
      title:          t.title,
      description:    t.description ?? "",
      type:           t.type,
      priority:       t.priority,
      difficulty:     t.difficulty,
      estimatedHours: t.estimatedHours ?? null,
      qualityScore:   t.qualityScore   ?? null,
      reviewStage:    t.reviewStage    ?? "none",
      submissionNote: t.submissionNote ?? "",
      submissionFiles: (t.submissionFiles ?? []),
      submissionLinks: (t.submissionLinks ?? []),
      aiEvalStatus:    t.aiEval?.status ?? null,
      revisionHistory:  (t.revisionHistory ?? []),
      resubmissionCount: t.resubmissionCount ?? 0,
      maxResubmissions:  t.maxResubmissions  ?? 3,
      submittedAt:    t.submittedAt    ?? t.updatedAt,
      deadline:       t.deadline       ?? null,
      projectId:      t.projectId,
      projectTitle:   projectMap[t.projectId?.toString()] ?? "Unknown Project",
      milestone:      t.milestoneId
        ? { id: t.milestoneId._id, title: t.milestoneId.title }
        : null,
      assignee: t.assignee
        ? { id: t.assignee._id, name: t.assignee.name, role: t.assignee.role }
        : null,
      assignees: (t.assignees ?? []).map((a) => ({
        id: a._id, name: a.name, role: a.role,
      })),
    })),
    total: tasks.length,
  });
}

// ── GET /api/teamlead/review-submissions/:taskId ──────────────────────────────
// Returns a single In-Review task with full relational data for the review screen.
export async function getReviewSubmission(req, res) {
  const { id: userId, orgId } = req.user;

  const myProjects = await Project.find({
    orgId,
    isDeleted: { $ne: true },
    members:   new mongoose.Types.ObjectId(userId),
  }, "_id title").lean();

  const projectIds = myProjects.map((p) => p._id);
  const projectMap = Object.fromEntries(myProjects.map((p) => [p._id.toString(), p.title]));

  const t = await Task.findOne({
    _id:       req.params.taskId,
    projectId: { $in: projectIds },
    orgId,
    status:    "In-Review",
    isDeleted: { $ne: true },
  })
    .populate("assignee",  "name role department")
    .populate("assignees", "name role department")
    .populate("milestoneId", "title")
    .lean();

  if (!t) return res.status(404).json({ error: "Submission not found or not in review." });

  res.json({
    submission: {
      id:             t._id,
      title:          t.title,
      description:    t.description ?? "",
      type:           t.type,
      priority:       t.priority,
      difficulty:     t.difficulty,
      estimatedHours: t.estimatedHours ?? null,
      startDate:      t.startDate      ?? null,
      qualityScore:   t.qualityScore   ?? null,
      reviewStage:    t.reviewStage    ?? "none",
      submissionNote: t.submissionNote ?? "",
      submissionFiles:  (t.submissionFiles  ?? []),
      submissionLinks:  (t.submissionLinks  ?? []),
      submissionContent:   t.submissionContent ?? "",
      submissionChecklist: t.submissionChecklist ?? [],
      aiEval:           aiEvalView(t, false), // feedback only; the AI score appears after the TL scores (spec §4)
      revisionHistory:  (t.revisionHistory  ?? []),
      resubmissionCount: t.resubmissionCount ?? 0,
      maxResubmissions:  t.maxResubmissions  ?? 3,
      submittedAt:    t.submittedAt    ?? t.updatedAt,
      deadline:       t.deadline       ?? null,
      xpValue:        t.xpValue        ?? null,
      projectId:      t.projectId,
      projectTitle:   projectMap[t.projectId?.toString()] ?? "Unknown Project",
      milestone:      t.milestoneId
        ? { id: t.milestoneId._id, title: t.milestoneId.title }
        : null,
      assignee: t.assignee
        ? { id: t.assignee._id, name: t.assignee.name, role: t.assignee.role }
        : null,
      assignees: (t.assignees ?? []).map((a) => ({
        id: a._id, name: a.name, role: a.role,
      })),
    },
  });
}

// ── GET /api/teamlead/projects/:id/milestones ─────────────────────────────────
export async function getMilestones(req, res) {
  const { id: userId, orgId } = req.user;
  const project = await assertTLProject(req.params.id, userId, orgId);
  if (!project) return res.status(404).json({ error: "Project not found." });
  const milestones = await Milestone.find({ projectId: project._id }).sort({ order: 1 }).lean();
  res.json(milestones);
}

// ── POST /api/teamlead/projects/:id/milestones ────────────────────────────────
export async function createMilestone(req, res) {
  const { id: userId, orgId } = req.user;
  const { title, description = "", notes = "", startDate, dueDate, order = 0 } = req.body ?? {};

  if (!title?.trim()) return res.status(400).json({ error: "Milestone title is required." });
  const tooLong = firstLengthError([["Module name", title, "name"], ["Description", description, "description"]]);
  if (tooLong) return res.status(400).json({ error: tooLong });

  const project = await assertTLProject(req.params.id, userId, orgId);
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
    order,
  });

  res.status(201).json(milestone);
}

// ── PATCH /api/teamlead/projects/:id/milestones/:milestoneId ─────────────────
export async function updateMilestone(req, res) {
  const { id: userId, orgId } = req.user;
  const { milestoneId } = req.params;

  const project = await assertTLProject(req.params.id, userId, orgId);
  if (!project) return res.status(404).json({ error: "Project not found." });

  const allowed = ["title", "description", "notes", "status", "startDate", "dueDate", "progress", "order"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (req.body.status === "Completed") updates.completedAt = new Date();

  if (!Object.keys(updates).length) return res.status(400).json({ error: "No valid fields provided." });

  const milestone = await Milestone.findOneAndUpdate(
    { _id: milestoneId, projectId: project._id },
    { $set: updates },
    { returnDocument: "after", runValidators: true }
  ).lean();

  if (!milestone) return res.status(404).json({ error: "Milestone not found." });

  // Award TL XP when milestone is completed
  if (req.body.status === "Completed") {
    const { id: tlUserId } = req.user;
    const wasOnTime = milestone.dueDate ? new Date() <= new Date(milestone.dueDate) : true;
    const statInc   = { milestonesDelivered: 1, ...(wasOnTime ? { milestonesOnTime: 1, consecutiveOnTime: 1 } : { overdueMilestones: 1, consecutiveOnTime: -99 }) };
    // Clamp consecutiveOnTime to 0 if it goes negative (reset on late)
    if (!wasOnTime) {
      await GamificationProfile.updateOne({ userId: tlUserId }, {
        $inc:  { "tlStats.milestonesDelivered": 1, "tlStats.overdueMilestones": 1 },
        $set:  { "tlStats.consecutiveOnTime": 0 },
      });
      await awardTLXp(tlUserId, req.user.orgId, 100, "tl_milestone_delivered", { milestonesDelivered: 0 });
    } else {
      await awardTLXp(tlUserId, req.user.orgId, 100 + 80, "tl_milestone_on_time", { milestonesDelivered: 1, milestonesOnTime: 1, consecutiveOnTime: 1 });
    }
    await checkTLBadges(tlUserId, req.user.orgId);
    await checkTLTitles(tlUserId, req.user.orgId);
  }

  res.json(milestone);
}

// ── DELETE /api/teamlead/projects/:id/milestones/:milestoneId ─────────────────
export async function deleteMilestone(req, res) {
  const { id: userId, orgId } = req.user;
  const { milestoneId } = req.params;

  const project = await assertTLProject(req.params.id, userId, orgId);
  if (!project) return res.status(404).json({ error: "Project not found." });

  const milestone = await Milestone.findOneAndDelete({
    _id: milestoneId, projectId: project._id,
  }).lean();

  if (!milestone) return res.status(404).json({ error: "Milestone not found." });
  res.json({ success: true });
}

// ── GET /api/teamlead/projects ────────────────────────────────────────────────
// Only projects where this TL is in the members array.
export async function getProjects(req, res) {
  const { id: userId, orgId } = req.user;
  const { status, search, sort = "createdAt_desc" } = req.query;

  const filter = {
    orgId,
    isDeleted: { $ne: true },
    members:   new mongoose.Types.ObjectId(userId),
  };
  if (status && status !== "all") filter.status = status;
  if (search) filter.title = { $regex: search, $options: "i" };

  const sortMap = {
    createdAt_desc: { createdAt: -1 },
    createdAt_asc:  { createdAt:  1 },
    deadline_asc:   { deadline:   1 },
    title_asc:      { title:      1 },
  };

  const projects = await Project.find(filter)
    .populate("managerId", "name role")
    .populate("members",   "name role department")
    .sort(sortMap[sort] ?? { createdAt: -1 })
    .lean();

  if (!projects.length) return res.json({ projects: [] });

  const projectIds = projects.map((p) => p._id);
  const [healthMap, milestoneAgg] = await Promise.all([
    healthForProjects(projects), // computed health + task counts by status (D-077)
    Milestone.aggregate([
      { $match: { projectId: { $in: projectIds } } },
      { $group: { _id: { projectId: "$projectId", status: "$status" }, count: { $sum: 1 } } },
    ]),
  ]);

  const taskMap = Object.fromEntries([...healthMap].map(([pid, h]) => [pid, h.byStatus]));

  const msMap = {};
  for (const row of milestoneAgg) {
    const pid = row._id.projectId?.toString();
    if (!pid) continue;
    if (!msMap[pid]) msMap[pid] = { total: 0, completed: 0 };
    msMap[pid].total += row.count;
    if (row._id.status === "Completed") msMap[pid].completed += row.count;
  }

  const result = projects.map((p) => {
    const pid   = p._id.toString();
    const tc    = taskMap[pid] ?? {};
    const ms    = msMap[pid]   ?? { total: 0, completed: 0 };
    const total = Object.values(tc).reduce((s, n) => s + n, 0);
    const done  = tc["Done"] ?? 0;
    return {
      id:          p._id,
      title:       p.title,
      description: p.description  ?? "",
      category:    p.category     ?? "Other",
      status:      p.status,
      priority:    p.priority     ?? "Medium",
      clientName:  p.clientName   ?? "",
      startDate:   p.startDate    ?? null,
      deadline:    p.deadline     ?? null,
      healthScore: healthMap.get(pid)?.score ?? null,
      healthBand:  healthMap.get(pid)?.band ?? null,
      riskLevel:   p.riskLevel    ?? "Low",
      managerId:   p.managerId?._id  ?? null,
      managerName: p.managerId?.name ?? "Unassigned",
      members:     (p.members ?? []).map((m) => ({
        id:         m._id,
        name:       m.name,
        role:       m.role,
        department: m.department,
      })),
      milestones:  ms,
      completion:  total > 0 ? Math.round((done / total) * 100) : 0,
      taskCounts:  {
        backlog:    tc["Backlog"]     ?? 0,
        todo:       tc["To-Do"]       ?? 0,
        inProgress: tc["In-Progress"] ?? 0,
        inReview:   tc["In-Review"]   ?? 0,
        done,
        total,
      },
    };
  });

  res.json({ projects: result });
}

// ── GET /api/teamlead/dashboard ───────────────────────────────────────────────
export async function getDashboard(req, res) {
  const { id: userId, orgId } = req.user;
  const now = new Date();

  const projects = await Project.find({
    orgId,
    isDeleted: { $ne: true },
    members:   new mongoose.Types.ObjectId(userId),
    status:    { $nin: ["Deleted", "Archived"] },
  }).lean();

  const projectIds = projects.map((p) => p._id);

  const [taskStats, milestones, overdueTasks, unassignedTasks] = await Promise.all([
    Task.aggregate([
      { $match: { projectId: { $in: projectIds }, orgId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Milestone.find({ projectId: { $in: projectIds } }).lean(),
    Task.find({
      projectId: { $in: projectIds },
      orgId,
      status:    { $nin: ["Done"] },
      deadline:  { $lt: now, $ne: null },
    })
      .populate("assignee", "name role")
      .sort({ deadline: 1 })
      .limit(10)
      .lean(),
    Task.countDocuments({ projectId: { $in: projectIds }, orgId, assignee: null, assignees: { $size: 0 }, status: { $nin: ["Done"] } }),
  ]);

  const tc = {};
  for (const a of taskStats) tc[a._id] = a.count;

  const delayedMilestones = milestones.filter(
    (m) => m.status === "Delayed" || (m.dueDate && m.dueDate < now && m.status !== "Completed")
  );
  // (unassignedTasks counted in the parallel round above, D-078)

  // Active milestones per project
  const milestonesByProject = {};
  for (const m of milestones) {
    const pid = m.projectId.toString();
    if (!milestonesByProject[pid]) milestonesByProject[pid] = [];
    milestonesByProject[pid].push(m);
  }

  const projectSummaries = projects.map((p) => {
    const pid     = p._id.toString();
    const pMiles  = milestonesByProject[pid] ?? [];
    const active  = pMiles.find((m) => m.status === "In Progress") ?? pMiles[0] ?? null;
    const memberCount = (p.members ?? []).length;
    return {
      id:              p._id,
      title:           p.title,
      status:          p.status,
      deadline:        p.deadline,
      activeMilestone: active ? { title: active.title, status: active.status, progress: active.progress } : null,
      memberCount,
      milestoneCount:  pMiles.length,
    };
  });

  res.json({
    projectSummaries,
    tasks: {
      total:      Object.values(tc).reduce((s, n) => s + n, 0),
      inProgress: tc["In-Progress"] ?? 0,
      inReview:   tc["In-Review"]   ?? 0,
      done:       tc["Done"]        ?? 0,
      overdue:    overdueTasks.length,
    },
    milestones: {
      total:     milestones.length,
      delayed:   delayedMilestones.length,
      completed: milestones.filter((m) => m.status === "Completed").length,
    },
    alerts: {
      overdueCount:     overdueTasks.length,
      delayedMilestones: delayedMilestones.length,
      unassignedTasks,
    },
    overdueTasks: overdueTasks.slice(0, 5).map((t) => ({
      id:       t._id,
      title:    t.title,
      deadline: t.deadline,
      status:   t.status,
      priority: t.priority,
      daysOver: Math.ceil((now - new Date(t.deadline)) / 86_400_000),
      assignee: t.assignee ? { name: t.assignee.name, role: t.assignee.role } : null,
    })),
  });
}

// ── GET /api/teamlead/projects/:id ────────────────────────────────────────────
export async function getProjectDetail(req, res) {
  const { id: userId, orgId } = req.user;

  const project = await Project.findOne({
    _id:       req.params.id,
    orgId,
    members:   new mongoose.Types.ObjectId(userId),
    isDeleted: { $ne: true },
  })
    .populate("managerId", "name role")
    .populate("members",   "name role department")
    .lean();

  if (!project) return res.status(404).json({ error: "Project not found or access denied." });

  const [milestones, healthMap] = await Promise.all([
    Milestone.find({ projectId: project._id }).sort({ order: 1 }).lean(),
    healthForProjects([project]), // computed health + task counts (D-077)
  ]);
  const health = healthMap.get(String(project._id));
  const tc = health.byStatus;
  const { total, done } = health;

  res.json({
    id:          project._id,
    title:       project.title,
    description: project.description ?? "",
    category:    project.category    ?? "Other",
    status:      project.status,
    priority:    project.priority    ?? "Medium",
    clientName:  project.clientName  ?? "",
    startDate:   project.startDate   ?? null,
    deadline:    project.deadline    ?? null,
    healthScore: health?.score ?? null,
    healthBand:  health?.band ?? null,
    riskLevel:   project.riskLevel   ?? "Low",
    managerId:   project.managerId?._id  ?? null,
    managerName: project.managerId?.name ?? "Unassigned",
    members: (project.members ?? []).map((m) => ({
      id:         m._id,
      name:       m.name,
      role:       m.role,
      department: m.department,
    })),
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

// ── GET /api/teamlead/projects/:id/members-workload ───────────────────────────
// Returns project members with GLOBAL workload engine data (not just task counts).
export async function getMembersWorkload(req, res) {
  const { id: userId, orgId } = req.user;

  const project = await Project.findOne({
    _id:       req.params.id,
    orgId,
    members:   new mongoose.Types.ObjectId(userId),
    isDeleted: { $ne: true },
  }, "members").lean();

  if (!project) return res.status(404).json({ error: "Project not found." });

  const memberIds = (project.members ?? []).map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id)
  );

  if (!memberIds.length) return res.json({ members: [] });

  // Use the GLOBAL workload engine — same data source as Availability and Team pages
  const snapshots = await getBulkWorkloadSnapshots(memberIds);

  res.json({
    members: snapshots.map((s) => ({
      id:             s.userId,
      name:           s.name,
      role:           s.role,
      department:     s.department,
      status:         s.status,
      openTasks:      s.activeTaskCount,
      dailyCapacityH: s.dailyCapacityHours,
      allocatedH:     s.allocatedHours,
      remainingH:     s.availableHours,
      workloadTier:   s.workloadTier,
      workloadColor:  s.workloadColor,
      utilisation:    s.utilisation,
      burnoutRisk:    s.burnoutRisk,
      hp:             s.hp,
      level:          s.level,
    })),
  });
}

// ── GET /api/teamlead/tasks ───────────────────────────────────────────────────
// Tasks visible to this TL: all tasks in their assigned projects.
export async function getTasks(req, res) {
  const { id: userId, orgId } = req.user;
  const { status, tab = "all", projectId, milestoneId } = req.query;

  const myProjects = await Project.find({
    orgId,
    isDeleted: { $ne: true },
    members:   new mongoose.Types.ObjectId(userId),
  }, "_id").lean();

  const projectIds = myProjects.map((p) => p._id);


  const filter = { orgId, projectId: { $in: projectIds } };

  if (tab === "created")  filter.createdBy   = new mongoose.Types.ObjectId(userId);
  if (tab === "review")   filter.status      = "In-Review";
  if (tab === "done")     filter.status      = "Done";
  if (status)             filter.status      = status;
  if (projectId)          filter.projectId   = new mongoose.Types.ObjectId(projectId);
  if (milestoneId)        filter.milestoneId = new mongoose.Types.ObjectId(milestoneId);

  const tasks = await Task.find(filter)
    .populate("assignee",  "name role")
    .populate("assignees", "name role")
    .populate("createdBy", "name")
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  res.json({
    tasks: tasks.map((t) => ({
      id:          t._id,
      title:       t.title,
      description: t.description ?? "",
      type:        t.type,
      priority:    t.priority,
      status:      t.status,
      deadline:    t.deadline,
      milestoneId: t.milestoneId ?? null,
      projectId:   t.projectId   ?? null,
      xpValue:     t.xpValue,
      isLate:      t.isLate,
      submittedAt: t.submittedAt,
      assignee:    t.assignee
        ? { id: t.assignee._id, name: t.assignee.name, role: t.assignee.role }
        : null,
      assignees:   (t.assignees ?? []).map((a) => ({ id: a._id, name: a.name, role: a.role })),
      createdBy:   t.createdBy?.name ?? "—",
      reviewStage: t.reviewStage,
      qualityScore: t.qualityScore,
      reviewNote:   t.reviewNote,
    })),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Workload Engine
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/teamlead/team-workload ───────────────────────────────────────────
// Full org team workload (all members in TL's projects)
export async function getTeamWorkload(req, res) {
  const { id: userId, orgId } = req.user;

  const myProjects = await Project.find({
    orgId,
    isDeleted: { $ne: true },
    members:   new mongoose.Types.ObjectId(userId),
    status:    { $nin: ["Completed", "Archived", "Deleted"] },
  }, "members").lean();

  // Collect all unique member IDs across all projects, excluding the TL
  const memberIdSet = new Set();
  for (const p of myProjects) {
    for (const m of p.members ?? []) memberIdSet.add(m.toString());
  }
  memberIdSet.delete(userId.toString());

  const memberIds = [...memberIdSet].map((id) => new mongoose.Types.ObjectId(id));
  if (!memberIds.length) return res.json({ members: [] });

  // Phase 7: use workload engine for accurate hours-based data
  const snapshots = await getBulkWorkloadSnapshots(memberIds);
  const members = snapshots.map((s) => ({
    id:              s.userId,
    name:            s.name,
    role:            s.role,
    department:      s.department,
    status:          s.status,
    openTasks:       s.activeTaskCount,
    dailyCapacityH:  s.dailyCapacityHours,
    allocatedH:      s.allocatedHours,
    remainingH:      s.availableHours,
    workload:        s.workloadTier,
    workloadColor:   s.workloadColor,
    utilisation:     s.utilisation,
    burnoutRisk:     s.burnoutRisk,
    hp:              s.hp,
    level:           s.level,
  }));

  res.json({ members });
}

// ── GET /api/teamlead/projects/:id/milestones/:milestoneId ────────────────────
export async function getMilestoneDetail(req, res) {
  const { id: userId, orgId } = req.user;
  const { id: projectId, milestoneId } = req.params;

  const project = await Project.findOne({
    _id:       projectId,
    orgId,
    members:   new mongoose.Types.ObjectId(userId),
    isDeleted: { $ne: true },
  }, "title members").lean();
  if (!project) return res.status(404).json({ error: "Project not found or access denied." });

  const milestone = await Milestone.findOne({ _id: milestoneId, projectId }).lean();
  if (!milestone) return res.status(404).json({ error: "Milestone not found." });

  const tasks = await Task.find({ milestoneId, orgId })
    .populate("assignee",  "name role department")
    .populate("assignees", "name role department")
    .lean();

  // ── Hours tracking (work-done model, NOT subtractive capacity) ────────────
  const start    = milestone.startDate ?? null;
  const due      = milestone.dueDate   ?? null;
  const workTime = await loadOrgWorkTime(orgId); // 4.2a: org Working Time, not a hard-coded 7 h / Mon-Fri
  const DAILY_H  = workTime.hoursPerDay;
  const workingDays    = (start && due) ? countWorkingDays(new Date(start), new Date(due), workTime.workingDays) : 0;
  // workDone = sum of estimatedHours of completed tasks only
  const workDone       = tasks
    .filter((t) => t.status === "Done")
    .reduce((s, t) => s + (t.estimatedHours ?? 0), 0);
  // scheduledHours = sum across ALL active tasks (for reference / planning)
  const scheduledHours = tasks.reduce((s, t) => s + (t.estimatedHours ?? 0), 0);

  // ── Member snapshots ─────────────────────────────────────────────────────
  const memberIds = project.members ?? [];
  const snapshots = await getBulkWorkloadSnapshots(memberIds);

  // ── Role-to-taskType map for this milestone ───────────────────────────────
  const roles = milestone.activeRoles ?? [];
  const allowedTaskTypes = roles.length === 0
    ? ["Feature", "Bug", "Design", "Testing", "DevOps", "Documentation"]
    : [...new Set(roles.flatMap((r) => {
        const cat = ROLE_TO_CATEGORY[r] ?? r.toLowerCase();
        return ROLE_TASK_ELIGIBILITY[cat] ?? ROLE_TASK_ELIGIBILITY.any;
      }))];

  // ── Eligible members for assignment ──────────────────────────────────────
  // Team Lead is ALWAYS excluded — they plan/assign but never execute tasks
  const eligibleMembers = snapshots.filter((s) => {
    const cat = ROLE_TO_CATEGORY[s.role] ?? s.roleCategory ?? "";
    if (cat === "team_lead" || s.role === "Team Lead") return false;
    if (!roles.length) return true;
    return roles.some((r) => {
      const rc = ROLE_TO_CATEGORY[r] ?? r.toLowerCase();
      return rc === cat || rc === "any";
    });
  });

  // ── Milestone window: days × 7h × productive contributors (TL excluded) ───
  // This is a fixed reference baseline — NOT a consumable resource pool.
  const productiveMembers   = eligibleMembers.filter((m) => {
    const cat = ROLE_TO_CATEGORY[m.role] ?? m.roleCategory ?? "";
    return cat !== "team_lead" && m.role !== "Team Lead";
  });
  const activeContributors  = productiveMembers.length > 0
    ? productiveMembers.length
    : Math.max(1, eligibleMembers.length);
  const milestoneWindow     = workingDays * DAILY_H * activeContributors;
  // executionProgress = work done / milestone window (analytical, not subtractive)
  const executionProgress   = milestoneWindow > 0
    ? Math.min(100, Math.round((workDone / milestoneWindow) * 100))
    : 0;

  // ── Risk level ────────────────────────────────────────────────────────────
  const now = new Date();
  const hasOverdue = tasks.some((t) => t.deadline && new Date(t.deadline) < now && t.status !== "Done");
  let riskLevel = "Low";
  if (milestone.status === "Delayed" || executionProgress >= 90) riskLevel = "Critical";
  else if (hasOverdue || executionProgress >= 75)                riskLevel = "High";
  else if (executionProgress >= 55)                              riskLevel = "Medium";

  const taskCounts = {
    total:      tasks.length,
    toDo:       tasks.filter((t) => t.status === "To-Do").length,
    inProgress: tasks.filter((t) => t.status === "In-Progress").length,
    inReview:   tasks.filter((t) => t.status === "In-Review").length,
    done:       tasks.filter((t) => t.status === "Done").length,
  };

  res.json({
    milestone: {
      id:           milestone._id,
      title:        milestone.title,
      description:  milestone.description,
      status:       milestone.status,
      progress:     milestone.progress,
      startDate:    start,
      dueDate:      due,
      activeRoles:  milestone.activeRoles ?? [],
      deliverables: milestone.deliverables ?? [],
    },
    hours: {
      workingDays,
      activeContributors,
      milestoneWindow,                                        // fixed reference total
      workDone:         Math.round(workDone        * 10) / 10, // completed task hours
      scheduledHours:   Math.round(scheduledHours  * 10) / 10, // all tasks estimated
      executionProgress,                                      // workDone / window %
    },
    riskLevel,
    taskCounts,
    tasks: tasks.map((t) => ({
      id:             t._id,
      title:          t.title,
      description:    t.description,
      type:           t.type,
      priority:       t.priority,
      status:         t.status,
      difficulty:     t.difficulty,
      estimatedHours: t.estimatedHours,
      startDate:      t.startDate,
      endDate:        t.endDate,
      deadline:       t.deadline,
      assignee:       t.assignee
        ? { id: t.assignee._id, name: t.assignee.name, role: t.assignee.role }
        : null,
    })),
    members:        snapshots,
    eligibleMembers,
    allowedTaskTypes,
    project: { id: project._id, title: project.title },
  });
}

// ── GET /api/teamlead/employee/:id/capacity ───────────────────────────────────
export async function getEmployeeCapacity(req, res) {
  const { id: userId, orgId } = req.user;
  const targetId = req.params.id;

  // Verify target is in at least one of TL's projects
  const sharedProject = await Project.findOne({
    orgId,
    isDeleted: { $ne: true },
    members:   {
      $all: [
        new mongoose.Types.ObjectId(userId),
        new mongoose.Types.ObjectId(targetId),
      ],
    },
  }, "_id").lean();

  if (!sharedProject) return res.status(403).json({ error: "Not a member of your projects." });

  const DAILY_CAPACITY_H = (await loadOrgWorkTime(orgId)).hoursPerDay; // 4.2a
  const targetOid = new mongoose.Types.ObjectId(targetId);

  const [user, taskAgg, profile] = await Promise.all([
    User.findById(targetId, "name role department status").lean(),
    Task.aggregate([
      {
        $match: {
          orgId,
          $or: [
            { assignee:  targetOid },
            { assignees: targetOid },
          ],
          status: { $in: ["To-Do", "In-Progress", "In-Review"] },
        },
      },
      {
        $group: { _id: null, openTasks: { $sum: 1 } },
      },
    ]),
    GamificationProfile.findOne({ userId: targetId }, "hp level currentXp").lean(),
  ]);

  if (!user) return res.status(404).json({ error: "User not found." });

  const open      = taskAgg[0]?.openTasks ?? 0;
  const allocated = Math.round(open * 1.5 * 10) / 10;
  const remaining = Math.max(0, Math.round((DAILY_CAPACITY_H - allocated) * 10) / 10);
  const workload  =
    allocated === 0   ? "Free"      :
    allocated <= 3    ? "Moderate"  :
    allocated <= 5.5  ? "Busy"      :
                        "Overloaded";

  res.json({
    id:         user._id,
    name:       user.name,
    role:       user.role,
    department: user.department,
    openTasks:  open,
    dailyCapacityH: DAILY_CAPACITY_H,
    allocatedH: allocated,
    remainingH: remaining,
    workload,
    hp:    profile?.hp         ?? 100,
    level: profile?.level      ?? 1,
    xp:    profile?.currentXp ?? 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Task Review (TL accepts or requests changes)
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/teamlead/tasks/:id/tl-review ────────────────────────────────────
// body: { action: "accept"|"request_changes", comment, qualityScore }
export async function tlReviewTask(req, res) {
  const { id: userId, orgId } = req.user;
  const { action, comment = "", qualityScore } = req.body ?? {};

  if (!["accept", "request_changes"].includes(action)) {
    return res.status(400).json({ error: "action must be 'accept' or 'request_changes'." });
  }

  // Fetch task and verify it's in TL's scope
  const task = await Task.findById(req.params.id).lean();
  if (!task || task.orgId !== orgId) return res.status(404).json({ error: "Task not found." });
  if (task.status !== "In-Review")
    return res.status(409).json({ error: "Task is not In-Review." });

  const myProjects = await Project.find({
    orgId,
    isDeleted: { $ne: true },
    members:   new mongoose.Types.ObjectId(userId),
  }, "_id").lean();

  const projectIdStrs = myProjects.map((p) => p._id.toString());
  if (!projectIdStrs.includes(task.projectId?.toString())) {
    return res.status(403).json({ error: "Task not in your projects." });
  }

  const now     = new Date();
  const updates = {};
  // D-063/D-064: a 0-100 score → stars; older callers may still send 1-5 stars.
  const tlScore = parseTlScore(req.body?.score);
  if (req.body?.score !== undefined && tlScore === null) return res.status(400).json({ error: "Score must be a whole number from 0 to 100." });
  const ai      = tlScore !== null ? await Task.findById(task._id, "+aiScore").lean() : null;
  const fs      = tlScore !== null ? finalScore({ tlScore, aiScore: ai?.aiScore, by: userId }) : null;
  const qs      = fs ? fs.stars : qualityScore ? Math.max(1, Math.min(5, Math.round(qualityScore))) : null;

  if (action === "accept") {
    const blockedTL = approvalBlock({ task, reviewerId: userId }); // T-4: same rule on every path to Done
    if (blockedTL) return res.status(blockedTL.status).json({ error: blockedTL.error, code: blockedTL.code });
    updates.status      = "Done";
    updates.completedAt = now;
    updates.reviewedBy  = userId;
    updates.reviewedAt  = now;
    updates.reviewNote  = comment || "Accepted by Team Lead";
    if (qs) updates.qualityScore = qs;
    if (tlScore !== null) updates.tlScore = tlScore;

    // Atomic: only one accept can move the task out of In-Review.
    const updated = await Task.findOneAndUpdate(
      { _id: req.params.id, status: "In-Review" },
      { $set: updates, ...(fs?.flag ? { $push: { reviewFlags: fs.flag } } : {}) },
      { returnDocument: "after" }
    ).lean();
    if (!updated) return res.status(409).json({ error: "Task is not In-Review." });
    Task.logActivity(task._id, userId, "status", { from: "In-Review", to: "Done", note: qs ? `${qs}★ ${comment}` : comment });
    reviewAudit(req, task, "task_review_approved", `"${task.title}" approved${qs ? ` (${qs}★)` : ""}.`, { stars: qs, score: tlScore });

    // XP goes through the single award path (V1 1.1): gamificationService.applyTaskApproved
    const assigneeIds = [
      ...(task.assignees ?? []).map((a) => a.toString()),
      ...(task.assignee ? [task.assignee.toString()] : []),
    ];
    const uniqueIds = [...new Set(assigneeIds)];

    emitter.emit("task.approved", {
      taskId:       task._id,
      assignees:    uniqueIds,
      qualityScore: qs ?? 3,
      approverId:   userId,
      orgId,
      taskTitle:    task.title,
    });

    for (const aid of uniqueIds) {
      await createNotification({
        userId:  aid,
        orgId,
        type:    "task_approved",
        title:   "Task Accepted",
        message: `"${task.title}" was accepted by your Team Lead.${comment ? ` Note: ${comment}` : ""}`,
        meta:    { taskId: task._id, projectId: task.projectId },
      });
    }

    // Award TL review efficiency XP (replaces old 5 XP stub)
    // T-6 (D-148): one rule on every review route; the badge check happens in the award.
    await awardTLReviewXp({ tlId: userId, orgId, taskId: task._id, stars: qs, submittedAt: task.submittedAt, approvedAt: now });

    // Update reviewer stats for gamification
    await GamificationProfile.updateOne(
      { userId },
      { $inc: { "stats.reviewsGiven": 1 } }
    );

    return res.json({ task: updated, ...(fs ? { tlScore, stars: qs, aiScore: ai?.aiScore ?? null, gap: fs.gap, flagged: Boolean(fs.flag) } : {}) });
  }

  // request_changes
  updates.status   = "In-Progress";
  updates.reviewNote = comment || "Changes requested by Team Lead";

  const updated = await Task.findByIdAndUpdate(
    req.params.id,
    {
      $set: updates,
      $push: {
        revisionHistory: {
          type:        "revision_requested",
          comment:     comment || "Changes requested",
          requestedBy: userId,
          requestedAt: now,
        },
      },
    },
    { returnDocument: "after" }
  ).lean();
  Task.logActivity(task._id, userId, "status", { from: "In-Review", to: "In-Progress", note: comment || "Changes requested" });
  reviewAudit(req, task, "task_review_revision", `Revision requested on "${task.title}".`, { note: comment });

  const assigneeIds = [
    ...(task.assignees ?? []).map((a) => a.toString()),
    ...(task.assignee ? [task.assignee.toString()] : []),
  ];
  const uniqueIds = [...new Set(assigneeIds)];

  for (const aid of uniqueIds) {
    await createNotification({
      userId:  aid,
      orgId,
      type:    "task_rejected",
      title:   "Changes Requested",
      message: `"${task.title}" needs revisions.${comment ? ` Feedback: ${comment}` : ""}`,
      meta:    { taskId: task._id, projectId: task.projectId },
    });
  }

  res.json({ task: updated });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Resource Requests
// ─────────────────────────────────────────────────────────────────────────────

// In-memory storage backed by Approval model with actionType "RESOURCE_REQUEST"
// (extends existing Approval model without schema changes)

// ── POST /api/teamlead/resource-requests ─────────────────────────────────────
export async function createResourceRequest(req, res) {
  const { id: userId, orgId } = req.user;
  const { projectId, requestedRole, reason, urgency = "Medium" } = req.body ?? {};

  if (!requestedRole?.trim()) return res.status(400).json({ error: "requestedRole is required." });
  if (!reason?.trim())        return res.status(400).json({ error: "reason is required." });
  if (!["Low","Medium","High","Critical"].includes(urgency)) {
    return res.status(400).json({ error: "Invalid urgency." });
  }

  // Verify project belongs to TL if provided
  if (projectId) {
    const proj = await assertTLProject(projectId, userId, orgId);
    if (!proj) return res.status(404).json({ error: "Project not found." });
  }

  const orgDoc = await Organization.findOne(
    /^[0-9a-f]{24}$/i.test(String(orgId)) ? { _id: orgId } : { orgId },
    "_id"
  ).lean();

  const approval = await Approval.create({
    orgId:       orgDoc?._id ?? orgId,
    actionType:  "RESOURCE_REQUEST",
    requestedBy: userId,
    status:      "PENDING",
    payload: {
      projectId:     projectId ?? null,
      requestedRole: requestedRole.trim(),
      reason:        reason.trim(),
      urgency,
    },
  });

  // Notify managers
  const managers = await User.find({ orgId, role: "Manager", status: "active" }, "_id").lean();
  const tl       = await User.findById(userId, "name").lean();

  for (const mgr of managers) {
    await createNotification({
      userId:  mgr._id.toString(),
      orgId,
      type:    "system",
      title:   "Resource Request",
      message: `Team Lead ${tl?.name ?? "Unknown"} requested a ${requestedRole} (${urgency} urgency).`,
      meta:    { approvalId: approval._id, requestedRole, urgency },
    });
  }

  res.status(201).json({ request: approval });
}

// ── GET /api/teamlead/resource-requests ──────────────────────────────────────
export async function getResourceRequests(req, res) {
  const { id: userId, orgId } = req.user;

  const orgDoc = await Organization.findOne(
    /^[0-9a-f]{24}$/i.test(String(orgId)) ? { _id: orgId } : { orgId },
    "_id"
  ).lean();

  const requests = await Approval.find({
    orgId:      orgDoc?._id ?? orgId,
    actionType: "RESOURCE_REQUEST",
    requestedBy: userId,
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  res.json({
    requests: requests.map((r) => ({
      id:            r._id,
      status:        r.status,
      urgency:       r.payload?.urgency,
      requestedRole: r.payload?.requestedRole,
      reason:        r.payload?.reason,
      projectId:     r.payload?.projectId,
      rejectionReason: r.rejectionReason,
      resolvedAt:    r.resolvedAt,
      createdAt:     r.createdAt,
    })),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Smart Alerts
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/teamlead/alerts ──────────────────────────────────────────────────
export async function getAlerts(req, res) {
  const { id: userId, orgId } = req.user;
  const now = new Date();

  const myProjects = await Project.find({
    orgId,
    isDeleted: { $ne: true },
    members:   new mongoose.Types.ObjectId(userId),
    status:    { $nin: ["Completed", "Archived", "Deleted"] },
  }, "_id members").lean();

  const projectIds = myProjects.map((p) => p._id);

  // Collect all unique member IDs
  const memberIdSet = new Set();
  for (const p of myProjects) {
    for (const m of p.members ?? []) memberIdSet.add(m.toString());
  }
  memberIdSet.delete(userId.toString());
  const memberIds = [...memberIdSet].map((id) => new mongoose.Types.ObjectId(id));

  const [overdueTasks, inReviewTasks, unassignedTasks, delayedMilestones, workloadAgg, profiles, memberUsers] =
    await Promise.all([
      // Overdue tasks (deadline passed, not done)
      Task.find({
        projectId: { $in: projectIds }, orgId,
        status:    { $nin: ["Done"] },
        deadline:  { $lt: now, $ne: null },
      }, "title deadline priority projectId assignee assignees").lean(),

      // Tasks stuck in review
      Task.find({
        projectId: { $in: projectIds }, orgId,
        status:    "In-Review",
      }, "title createdAt updatedAt projectId assignee assignees").lean(),

      // Unassigned tasks
      Task.countDocuments({
        projectId: { $in: projectIds }, orgId,
        assignee:  null,
        assignees: { $size: 0 },
        status:    { $nin: ["Done"] },
      }),

      // Delayed milestones
      Milestone.find({
        projectId: { $in: projectIds },
        $or: [
          { status: "Delayed" },
          { dueDate: { $lt: now, $ne: null }, status: { $ne: "Completed" } },
        ],
      }, "title projectId dueDate status").lean(),

      // Overloaded member detection (open task count)
      Task.aggregate([
        {
          $match: {
            orgId,
            $or: [
              { assignee:  { $in: memberIds } },
              { assignees: { $in: memberIds } },
            ],
            status: { $in: ["To-Do", "In-Progress", "In-Review"] },
          },
        },
        {
          $addFields: {
            eff: { $ifNull: ["$assignee", { $arrayElemAt: ["$assignees", 0] }] },
          },
        },
        { $group: { _id: "$eff", count: { $sum: 1 } } },
      ]),

      // HP profiles for burnout detection
      GamificationProfile.find(
        { userId: { $in: memberIds } },
        "userId hp"
      ).lean(),
      memberIds.length ? User.find({ _id: { $in: memberIds } }, "name role").lean() : [],
    ]);

  const workloadMap = Object.fromEntries(workloadAgg.map((a) => [a._id?.toString(), a.count]));
  const hpMap       = Object.fromEntries(profiles.map((p) => [p.userId.toString(), p.hp]));

  const usersById = Object.fromEntries(memberUsers.map((u) => [u._id.toString(), u]));

  const alerts = [];

  // Overdue task alerts
  for (const t of overdueTasks) {
    const daysOver = Math.ceil((now - new Date(t.deadline)) / 86_400_000);
    const severity = daysOver >= 7 ? "Critical" : daysOver >= 3 ? "High" : "Medium";
    alerts.push({
      type:     "overdue_task",
      severity,
      message:  `"${t.title}" is ${daysOver}d overdue`,
      meta:     { taskId: t._id, projectId: t.projectId, daysOver, priority: t.priority },
    });
  }

  // Stuck-in-review alerts (in review > 48h)
  for (const t of inReviewTasks) {
    const hoursInReview = Math.round((now - new Date(t.updatedAt)) / 3_600_000);
    if (hoursInReview >= 48) {
      alerts.push({
        type:     "review_stalled",
        severity: hoursInReview >= 96 ? "High" : "Medium",
        message:  `"${t.title}" has been in review for ${Math.floor(hoursInReview / 24)}d`,
        meta:     { taskId: t._id, projectId: t.projectId, hoursInReview },
      });
    }
  }

  // Unassigned tasks
  if (unassignedTasks > 0) {
    alerts.push({
      type:     "unassigned_tasks",
      severity: unassignedTasks >= 5 ? "High" : "Medium",
      message:  `${unassignedTasks} task${unassignedTasks > 1 ? "s" : ""} have no assignee`,
      meta:     { count: unassignedTasks },
    });
  }

  // Delayed milestones
  for (const m of delayedMilestones) {
    alerts.push({
      type:     "delayed_milestone",
      severity: "High",
      message:  `Milestone "${m.title}" is delayed`,
      meta:     { milestoneId: m._id, projectId: m.projectId, dueDate: m.dueDate },
    });
  }

  // Overloaded members (> 5 open tasks ≈ > 7.5h, Overloaded threshold)
  for (const [uid, count] of Object.entries(workloadMap)) {
    if (count > 5) {
      const u = usersById[uid];
      alerts.push({
        type:     "overloaded_member",
        severity: count > 8 ? "Critical" : "High",
        message:  `${u?.name ?? "A team member"} has ${count} active tasks (overloaded)`,
        meta:     { userId: uid, role: u?.role, openTasks: count },
      });
    }
  }

  // Low HP / burnout risk
  for (const [uid, hp] of Object.entries(hpMap)) {
    if (hp <= 20) {
      const u = usersById[uid];
      alerts.push({
        type:     "burnout_risk",
        severity: hp <= 10 ? "Critical" : "High",
        message:  `${u?.name ?? "A team member"} is at burnout risk (HP: ${hp}/100)`,
        meta:     { userId: uid, hp, role: u?.role },
      });
    }
  }

  // Sort: Critical → High → Medium → Low, then name and id, so every call gives the same order (E-4c, D-199).
  res.json({ alerts: sortAlerts(alerts) });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Sprint View data
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/teamlead/sprint ──────────────────────────────────────────────────
// Returns active sprint(s) across the TL's projects.
export async function getSprintView(req, res) {
  const { id: userId, orgId } = req.user;
  const { projectId } = req.query;

  const projectFilter = {
    orgId,
    isDeleted: { $ne: true },
    members:   new mongoose.Types.ObjectId(userId),
    status:    { $nin: ["Completed", "Archived", "Deleted"] },
  };
  if (projectId) projectFilter._id = new mongoose.Types.ObjectId(projectId);

  const projects = await Project.find(projectFilter, "_id title").lean();
  const projectIds = projects.map((p) => p._id);
  const projectMap = Object.fromEntries(projects.map((p) => [p._id.toString(), p.title]));

  if (!projectIds.length) return res.json({ sprints: [], tasks: [] });

  // Load active milestones as "sprints" (milestones with status In Progress)
  const [sprints, tasks] = await Promise.all([
    Milestone.find({
      projectId: { $in: projectIds },
      status:    "In Progress",
    }).sort({ dueDate: 1 }).lean(),

    Task.find({
      projectId: { $in: projectIds },
      orgId,
      status:    { $nin: ["Done"] },
    })
      .populate("assignee",  "name role")
      .populate("assignees", "name role")
      .sort({ priority: 1, deadline: 1 })
      .limit(300)
      .lean(),
  ]);

  const now = new Date();

  res.json({
    sprints: sprints.map((m) => ({
      id:          m._id,
      title:       m.title,
      projectId:   m.projectId,
      projectTitle: projectMap[m.projectId?.toString()] ?? "Unknown",
      status:      m.status,
      progress:    m.progress ?? 0,
      startDate:   m.startDate,
      dueDate:     m.dueDate,
      isOverdue:   m.dueDate && m.dueDate < now,
    })),
    tasks: tasks.map((t) => ({
      id:          t._id,
      title:       t.title,
      type:        t.type,
      priority:    t.priority,
      status:      t.status,
      deadline:    t.deadline,
      projectId:   t.projectId,
      projectTitle: projectMap[t.projectId?.toString()] ?? "Unknown",
      milestoneId: t.milestoneId,
      assignee:    t.assignee ? { id: t.assignee._id, name: t.assignee.name, role: t.assignee.role } : null,
      assignees:   (t.assignees ?? []).map((a) => ({ id: a._id, name: a.name, role: a.role })),
      isLate:      t.isLate,
    })),
  });
}


// =============================================================================
// PHASE 4 — SPRINT INTELLIGENCE + ANALYTICS + RISK + ACTIVITY
// =============================================================================

// ── Helper: get TL project IDs ────────────────────────────────────────────────
async function getTLProjectIds(userId, orgId) {
  const uid = new mongoose.Types.ObjectId(userId);
  const projects = await Project.find(
    { orgId, members: uid, isDeleted: { $ne: true } },
    "_id"
  ).lean();
  return projects.map((p) => p._id);
}

// ── POST /api/teamlead/sprints ────────────────────────────────────────────────
export async function createSprint(req, res) {
  const { id: userId, orgId } = req.user;
  const { name, goal, goals = [], startDate, endDate, projectId } = req.body ?? {};

  if (!name?.trim()) return res.status(400).json({ error: "Sprint name is required." });

  if (projectId) {
    const proj = await assertTLProject(projectId, userId, orgId);
    if (!proj) return res.status(404).json({ error: "Project not found." });
  }

  const sprint = await Sprint.create({
    name:      name.trim(),
    goal:      goal?.trim() ?? "",
    goals:     goals.filter(Boolean),
    startDate: startDate ?? null,
    endDate:   endDate   ?? null,
    orgId,
    projectId: projectId ?? null,
    createdBy: userId,
  });

  const io = getIo();
  if (io) io.to(`org:${orgId}`).emit("sprint:created", { sprintId: sprint._id });

  res.status(201).json({ sprint });
}

// ── GET /api/teamlead/sprints ─────────────────────────────────────────────────
export async function getSprints(req, res) {
  const { id: userId, orgId } = req.user;
  const uid = new mongoose.Types.ObjectId(userId);
  const projectIds = await getTLProjectIds(userId, orgId);

  const filter = { orgId, $or: [{ projectId: { $in: projectIds } }, { createdBy: uid }] };
  if (req.query.status) filter.status = req.query.status;

  const sprints = await Sprint.find(filter)
    .sort({ createdAt: -1 })
    .populate("tasks",      "title status priority deadline assignee")
    .populate("milestones", "title status progress dueDate")
    .populate("createdBy",  "name")
    .lean();

  const enriched = sprints.map((s) => {
    const tasks = s.tasks ?? [];
    const done  = tasks.filter((t) => t.status === "Done").length;
    const total = tasks.length;
    const overdue = tasks.filter((t) => t.deadline && new Date(t.deadline) < new Date() && t.status !== "Done").length;
    const daysLeft = s.endDate ? Math.ceil((new Date(s.endDate) - new Date()) / 86_400_000) : null;
    const completionPct = total > 0 ? Math.round((done / total) * 100) : 0;

    let velocity = null;
    if (s.status === "Completed" && s.startDate && s.completedAt && done > 0) {
      const durationDays = Math.max(1, Math.ceil((new Date(s.completedAt) - new Date(s.startDate)) / 86_400_000));
      velocity = +(done / durationDays).toFixed(2);
    }

    return {
      id:          s._id,
      name:        s.name,
      goal:        s.goal,
      goals:       s.goals ?? [],
      status:      s.status,
      startDate:   s.startDate,
      endDate:     s.endDate,
      completedAt: s.completedAt,
      projectId:   s.projectId,
      createdBy:   s.createdBy?.name,
      tasks:       tasks.map((t) => ({
        id:       t._id,
        title:    t.title,
        status:   t.status,
        priority: t.priority,
        deadline: t.deadline,
        assignee: t.assignee,
      })),
      milestones:  (s.milestones ?? []).map((m) => ({
        id:       m._id,
        title:    m.title,
        status:   m.status,
        progress: m.progress,
        dueDate:  m.dueDate,
      })),
      metrics: { total, done, overdue, completionPct, daysLeft, velocity,
        inProgress: tasks.filter((t) => t.status === "In-Progress").length,
        inReview:   tasks.filter((t) => t.status === "In-Review").length,
      },
    };
  });

  res.json({ sprints: enriched });
}

// ── PATCH /api/teamlead/sprints/:id ──────────────────────────────────────────
export async function updateSprint(req, res) {
  const { orgId } = req.user;
  const { id: sprintId } = req.params;
  const { name, goal, goals, status, startDate, endDate } = req.body ?? {};

  const sprint = await Sprint.findOne({ _id: sprintId, orgId });
  if (!sprint) return res.status(404).json({ error: "Sprint not found." });

  if (name)               sprint.name      = name.trim();
  if (goal !== undefined) sprint.goal      = goal;
  if (goals)              sprint.goals     = goals.filter(Boolean);
  if (status)             sprint.status    = status;
  if (startDate !== undefined) sprint.startDate = startDate;
  if (endDate   !== undefined) sprint.endDate   = endDate;
  if (status === "Completed" && !sprint.completedAt) sprint.completedAt = new Date();

  await sprint.save();

  // Award TL XP when sprint is completed
  if (status === "Completed") {
    const { id: tlUserId, orgId } = req.user;
    // Compute sprint task completion rate
    let completionPct = 0;
    if ((sprint.tasks ?? []).length > 0) {
      const doneTasks = await Task.countDocuments({ _id: { $in: sprint.tasks }, status: "Done" });
      completionPct = Math.round((doneTasks / sprint.tasks.length) * 100);
    }
    const isPerfect   = completionPct === 100;
    const isHighComp  = completionPct >= 80;
    const wasOnTime   = sprint.endDate ? new Date() <= new Date(sprint.endDate) : true;

    const baseXp = 150;
    const sources = ["tl_sprint_completed"];
    let totalXp  = baseXp;
    const statInc = { sprintsCompleted: 1 };

    if (wasOnTime)  { totalXp += 80;  sources.push("tl_sprint_on_time");          statInc.sprintsOnTime = 1; }
    if (isPerfect)  { totalXp += 120; sources.push("tl_sprint_perfect");           statInc.perfectSprints = 1; }
    else if (isHighComp) { totalXp += 60; sources.push("tl_sprint_high_completion"); statInc.sprintsHighCompletion = 1; }

    await awardTLXp(tlUserId, orgId, totalXp, "tl_sprint_completed", statInc);
    await checkTLBadges(tlUserId, orgId);
    await checkTLTitles(tlUserId, orgId);
  }

  const io = getIo();
  if (io) io.to(`org:${orgId}`).emit("sprint:updated", { sprintId: sprint._id, status: sprint.status });

  res.json({ sprint });
}

// ── DELETE /api/teamlead/sprints/:id ─────────────────────────────────────────
export async function deleteSprint(req, res) {
  const { orgId } = req.user;
  const { id: sprintId } = req.params;

  const sprint = await Sprint.findOneAndDelete({ _id: sprintId, orgId });
  if (!sprint) return res.status(404).json({ error: "Sprint not found." });

  res.json({ message: "Sprint deleted." });
}

// ── POST /api/teamlead/sprints/:id/tasks ─────────────────────────────────────
export async function addSprintTask(req, res) {
  const { orgId } = req.user;
  const { id: sprintId } = req.params;
  const { taskId } = req.body ?? {};

  if (!taskId) return res.status(400).json({ error: "taskId required." });

  const sprint = await Sprint.findOne({ _id: sprintId, orgId });
  if (!sprint) return res.status(404).json({ error: "Sprint not found." });

  await Sprint.updateOne({ _id: sprintId }, { $addToSet: { tasks: taskId } });
  res.json({ message: "Task added to sprint." });
}

// ── DELETE /api/teamlead/sprints/:id/tasks/:taskId ────────────────────────────
export async function removeSprintTask(req, res) {
  const { orgId } = req.user;
  const { id: sprintId, taskId } = req.params;

  const sprint = await Sprint.findOne({ _id: sprintId, orgId });
  if (!sprint) return res.status(404).json({ error: "Sprint not found." });

  await Sprint.updateOne({ _id: sprintId }, { $pull: { tasks: new mongoose.Types.ObjectId(taskId) } });
  res.json({ message: "Task removed from sprint." });
}

// ── GET /api/teamlead/analytics ──────────────────────────────────────────────
export async function getAnalytics(req, res) {
  const { id: userId, orgId } = req.user;
  const uid = new mongoose.Types.ObjectId(userId);

  const projects = await Project.find(
    { orgId, members: uid, isDeleted: { $ne: true } },
    "_id title members"
  ).lean();
  const projectIds = projects.map((p) => p._id);

  // A. Team members (from the project docs; no extra aggregate). Perf D-078: the five
  // independent queries below run in one parallel round instead of one after another.
  const memberObjIds = [...new Set(projects.flatMap((p) => (p.members ?? []).map(String)))].map((id) => new mongoose.Types.ObjectId(id));
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
  const [gProfiles, milestones, recentTasks, sprints, openTasks] = await Promise.all([
    GamificationProfile.find({ userId: { $in: memberObjIds } }, "userId stats level totalXp hp")
      .populate("userId", "name role department").lean(),
    Milestone.find({ projectId: { $in: projectIds } }).lean(),
    Task.find({ orgId, projectId: { $in: projectIds }, createdAt: { $gte: thirtyDaysAgo } }, "status priority isLate").lean(),
    Sprint.find({ orgId, $or: [{ projectId: { $in: projectIds } }, { createdBy: uid }] }).populate("tasks", "status").lean(),
    Task.find({ orgId, projectId: { $in: projectIds }, assignee: { $in: memberObjIds }, status: { $nin: ["Done", "Backlog"] } }, "assignee status").lean(),
  ]);

  const teamPerformance = gProfiles.map((gp) => {
    const s = gp.stats ?? {};
    const total = (s.tasksCompleted ?? 0) + (s.tasksRejected ?? 0);
    const passRate = total > 0 ? Math.round(((s.tasksCompleted ?? 0) / total) * 100) : null;
    return {
      userId:         gp.userId?._id,
      name:           gp.userId?.name ?? "Unknown",
      role:           gp.userId?.role,
      department:     gp.userId?.department,
      tasksCompleted: s.tasksCompleted ?? 0,
      tasksRejected:  s.tasksRejected  ?? 0,
      onTimeRate:     s.tasksCompleted > 0 ? Math.round(((s.onTimeDeliveries ?? 0) / s.tasksCompleted) * 100) : null,
      reviewPassRate: passRate,
      avgQuality:     s.avgQualityScore ?? 0,
      level:          gp.level,
      totalXp:        gp.totalXp,
      hp:             gp.hp,
    };
  }).sort((a, b) => b.tasksCompleted - a.tasksCompleted);

  // B. Milestones
  const now = new Date();
  const delayedMilestones   = milestones.filter((m) => m.status === "Delayed" || (m.dueDate && new Date(m.dueDate) < now && m.status !== "Completed")).length;
  const completedMilestones = milestones.filter((m) => m.status === "Completed").length;
  const activeMilestones    = milestones.filter((m) => m.status === "In Progress").length;
  const bottleneck = milestones
    .filter((m) => m.status === "In Progress")
    .sort((a, b) => (a.progress ?? 0) - (b.progress ?? 0))
    .slice(0, 3)
    .map((m) => ({ id: m._id, title: m.title, progress: m.progress ?? 0, dueDate: m.dueDate }));

  // C. Task stats (last 30 days)

  const taskStats = {
    total:          recentTasks.length,
    done:           recentTasks.filter((t) => t.status === "Done").length,
    overdue:        recentTasks.filter((t) => t.isLate).length,
    inProgress:     recentTasks.filter((t) => t.status === "In-Progress").length,
    inReview:       recentTasks.filter((t) => t.status === "In-Review").length,
    completionRate: recentTasks.length > 0
      ? Math.round((recentTasks.filter((t) => t.status === "Done").length / recentTasks.length) * 100) : 0,
  };

  // D. Sprint analytics

  const completedSprints = sprints.filter((s) => s.status === "Completed");
  const activeSprints    = sprints.filter((s) => s.status === "Active");

  const avgVelocity = completedSprints.length > 0
    ? +(completedSprints.reduce((acc, s) => {
        const done = (s.tasks ?? []).filter((t) => t.status === "Done").length;
        const days = s.startDate && s.completedAt
          ? Math.max(1, Math.ceil((new Date(s.completedAt) - new Date(s.startDate)) / 86_400_000)) : 7;
        return acc + done / days;
      }, 0) / completedSprints.length).toFixed(2) : null;

  const sprintAnalytics = {
    total:     sprints.length,
    active:    activeSprints.length,
    completed: completedSprints.length,
    delayed:   sprints.filter((s) => s.status === "Delayed").length,
    avgVelocity,
    activeSprintCompletion: activeSprints.length > 0
      ? Math.round(activeSprints.reduce((acc, s) => {
          const tasks = s.tasks ?? [];
          const done  = tasks.filter((t) => t.status === "Done").length;
          return acc + (tasks.length > 0 ? (done / tasks.length) * 100 : 0);
        }, 0) / activeSprints.length) : 0,
  };

  // E. Workload distribution

  const taskCountByMember = {};
  for (const t of openTasks) {
    const mid = t.assignee?.toString();
    if (mid) taskCountByMember[mid] = (taskCountByMember[mid] ?? 0) + 1;
  }

  const workloadDistribution = teamPerformance.map((m) => ({
    userId:    m.userId,
    name:      m.name,
    taskCount: taskCountByMember[m.userId?.toString()] ?? 0,
    level:     m.level,
    hp:        m.hp,
  })).sort((a, b) => b.taskCount - a.taskCount);

  res.json({ teamPerformance, milestoneAnalytics: { total: milestones.length, delayed: delayedMilestones, completed: completedMilestones, active: activeMilestones, bottleneck }, taskStats, sprintAnalytics, workloadDistribution });
}

// ── GET /api/teamlead/risks ───────────────────────────────────────────────────
export async function getRisks(req, res) {
  const { id: userId, orgId } = req.user;
  const uid = new mongoose.Types.ObjectId(userId);
  const projectIds = await getTLProjectIds(userId, orgId);
  const now = new Date();
  const risks = [];

  // 1. Overloaded members
  const memberAgg = await Project.aggregate([
    { $match: { _id: { $in: projectIds } } },
    { $unwind: "$members" },
    { $group: { _id: "$members" } },
  ]);
  const memberObjIds = memberAgg.map((m) => m._id);

  const openTasksByMember = await Task.aggregate([
    { $match: { orgId, projectId: { $in: projectIds }, assignee: { $in: memberObjIds }, status: { $nin: ["Done", "Backlog"] } } },
    { $group: { _id: "$assignee", count: { $sum: 1 } } },
  ]);

  const memberNames = await User.find({ _id: { $in: memberObjIds } }, "name role").lean();
  const nameMap = Object.fromEntries(memberNames.map((u) => [u._id.toString(), u]));

  for (const { _id, count } of openTasksByMember) {
    if (count > 5) {
      const member = nameMap[_id.toString()];
      risks.push({ level: "High", type: "overloaded_member", title: `${member?.name ?? "Member"} is overloaded`,
        message: `${member?.name ?? "A team member"} has ${count} active tasks — burnout risk.`,
        action: "Reassign 1-2 tasks to balance workload", meta: { userId: _id, count } });
    }
  }

  // 2. Burnout risk (HP <= 25)
  const lowHpProfiles = await GamificationProfile.find({ userId: { $in: memberObjIds }, hp: { $lte: 25 } }, "userId hp").lean();
  for (const gp of lowHpProfiles) {
    const member = nameMap[gp.userId?.toString()];
    risks.push({ level: "Critical", type: "burnout_risk", title: `${member?.name ?? "Member"} burnout risk`,
      message: `HP at ${gp.hp}% — near burnout threshold.`,
      action: "Reduce task load and allow recovery time", meta: { userId: gp.userId, hp: gp.hp } });
  }

  // 3. High overdue rate
  const activeTasks  = await Task.countDocuments({ orgId, projectId: { $in: projectIds }, status: { $nin: ["Done", "Backlog"] } });
  const overdueTasks = await Task.countDocuments({ orgId, projectId: { $in: projectIds }, status: { $nin: ["Done"] }, deadline: { $lt: now } });
  if (activeTasks > 0 && overdueTasks / activeTasks > 0.3) {
    risks.push({ level: "High", type: "high_overdue_rate", title: "High overdue task rate",
      message: `${overdueTasks}/${activeTasks} active tasks are overdue (${Math.round((overdueTasks / activeTasks) * 100)}%).`,
      action: "Prioritize overdue tasks or extend deadlines", meta: { overdueTasks, activeTasks } });
  }

  // 4. Delayed milestones
  const delayedMs = await Milestone.find({ projectId: { $in: projectIds }, status: { $ne: "Completed" }, dueDate: { $lt: now } }, "title projectId dueDate").lean();
  for (const ms of delayedMs.slice(0, 3)) {
    risks.push({ level: "Medium", type: "delayed_milestone", title: `Milestone delayed: ${ms.title}`,
      message: `Milestone "${ms.title}" passed its due date.`,
      action: "Update timeline or escalate to manager", meta: { milestoneId: ms._id } });
  }

  // 5. Sprint at risk
  const activeSprints = await Sprint.find({
    orgId, status: "Active", $or: [{ projectId: { $in: projectIds } }, { createdBy: uid }], endDate: { $exists: true, $ne: null },
  }).populate("tasks", "status").lean();

  for (const sprint of activeSprints) {
    const daysLeft  = Math.ceil((new Date(sprint.endDate) - now) / 86_400_000);
    const tasks     = sprint.tasks ?? [];
    const remaining = tasks.filter((t) => t.status !== "Done").length;
    if (daysLeft > 0 && daysLeft <= 3 && tasks.length > 0 && remaining / tasks.length > 0.5) {
      risks.push({ level: "High", type: "sprint_at_risk", title: `Sprint "${sprint.name}" at risk`,
        message: `${remaining}/${tasks.length} tasks open with ${daysLeft} day(s) left.`,
        action: "Reprioritize sprint tasks or adjust scope", meta: { sprintId: sprint._id, remaining, daysLeft } });
    }
  }

  // 6. Stalled reviews (>48h)
  const stalledReviews = await Task.find({
    orgId, projectId: { $in: projectIds }, status: "In-Review",
    submittedAt: { $lt: new Date(Date.now() - 48 * 3_600_000) },
  }, "title").lean();

  if (stalledReviews.length > 0) {
    risks.push({ level: "Medium", type: "stalled_reviews", title: `${stalledReviews.length} task(s) stalled in review`,
      message: `${stalledReviews.length} task(s) awaiting review 48+ hours.`,
      action: "Process review queue to unblock your team", meta: { count: stalledReviews.length } });
  }

  const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  risks.sort((a, b) => (PRIORITY_ORDER[a.level] ?? 3) - (PRIORITY_ORDER[b.level] ?? 3));

  res.json({ risks, totalRisks: risks.length, criticalCount: risks.filter((r) => r.level === "Critical").length });
}

// ── GET /api/teamlead/activity ────────────────────────────────────────────────
export async function getActivity(req, res) {
  const { id: userId, orgId } = req.user;
  const uid = new mongoose.Types.ObjectId(userId);
  const projectIds = await getTLProjectIds(userId, orgId);
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const typeFilter = req.query.type;
  const events = [];

  if (!typeFilter || typeFilter === "task") {
    const recentTasks = await Task.find({
      orgId, projectId: { $in: projectIds }, updatedAt: { $gte: new Date(Date.now() - 7 * 86_400_000) },
    }, "title status priority assignee createdBy updatedAt isLate")
      .populate("assignee", "name role").populate("createdBy", "name role")
      .sort({ updatedAt: -1 }).limit(30).lean();

    for (const t of recentTasks) {
      const statusMap = { "Done": "task_completed", "In-Review": "task_review", "In-Progress": "task_started" };
      const actor = t.assignee ?? t.createdBy;
      events.push({ id: `task-${t._id}-${t.status}`, type: statusMap[t.status] ?? "task_updated",
        actor: { name: actor?.name ?? "Unknown", role: actor?.role },
        subject: t.title, timestamp: t.updatedAt,
        meta: { taskId: t._id, status: t.status, priority: t.priority, isLate: t.isLate } });
    }
  }

  if (!typeFilter || typeFilter === "milestone") {
    const recentMs = await Milestone.find({
      projectId: { $in: projectIds }, updatedAt: { $gte: new Date(Date.now() - 14 * 86_400_000) },
    }, "title status updatedAt createdBy").populate("createdBy", "name role").sort({ updatedAt: -1 }).limit(15).lean();

    for (const m of recentMs) {
      events.push({ id: `ms-${m._id}`, type: m.status === "Completed" ? "milestone_completed" : "milestone_updated",
        actor: { name: m.createdBy?.name ?? "System", role: m.createdBy?.role },
        subject: m.title, timestamp: m.updatedAt, meta: { milestoneId: m._id, status: m.status } });
    }
  }

  if (!typeFilter || typeFilter === "sprint") {
    const recentSprints = await Sprint.find({
      orgId, $or: [{ projectId: { $in: projectIds } }, { createdBy: uid }],
      updatedAt: { $gte: new Date(Date.now() - 14 * 86_400_000) },
    }, "name status createdBy updatedAt").populate("createdBy", "name role").sort({ updatedAt: -1 }).limit(10).lean();

    for (const s of recentSprints) {
      const typeMap = { Completed: "sprint_completed", Active: "sprint_activated" };
      events.push({ id: `sprint-${s._id}`, type: typeMap[s.status] ?? "sprint_created",
        actor: { name: s.createdBy?.name ?? "Team Lead", role: s.createdBy?.role },
        subject: s.name, timestamp: s.updatedAt, meta: { sprintId: s._id, status: s.status } });
    }
  }

  if (!typeFilter || typeFilter === "resource") {
    const recentReqs = await Approval.find({
      requestedBy: uid, actionType: "RESOURCE_REQUEST",
      updatedAt: { $gte: new Date(Date.now() - 14 * 86_400_000) },
    }, "payload status updatedAt").sort({ updatedAt: -1 }).limit(10).lean();

    for (const r of recentReqs) {
      events.push({ id: `req-${r._id}`, type: "resource_request",
        actor: { name: "You", role: "Team Lead" },
        subject: `${r.payload?.requestedRole ?? "Resource"} request`,
        timestamp: r.updatedAt, meta: { approvalId: r._id, status: r.status, urgency: r.payload?.urgency } });
    }
  }

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({ events: events.slice(0, limit), total: events.length });
}

// =============================================================================
// PHASE 6 — FULL TL PROFILE (operational command profile)
// =============================================================================

// ── Helper: compute consecutive working-day streak (skips Sat/Sun) ────────────
function computeWorkingDayStreak(timestamps) {
  if (!timestamps.length) return { current: 0, best: 0 };

  // Unique working-day keys (YYYY-M-D), sorted newest first
  const daySet = new Set();
  for (const ts of timestamps) {
    const d = new Date(ts);
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      daySet.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    }
  }
  if (!daySet.size) return { current: 0, best: 0 };

  const sorted = [...daySet].map((k) => {
    const [y, m, d] = k.split("-").map(Number);
    return new Date(y, m, d);
  }).sort((a, b) => b - a);

  let current = 1, streak = 1, best = 1;
  const todayWd = new Date(); todayWd.setHours(0,0,0,0);
  const latestWd = sorted[0]; latestWd.setHours(0,0,0,0);
  // If last activity was not today or yesterday (working day), current streak is 0
  const gapToToday = Math.round((todayWd - latestWd) / 86_400_000);
  if (gapToToday > 3) current = 0; // >3 days gap means streak broken even accounting for weekends

  for (let i = 1; i < sorted.length; i++) {
    const gap = Math.round((sorted[i - 1] - sorted[i]) / 86_400_000);
    if (gap <= 3) { streak++; best = Math.max(best, streak); }
    else          { streak = 1; }
  }
  best = Math.max(best, current);
  return { current, best };
}

// ── Helper: generate smart insights ──────────────────────────────────────────
function generateInsights({ teamEfficiencyScore, workloadStabilityScore, riskManagementScore,
  deadlineAdherenceRate, delayedMilestonesCount, overdueTasks,
  overloadedMembers, revisionRate, approvalResponseSpeedH, tlStats }) {

  const insights = [];

  if (teamEfficiencyScore >= 80)
    insights.push({ type: "positive", message: `Team efficiency is strong at ${teamEfficiencyScore}%` });
  else if (teamEfficiencyScore < 55)
    insights.push({ type: "warning", message: `Team efficiency needs attention — currently at ${teamEfficiencyScore}%` });

  if (delayedMilestonesCount > 0)
    insights.push({ type: "critical", message: `${delayedMilestonesCount} milestone${delayedMilestonesCount > 1 ? "s are" : " is"} currently delayed or at risk` });
  else if (deadlineAdherenceRate >= 90)
    insights.push({ type: "positive", message: `Excellent deadline adherence at ${deadlineAdherenceRate}%` });

  if (workloadStabilityScore >= 85)
    insights.push({ type: "positive", message: "Workload distribution is healthy across your team" });
  else if (overloadedMembers > 0)
    insights.push({ type: "warning", message: `${overloadedMembers} team member${overloadedMembers > 1 ? "s are" : " is"} currently overloaded` });

  if (revisionRate > 30)
    insights.push({ type: "warning", message: `Revision rate is ${revisionRate}% — consider earlier feedback loops` });
  else if (revisionRate <= 10 && revisionRate >= 0)
    insights.push({ type: "positive", message: `Low revision rate (${revisionRate}%) — your team's quality is strong` });

  if (approvalResponseSpeedH > 0 && approvalResponseSpeedH <= 6)
    insights.push({ type: "positive", message: `Fast review turnaround — avg ${approvalResponseSpeedH}h response time` });
  else if (approvalResponseSpeedH > 24)
    insights.push({ type: "warning", message: `Review response time is slow (avg ${approvalResponseSpeedH}h) — blocking your team` });

  if ((tlStats?.consecutiveOnTime ?? 0) >= 3)
    insights.push({ type: "positive", message: `${tlStats.consecutiveOnTime} consecutive on-time deliveries — outstanding streak!` });

  if (overdueTasks > 3)
    insights.push({ type: "critical", message: `${overdueTasks} overdue tasks need immediate attention` });

  if (riskManagementScore >= 85)
    insights.push({ type: "positive", message: `Risk posture is excellent — operations running smoothly` });

  return insights.slice(0, 6);
}

// ── GET /api/teamlead/profile/full ────────────────────────────────────────────
export async function getTLFullProfile(req, res) {
  const { id: userId, orgId } = req.user;
  const uid = new mongoose.Types.ObjectId(userId);
  const now = new Date();

  // ── 1. User + Gamification (parallel) ────────────────────────────────────
  const [user, rawProfile, projects] = await Promise.all([
    User.findById(userId, "name email role department status orgId createdAt").lean(),
    GamificationProfile.findOne({ userId }).lean(),
    Project.find({ orgId, members: uid, isDeleted: { $ne: true } }, "_id title status members deadline createdAt").lean(),
  ]);
  if (!user) return res.status(404).json({ error: "User not found." });

  let gamProfile = rawProfile;
  if (!gamProfile) {
    gamProfile = (await GamificationProfile.create({ userId, orgId })).toObject();
  }
  const tlStats = gamProfile.tlStats ?? {};

  // Enrich stored badges with emoji from TL_BADGE_DEFINITIONS
  const badgeDefMap = Object.fromEntries(
    (TL_BADGE_DEFINITIONS ?? []).map((b) => [b.id, b])
  );
  const enrichedBadges = (gamProfile.badges ?? []).map((b) => ({
    ...b,
    emoji:       badgeDefMap[b.id]?.emoji       ?? "🏅",
    description: badgeDefMap[b.id]?.desc        ?? "",
    category:    badgeDefMap[b.id]?.category    ?? b.type ?? "general",
  }));

  // ── 2. Projects (loaded in round 1) ─────────────────────────────────────
  const projectIds        = projects.map((p) => p._id);
  const activeProjects    = projects.filter((p) => !["Completed","Archived","Deleted"].includes(p.status));

  if (!projectIds.length) {
    // No projects — return minimal profile
    return res.json({
      user:          { id: user._id, name: user.name, email: user.email, role: user.role, department: user.department, orgId: user.orgId, joinedAt: user.createdAt },
      gamification:  { level: gamProfile.level ?? 1, currentXp: gamProfile.currentXp ?? 0, maxXp: gamProfile.maxXp ?? 100, totalXp: gamProfile.totalXp ?? 0, gold: gamProfile.gold ?? 0, hp: gamProfile.hp ?? 100, badges: enrichedBadges, titles: gamProfile.titles ?? [], activeTitle: gamProfile.activeTitle, tlStats, leaderboardRank: 1, totalTLs: 1, streakDays: { current: 0, best: 0 } },
      performance:   { projectsHandled: 0, activeMilestonesCount: 0, tasksManaged: 0, taskSuccessRate: 0, avgDeliveryDays: 0, teamEfficiencyScore: 0, deadlineAdherenceRate: 0, approvalResponseSpeedH: 0 },
      operational:   { projectOversightCount: 0, activeOperationsCount: 0, teamPerformanceScore: 0, workloadStabilityScore: 100, riskManagementScore: 100 },
      teamMembers:   [],
      recentActivity: [],
      insights:      [{ type: "neutral", message: "You are not yet assigned to any projects." }],
    });
  }

  // ── 3. Milestones + Tasks (parallel) ─────────────────────────────────────
  const [milestones, allTasks] = await Promise.all([
    Milestone.find({ projectId: { $in: projectIds } }).lean(),
    Task.find(
      { orgId, projectId: { $in: projectIds } },
      "status priority deadline completedAt createdAt submittedAt reviewedAt reviewedBy isLate assignee assignees"
    ).lean(),
  ]);

  const activeMilestones   = milestones.filter((m) => ["In Progress","In-Progress","Not Started"].includes(m.status));
  const completedMilestones = milestones.filter((m) => m.status === "Completed");
  const delayedMilestones   = milestones.filter((m) =>
    m.status === "Delayed" || (m.dueDate && new Date(m.dueDate) < now && m.status !== "Completed")
  );

  // Deadline adherence
  const deliveredOnTime = completedMilestones.filter((m) =>
    m.completedAt && m.dueDate && new Date(m.completedAt) <= new Date(m.dueDate)
  ).length;
  const deadlineAdherenceRate = completedMilestones.length > 0
    ? Math.round((deliveredOnTime / completedMilestones.length) * 100) : 0;

  // Tasks metrics
  const doneTasks      = allTasks.filter((t) => t.status === "Done");
  const overdueTasks   = allTasks.filter((t) => t.deadline && new Date(t.deadline) < now && t.status !== "Done");
  const reviewedByMeTasks = allTasks.filter((t) => t.reviewedBy?.toString() === userId.toString());

  const totalReviewed     = Math.max(gamProfile.stats?.reviewsGiven ?? 0, reviewedByMeTasks.length);
  const reviewsApproved   = tlStats.reviewsApproved ?? 0;
  const taskSuccessRate   = totalReviewed > 0 ? Math.round((reviewsApproved / totalReviewed) * 100) : 0;
  const revisionRate      = totalReviewed > 0 ? Math.max(0, Math.round(((totalReviewed - reviewsApproved) / totalReviewed) * 100)) : 0;

  // Avg delivery time
  const deliveryTimes = doneTasks
    .filter((t) => t.completedAt && t.createdAt)
    .map((t) => (new Date(t.completedAt) - new Date(t.createdAt)) / 86_400_000);
  const avgDeliveryDays = deliveryTimes.length > 0
    ? Math.round(deliveryTimes.reduce((s, d) => s + d, 0) / deliveryTimes.length * 10) / 10 : 0;

  // Avg review response speed (hours)
  const reviewTimes = reviewedByMeTasks
    .filter((t) => t.submittedAt && t.reviewedAt)
    .map((t) => (new Date(t.reviewedAt) - new Date(t.submittedAt)) / 3_600_000);
  const approvalResponseSpeedH = reviewTimes.length > 0
    ? Math.round(reviewTimes.reduce((s, h) => s + h, 0) / reviewTimes.length * 10) / 10 : 0;

  // ── 4. Team members ───────────────────────────────────────────────────────
  const memberIdSet = new Set();
  for (const p of projects) {
    for (const m of p.members ?? []) memberIdSet.add(m.toString());
  }
  memberIdSet.delete(userId.toString());
  const memberIds = [...memberIdSet].map((id) => new mongoose.Types.ObjectId(id));

  let teamMembers            = [];
  let workloadStabilityScore = 100;
  let teamPerformanceScore   = 60;

  if (memberIds.length > 0) {
    const [memberUsers, taskAgg, memberProfiles] = await Promise.all([
      User.find({ _id: { $in: memberIds } }, "name role department status").lean(),
      Task.aggregate([
        { $match: { orgId, $or: [{ assignee: { $in: memberIds } }, { assignees: { $in: memberIds } }], status: { $in: ["To-Do","In-Progress","In-Review"] } } },
        { $addFields: { eff: { $ifNull: ["$assignee", { $arrayElemAt: ["$assignees", 0] }] } } },
        { $group: { _id: "$eff", openTasks: { $sum: 1 } } },
      ]),
      GamificationProfile.find({ userId: { $in: memberIds } }, "userId hp level currentXp stats").lean(),
    ]);

    const taskMap    = Object.fromEntries(taskAgg.map((a) => [a._id?.toString(), a.openTasks]));
    const profileMap = Object.fromEntries(memberProfiles.map((p) => [p.userId.toString(), p]));

    teamMembers = memberUsers.map((u) => {
      const uid2      = u._id.toString();
      const open      = taskMap[uid2] ?? 0;
      const allocated = Math.round(open * 1.5 * 10) / 10;
      const workload  = allocated === 0 ? "Free" : allocated <= 3 ? "Moderate" : allocated <= 5.5 ? "Busy" : "Overloaded";
      const p         = profileMap[uid2] ?? {};
      return { id: u._id, name: u.name, role: u.role, department: u.department, openTasks: open, workload, hp: p.hp ?? 100, level: p.level ?? 1, xp: p.currentXp ?? 0 };
    }).sort((a, b) => b.openTasks - a.openTasks);

    const overloadedCount    = teamMembers.filter((m) => m.workload === "Overloaded").length;
    const avgHp              = teamMembers.reduce((s, m) => s + m.hp, 0) / (teamMembers.length || 1);
    workloadStabilityScore   = Math.max(0, Math.round(100 - (overloadedCount / teamMembers.length) * 55 - (delayedMilestones.length * 4)));
    teamPerformanceScore     = Math.min(100, Math.round(avgHp * 0.5 + (deadlineAdherenceRate * 0.3) + (taskSuccessRate * 0.2)));
  }

  // ── 5. Composite scores ───────────────────────────────────────────────────
  const lateTaskPct = allTasks.length > 0
    ? Math.round((allTasks.filter((t) => t.isLate).length / allTasks.length) * 100) : 0;
  const teamEfficiencyScore = Math.max(0, Math.min(100, Math.round(
    deadlineAdherenceRate * 0.35 + (100 - lateTaskPct) * 0.25 +
    (100 - revisionRate) * 0.20  + workloadStabilityScore * 0.20
  )));
  const riskPenalty        = (delayedMilestones.length * 8) + (overdueTasks.length * 2) + (teamMembers.filter((m) => m.workload === "Overloaded").length * 6);
  const riskManagementScore = Math.max(0, 100 - riskPenalty);

  // ── 6-8. Rank, streak and recent activity are independent: one parallel round (D-078) ──
  let allTLUsers = []; // used for totalTLs below (was scoped inside rankedTLs → ReferenceError, profile 500)
  const rankedTLs = async () => {
    allTLUsers = await User.find({ orgId, role: "Team Lead", status: { $ne: "deleted" } }, "_id").lean();
    return GamificationProfile.find({ userId: { $in: allTLUsers.map((u) => u._id) } }, "userId tlStats").lean();
  };
  const activityEvents = [];
  const [tlGamProfs, xpLogs, recentTasksAct, recentMsAct, recentSprintsAct] = await Promise.all([
    rankedTLs(),
    XpLog.find({ userId, source: { $regex: /^tl_/ } }, "createdAt").sort({ createdAt: -1 }).limit(200).lean(),
    Task.find({ orgId, projectId: { $in: projectIds }, updatedAt: { $gte: new Date(Date.now() - 7*86_400_000) } },
      "title status priority assignee createdBy updatedAt isLate")
      .populate("assignee", "name role").populate("createdBy", "name role")
      .sort({ updatedAt: -1 }).limit(15).lean(),
    Milestone.find({ projectId: { $in: projectIds }, updatedAt: { $gte: new Date(Date.now() - 14*86_400_000) } },
      "title status updatedAt").sort({ updatedAt: -1 }).limit(10).lean(),
    Sprint.find({ orgId, $or: [{ projectId: { $in: projectIds } }, { createdBy: uid }], updatedAt: { $gte: new Date(Date.now() - 14*86_400_000) } },
      "name status updatedAt").sort({ updatedAt: -1 }).limit(5).lean(),
  ]);

  // ── 6. Leaderboard rank ───────────────────────────────────────────────────
  const ranked      = tlGamProfs.map((p) => {
    const s = p.tlStats ?? {};
    return { uid: String(p.userId), score: (s.milestonesDelivered ?? 0)*10 + (s.milestonesOnTime ?? 0)*8 + (s.sprintsCompleted ?? 0)*6 + (s.reviewsApproved ?? 0)*2 + (s.consecutiveOnTime ?? 0)*10 };
  }).sort((a, b) => b.score - a.score);
  const leaderboardRank = (ranked.findIndex((r) => r.uid === userId.toString()) + 1) || ranked.length;

  // ── 7. Working-day streak ─────────────────────────────────────────────────
  const streakDays = computeWorkingDayStreak(xpLogs.map((l) => l.createdAt));

  // ── 8. Recent activity ────────────────────────────────────────────────────
  const STATUS_ICON_MAP = {
    Done: "✅", "In-Review": "🔍", "In-Progress": "⚙️",
    Completed: "🏆", Delayed: "⚠️", Active: "🚀",
  };

  for (const t of recentTasksAct) {
    const statusMap = { Done: "task_completed", "In-Review": "task_review", "In-Progress": "task_started" };
    const actor     = t.assignee ?? t.createdBy;
    activityEvents.push({ id: `task-${t._id}`, type: statusMap[t.status] ?? "task_updated",
      icon: STATUS_ICON_MAP[t.status] ?? "📋",
      actor: { name: actor?.name ?? "Unknown", role: actor?.role },
      subject: t.title, timestamp: t.updatedAt,
      meta: { status: t.status, priority: t.priority, isLate: t.isLate } });
  }
  for (const m of recentMsAct) {
    activityEvents.push({ id: `ms-${m._id}`, type: m.status === "Completed" ? "milestone_completed" : "milestone_updated",
      icon: m.status === "Completed" ? "🏆" : "🎯",
      actor: { name: "You", role: "Team Lead" }, subject: m.title,
      timestamp: m.updatedAt, meta: { status: m.status } });
  }
  for (const s of recentSprintsAct) {
    activityEvents.push({ id: `sprint-${s._id}`, type: "sprint_updated",
      icon: "⚡", actor: { name: "You", role: "Team Lead" },
      subject: s.name, timestamp: s.updatedAt, meta: { status: s.status } });
  }
  activityEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // ── 9. Quick insights ─────────────────────────────────────────────────────
  const insights = generateInsights({
    teamEfficiencyScore, workloadStabilityScore, riskManagementScore, deadlineAdherenceRate,
    delayedMilestonesCount: delayedMilestones.length, overdueTasks: overdueTasks.length,
    overloadedMembers: teamMembers.filter((m) => m.workload === "Overloaded").length,
    revisionRate, approvalResponseSpeedH, tlStats,
  });

  // ── Response ──────────────────────────────────────────────────────────────
  res.json({
    user: {
      id:         user._id,
      name:       user.name,
      email:      user.email,
      role:       user.role,
      department: user.department ?? "—",
      status:     user.status,
      orgId:      user.orgId,
      joinedAt:   user.createdAt,
    },
    gamification: {
      level:          gamProfile.level    ?? 1,
      currentXp:      gamProfile.currentXp ?? 0,
      maxXp:          gamProfile.maxXp    ?? 100,
      totalXp:        gamProfile.totalXp  ?? 0,
      gold:           gamProfile.gold     ?? 0,
      hp:             gamProfile.hp       ?? 100,
      badges:         enrichedBadges,
      titles:         gamProfile.titles   ?? [],
      activeTitle:    gamProfile.activeTitle ?? null,
      tlStats,
      leaderboardRank,
      totalTLs:       allTLUsers.length,
      streakDays,
    },
    performance: {
      projectsHandled:       projects.length,
      activeMilestonesCount: activeMilestones.length,
      tasksManaged:          allTasks.length,
      taskSuccessRate,
      avgDeliveryDays,
      teamEfficiencyScore,
      deadlineAdherenceRate,
      approvalResponseSpeedH,
    },
    operational: {
      projectOversightCount:  activeProjects.length,
      activeOperationsCount:  activeMilestones.length,
      teamPerformanceScore,
      workloadStabilityScore,
      riskManagementScore,
    },
    teamMembers:    teamMembers.slice(0, 12),
    recentActivity: activityEvents.slice(0, 25),
    insights,
  });
}

