import { openLimitRequest } from "../services/limitRequest.js";
import { awardTLReviewXp } from "../services/tlGamificationService.js";
import AuditLog from "../models/AuditLog.js";
import { statusMoveBlocker, isNoOpStatus } from "../services/teamLeadRules.js";
import { attemptDelta } from "../services/reviewRules.js";
import { employeeTaskView, reviewNoticeTargets } from "../services/submitRules.js";
import { taskPeople } from "../services/taskPeople.js";
import { createNotification } from "./notificationController.js";
import Project from "../models/Project.js";
import { approvalBlock, isSelfReview } from "../services/reviewRules.js";
import { mentionedIds, toggleReaction, canChangeComment } from "../services/commentRules.js";
import { notifyQaNeeded } from "../services/qaNotify.js";
import { EMPLOYEE_CATEGORIES, isEmployee, employeeCanReadTask, reviewListAccess, seniorMayReview, tlAssignBlock, stripCloudinarySignature, taskEventAudience } from "../services/accessRules.js";
import { firstLengthError } from "../services/textLimits.js";
import mongoose        from "mongoose";
import Task            from "../models/Task.js";
import User, { ROLE_CATEGORY_MAP } from "../models/User.js";
import Notification    from "../models/Notification.js";
import Sprint          from "../models/Sprint.js";
import GamificationProfile from "../models/GamificationProfile.js";
import emitter         from "../utils/emitter.js";
import { lateAtSubmission, XP_VALUE_MIN, XP_VALUE_MAX } from "../services/xpEngine.js";
import { unfinishedPrereqs, findDependencyCycle, linkErrors } from "../services/taskRules.js";
import { evaluateSubmission, aiEvalView, finalScore } from "../services/aiEvalService.js";
import { parseTlScore, DESIGN_CHECKLIST } from "../services/aiEvalRules.js";

const SUBMISSION_CONTENT_MAX = 100_000; // raw cap; the AI sees at most 300 lines / 12 KB (D-060/D-062)

const IS_OID = /^[0-9a-f]{24}$/i;

// V1 1.9: validate parentId / dependsOn against the org's tasks. Returns { error } or { links }.
export async function resolveLinks(orgId, { parentId, dependsOn }, selfId = null) {
  const links = {};
  const ids = dependsOn === undefined ? undefined : [...new Set((Array.isArray(dependsOn) ? dependsOn : []).map(String))];
  if ((parentId && !IS_OID.test(String(parentId))) || (ids ?? []).some((d) => !IS_OID.test(d))) {
    return { error: "Invalid task id in parent or prerequisites." };
  }
  const parent = parentId ? await Task.findOne({ _id: parentId, orgId }, "_id parentId").lean() : null;
  if (parentId && !parent) return { error: "Parent task not found." };
  const shapeErr = linkErrors({ selfId, parentId, dependsOn: ids ?? [], parent });
  if (shapeErr) return { error: shapeErr };
  if (parentId !== undefined) links.parentId = parentId || null;
  if (ids) {
    const found = await Task.countDocuments({ _id: { $in: ids }, orgId });
    if (found !== ids.length) return { error: "One or more prerequisites were not found." };
    if (selfId && ids.length) {
      const rows = await Task.find({ orgId, "dependsOn.0": { $exists: true } }, "_id dependsOn").lean();
      const graph = Object.fromEntries(rows.map((r) => [String(r._id), r.dependsOn.map(String)]));
      const cycle = findDependencyCycle(selfId, ids, graph);
      if (cycle) return { error: "These prerequisites would create a loop between tasks." };
    }
    links.dependsOn = ids;
  }
  return { links };
}

// V1 1.9: list unfinished prerequisites of a task (empty = free to start/submit).
async function blockingPrereqs(task) {
  if (!task.dependsOn?.length) return [];
  const prereqs = await Task.find({ _id: { $in: task.dependsOn } }, "title status").lean();
  return unfinishedPrereqs(prereqs);
}

// D-066: xpValue is optional; when given it must be a whole number 10-1000.
function badXpValue(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= XP_VALUE_MIN && n <= XP_VALUE_MAX ? null : `XP value must be a whole number from ${XP_VALUE_MIN} to ${XP_VALUE_MAX}.`;
}
import { getIo }       from "../utils/io.js";
import { validateTaskAssignment, ROLE_TO_CATEGORY, ROLE_TASK_ELIGIBILITY } from "../services/workloadService.js";

// S-1 (D-158): router.param guard for employees on /api/tasks/:id*.
export async function employeeTaskScope(req, res, next) {
  const none = () => res.status(404).json({ error: "Task not found." });
  if (!mongoose.isValidObjectId(req.params.id)) return none();
  const task = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId }, "assignees assignee createdBy assignedBy projectId").lean();
  if (!task) return none();
  const project = task.projectId ? await Project.findById(task.projectId, "members").lean() : null;
  return employeeCanReadTask(req.user, task, project) ? next() : none();
}

// S-1 (D-159): plain employees never; a Senior sees their juniors' tasks on projects they are on. null = answered 403.
async function reviewListFilter(req, res) {
  const access = reviewListAccess(req.user);
  if (!access) { res.status(403).json({ error: "Review lists are for reviewers." }); return null; }
  if (access === "all") return {};
  const [juniors, projects] = await Promise.all([
    User.find({ orgId: req.user.orgId, role: SENIOR_JUNIOR[req.user.role] }, "_id").lean(),
    Project.find({ members: req.user.id }, "_id").lean(),
  ]);
  return { assignee: { $in: juniors.map((j) => j._id) }, projectId: { $in: projects.map((p) => p._id) }, reviewStage: "none" };
}

const SENIOR_JUNIOR = {
  "Senior Developer": "Junior Developer",
  "Senior Designer":  "Junior Designer",
  "Senior Tester":    "Junior Tester",
};

const JUNIOR_SENIOR = {
  "Junior Developer": "Senior Developer",
  "Junior Designer":  "Senior Designer",
  "Junior Tester":    "Senior Tester",
};

const VALID_STATUSES = ["Backlog", "To-Do", "In-Progress", "In-Review", "Done"];

// ── POST /api/tasks ───────────────────────────────────────────────────────────
export async function createTask(req, res) {
  const {
    title, description, type, priority,
    assigneeId, assignees = [], xpValue, goldValue, parentId, dependsOn,
    dueDate, deadline, projectId, milestoneId, sprintId, labels,
    // Phase 7: workload engine fields
    estimatedHours, difficulty,
    // Phase 7: scheduling fields
    startDate, endDate,
  } = req.body;

  const assignerRole = req.user.role;
  const { id: createdBy, orgId } = req.user;
  // V2 2.2: tags (AI may suggest them; the TL keeps or edits). Max 5, 24 chars, lowercase.
  const tagList = Array.isArray(req.body.tags)
    ? [...new Set(req.body.tags.map((t) => String(t).trim().toLowerCase()).filter((t) => t && t.length <= 24))].slice(0, 5) : [];
  const io = getIo();

  if (!title?.trim()) return res.status(400).json({ error: "Title is required." });
  const tooLongTitle = firstLengthError([["Task title", title, "taskTitle"]]); // U-1 (D-130)
  if (tooLongTitle) return res.status(400).json({ error: tooLongTitle });
  if (!type)          return res.status(400).json({ error: "Type is required." });
  const xpErr = badXpValue(xpValue);
  if (xpErr) return res.status(400).json({ error: xpErr });
  const { error: linkErr, links } = await resolveLinks(req.user.orgId, { parentId, dependsOn });
  if (linkErr) return res.status(400).json({ error: linkErr });

  // ── Director cannot assign tasks ──────────────────────────────────────────
  if (assignerRole === "Director") {
    return res.status(403).json({ error: "Directors do not assign tasks" });
  }

  // ── Single-assignee path (new role-based workflow) ────────────────────────
  if (assigneeId) {
    const assignee = await User.findById(assigneeId).lean();
    if (!assignee) return res.status(404).json({ error: "Assignee not found" });
    if (assignee.orgId.toString() !== req.user.orgId.toString()) {
      return res.status(403).json({ error: "Cannot assign tasks across organizations" });
    }
    if (assignee.role === "Director") {
      return res.status(403).json({ error: "Cannot assign tasks to Director" });
    }

    // D-160 (D-156-1): a Team Lead assigns any Developer, Designer or Tester on the project.
    if (assignerRole === "Team Lead") {
      const project = projectId && mongoose.isValidObjectId(projectId) ? await Project.findById(projectId, "members").lean() : null;
      const blocked = tlAssignBlock({ id: assignee._id, roleCategory: ROLE_CATEGORY_MAP[assignee.role] }, project);
      if (blocked) return res.status(403).json({ error: blocked });
    }

    // Rule: Senior → specific Junior only, requires TL approval
    if (SENIOR_JUNIOR[assignerRole]) {
      if (assignee.role !== SENIOR_JUNIOR[assignerRole]) {
        return res.status(403).json({
          error: `${assignerRole} can only assign to ${SENIOR_JUNIOR[assignerRole]}`,
        });
      }

      // Find TL to approve; fall back to Manager
      const tl =
        (await User.findOne({
          orgId,
          role:       "Team Lead",
          department: assignee.department,
          status:     "active",
        }).lean()) ||
        (await User.findOne({ orgId, role: "Manager", status: "active" }).lean());

      const effectiveDeadline = dueDate ?? deadline ?? null;
      const task = await Task.create({
        ...links, tags: tagList,
        orgId,
        title:        title.trim(),
        description:  description ?? "",
        type:         type || "Feature",
        priority:     priority ?? "Medium",
        status:       "Backlog",
        assignee:     assigneeId,
        assignees:    [assigneeId],
        assignedBy:   createdBy,
        assignerRole,
        createdBy,
        deadline:     effectiveDeadline,
        projectId:    projectId    ?? null,
        milestoneId:  milestoneId  ?? null,
        xpValue:      xpValue  != null && xpValue !== "" ? +xpValue : null, // D-066: null → priority default (model)
        goldValue:    goldValue != null ? +goldValue : 50,
        labels:       labels ?? [],
      });

      if (tl) {
        await Notification.create({
          userId:   tl._id,
          orgId,
          type:     "approval_required",
          message:  `${req.user.name} wants to assign "${title}" to ${assignee.name}. Approve?`,
          meta: { taskId: task._id, action: "task_assignment" },
        });
        if (io) io.to(`user:${tl._id}`).emit("notification:new", { type: "approval_required" });
      }

      return res.status(202).json({
        task,
        message:  "Assignment sent to Team Lead for approval",
        warnings: [],
      });
    }

    // Phase 7: Workload engine validation (non-blocking — returns warnings + errors)
    const effectiveDeadline = dueDate ?? deadline ?? null;
    const validation = await validateTaskAssignment({
      assigneeId,
      estimatedHours: estimatedHours != null ? +estimatedHours : null,
      taskType:       type,
      difficulty:     difficulty ?? "Medium",
      deadline:       effectiveDeadline,
      orgId,
    });

    const warnings = [...(validation.warnings ?? [])];
    // All validation errors (eligibility, capacity, overload) are non-blocking warnings.
    // The assigning TL/Manager knows their team — we inform but never block task creation.
    warnings.push(...(validation.errors ?? []));

    const task = await Task.create({
        ...links, tags: tagList,
      orgId,
      title:          title.trim(),
      description:    description ?? "",
      type:           type || "Feature",
      priority:       priority ?? "Medium",
      difficulty:     difficulty ?? "Medium",
      estimatedHours: estimatedHours != null ? +estimatedHours : null,
      status:         "To-Do",
      assignee:       assigneeId,
      assignees:      [assigneeId],
      assignedBy:     createdBy,
      assignerRole,
      createdBy,
      deadline:       effectiveDeadline,
      startDate:      startDate ? new Date(startDate) : null,
      endDate:        endDate   ? new Date(endDate)   : null,
      projectId:      projectId   ?? null,
      milestoneId:    milestoneId ?? null,
      xpValue:        xpValue  != null && xpValue !== "" ? +xpValue : null, // D-066: null → priority default (model)
      goldValue:      goldValue != null ? +goldValue : 50,
      labels:         labels ?? [],
      workloadWarning: validation.projectedTier === "Critical Overload" || (validation.snapshot?.activeTaskCount ?? 0) >= 5,
      assigneeLoadAtAssignment: validation.snapshot?.utilisation ?? null,
    });

    await Notification.create({
      userId:   assigneeId,
      orgId,
      type:     "task_assigned",
      message:  `New task: "${title}"${effectiveDeadline ? ` — Due ${new Date(effectiveDeadline).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}. Priority: ${priority ?? "Medium"}`,
      meta: { taskId: task._id },
    });
    if (io) io.to(`user:${assigneeId}`).emit("notification:new", { type: "task_assigned" });

    return res.status(201).json({ task, warnings });
  }

  // ── Multi-assignee path (legacy / manager bulk assign) ────────────────────
  if (assignees.length > 0) {
    const found = await User.find(
      { _id: { $in: assignees }, orgId, status: { $ne: "deleted" } },
      "_id"
    ).lean();
    if (found.length !== assignees.length) {
      return res.status(400).json({ error: "One or more assignees not found in your organisation." });
    }
  }

  const effectiveDeadline = dueDate ?? deadline ?? null;

  // 4.2a: same workload check as the single-assignee path, per assignee (non-blocking warnings).
  const multiWarnings = [];
  let   multiOverload = false;
  for (const uid of assignees) {
    const v = await validateTaskAssignment({
      assigneeId:     uid,
      estimatedHours: estimatedHours != null ? +estimatedHours : null,
      taskType:       type,
      difficulty:     difficulty ?? "Medium",
      deadline:       effectiveDeadline,
      orgId,
    });
    multiWarnings.push(...(v.warnings ?? []), ...(v.errors ?? []));
    if (v.projectedTier === "Critical Overload") multiOverload = true;
  }

  const task = await Task.create({
        ...links, tags: tagList,
    workloadWarning: multiOverload,
    title:          title.trim(),
    description:    description ?? "",
    type,
    priority:       priority ?? "Medium",
    difficulty:     difficulty ?? "Medium",
    estimatedHours: estimatedHours != null ? +estimatedHours : null,
    status:      "To-Do",
    orgId,
    projectId:   projectId ?? null,
    createdBy,
    assignees,
    assignedBy:  createdBy,
    assignerRole,
    xpValue:     xpValue  != null && xpValue !== "" ? +xpValue : null, // D-066: null → priority default (model)
    goldValue:   goldValue != null ? +goldValue : 50,
    deadline:    effectiveDeadline,
    labels:      labels ?? [],
  });

  if (assignees.length > 0) {
    await Promise.all(
      assignees.map((uid) =>
        Notification.create({
          userId:  uid,
          orgId,
          type:    "task_assigned",
          title:   "New Task Assigned",
          message: `You've been assigned: ${task.title}`,
        })
      )
    );
  }

  const populated = await Task.findById(task._id)
    .populate("assignees", "name role")
    .populate("createdBy", "name")
    .lean();

  return res.status(201).json({ success: true, task: populated, warnings: multiWarnings });
}

// ── GET /api/tasks ────────────────────────────────────────────────────────────
export async function getTasks(req, res) {
  const { id: userId, orgId, roleCategory } = req.user;
  const { status, priority, type, projectId, milestoneId, page = 1, limit = 100 } = req.query;

  // D-055: no auto-start on read; the assignee starts the task.

  const filter = { orgId };

  if (EMPLOYEE_CATEGORIES.includes(roleCategory)) {
    filter.$or = [{ assignees: userId }, { assignee: userId }];
  }

  if (status)      filter.status      = status;
  if (priority)    filter.priority    = priority;
  if (type)        filter.type        = type;
  if (projectId)   filter.projectId   = projectId;
  if (milestoneId) filter.milestoneId = milestoneId;

  const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

  const tasks = await Task.find(filter)
    .populate("assignees", "name role")
    .populate("assignee",  "name role")
    .populate("createdBy", "name")
    .lean()
    .skip((+page - 1) * +limit)
    .limit(+limit);

  tasks.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 4;
    const pb = PRIORITY_ORDER[b.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    if (a.deadline && b.deadline) return new Date(a.deadline) - new Date(b.deadline);
    if (a.deadline) return -1;
    if (b.deadline) return  1;
    return 0;
  });

  // E-3 (D-075, Q6): employees never get an AI score; AI feedback text only after the Team Lead scored.
  res.json({ success: true, tasks: EMPLOYEE_CATEGORIES.includes(roleCategory) ? tasks.map(employeeTaskView) : tasks });
}

// ── GET /api/tasks/for-review ─────────────────────────────────────────────────
export async function getTasksForReview(req, res) {
  const scoped = await reviewListFilter(req, res); if (!scoped) return;
  const query = { orgId: req.user.orgId, status: "In-Review", ...scoped };

  const tasks = await Task.find(query)
    .populate("assignee",   "name role department avatarStyle")
    .populate("assignedBy", "name role")
    .sort({ submittedAt: 1 })
    .lean();

  res.json({ success: true, tasks });
}

// ── GET /api/tasks/review-stats ───────────────────────────────────────────────
export async function getReviewStats(req, res) {
  const [stats] = await Task.aggregate([
    {
      $match: {
        reviewedBy: new mongoose.Types.ObjectId(req.user.id),
        orgId:      req.user.orgId,
      },
    },
    {
      $group: {
        _id:             null,
        totalReviews:    { $sum: 1 },
        approvedCount:   { $sum: { $cond: [{ $eq: ["$status", "Done"] }, 1, 0] } },
        rejectedCount:   { $sum: { $cond: [{ $ne: ["$status", "Done"] }, 1, 0] } },
        avgQualityGiven: { $avg: "$qualityScore" },
      },
    },
  ]);

  res.json(
    stats ?? { totalReviews: 0, approvedCount: 0, rejectedCount: 0, avgQualityGiven: 0 }
  );
}

// ── GET /api/tasks/:id ────────────────────────────────────────────────────────
export async function getTask(req, res) {

  const task = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId })
    .select("+aiScore +aiScores")
    .populate("assignees",       "name role")
    .populate("assignee",        "name role")
    .populate("assignedBy",      "name role")
    .populate("reviewedBy",      "name role")
    .populate("createdBy",       "name")
    .populate("comments.author", "name role")
    .populate("activity.by",     "name role")
    .populate("timeLogs.user",   "name")
    .populate("dependsOn",       "title status deadline")
    .populate("parentId",        "title status")
    .lean();

  if (!task) return res.status(404).json({ error: "Task not found." });
  // AI score: Manager/Director always; others only after the review (TL scores first, spec §4).
  const reveal = ["Manager", "Director"].includes(req.user.role) || task.status !== "In-Review";
  task.subtasks = await Task.find({ parentId: task._id, orgId: req.user.orgId }, "title status deadline assignees")
    .populate("assignees", "name").sort({ createdAt: 1 }).lean();
  // E-3 (D-075): before this, an employee got the AI score once the task left In-Review.
  if (EMPLOYEE_CATEGORIES.includes(req.user.roleCategory)) return res.json({ success: true, task: employeeTaskView(task) });
  task.aiEval = aiEvalView(task, reveal);
  delete task.aiScore; delete task.aiScores;
  res.json({ success: true, task });
}

// ── PATCH /api/tasks/:id ──────────────────────────────────────────────────────
export async function updateTask(req, res) {
  const ALLOWED = [
    "title", "description", "type", "priority",
    "assignees", "xpValue", "goldValue", "deadline", "labels", "projectId", "dependsOn", "parentId",
  ];
  const updates = {};
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const tooLongTitle = firstLengthError([["Task title", updates.title, "taskTitle"]]); // U-1 (D-130)
  if (tooLongTitle) return res.status(400).json({ error: tooLongTitle });
  const xpErr = badXpValue(updates.xpValue);
  if (xpErr) return res.status(400).json({ error: xpErr });
  if (updates.xpValue === "" || updates.xpValue === null) delete updates.xpValue;
  if (updates.deadline !== undefined) updates.deadlineAlertSentAt = null; // 1.5: alert again for the new date
  if (updates.dependsOn !== undefined || updates.parentId !== undefined) {
    const { error: linkErr, links } = await resolveLinks(req.user.orgId, { parentId: updates.parentId, dependsOn: updates.dependsOn }, req.params.id);
    if (linkErr) return res.status(400).json({ error: linkErr });
    delete updates.parentId; delete updates.dependsOn;
    Object.assign(updates, links);
  }

  const oldTask = updates.assignees
    ? await Task.findOne({ _id: req.params.id, orgId: req.user.orgId }, "assignees title").lean()
    : null;

  updates.updatedAt = new Date();

  const task = await Task.findOneAndUpdate(
    { _id: req.params.id, orgId: req.user.orgId },
    { $set: updates },
    { returnDocument: "after" }
  )
    .populate("assignees", "name role")
    .lean();

  if (!task) return res.status(404).json({ error: "Task not found." });
  Task.logActivity(task._id, req.user.id, "edited", { note: Object.keys(updates).filter((k) => k !== "updatedAt").join(", ") });

  if (oldTask && updates.assignees) {
    const oldIds   = (oldTask.assignees ?? []).map((a) => a.toString());
    const newIds   = (updates.assignees ?? []).map((a) => a.toString());
    const addedIds = newIds.filter((id) => !oldIds.includes(id));

    if (addedIds.length > 0) {
      await Promise.all(
        addedIds.map((uid) =>
          Notification.create({
            userId:  uid,
            orgId:   req.user.orgId,
            type:    "task_assigned",
            title:   "New Task Assigned",
            message: `You've been assigned: ${task.title}`,
          })
        )
      );
    }
  }

  res.json({ success: true, task });
}

// ── PATCH /api/tasks/:id/status ───────────────────────────────────────────────
export async function updateTaskStatus(req, res) {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "status is required." });

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const { id: userId, role, roleCategory } = req.user;
  const task = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId });
  if (!task) return res.status(404).json({ error: "Task not found." });

  // One rule for every role (T-1, D-114): Done only through the review approval; employees own tasks, forward only;
  // leads plan Backlog / To-Do / In-Progress and never move In-Review or Done. Mirrors client/src/utils/boardRules.js.
  const isAssignee = task.assignees.some((a) => a.toString() === userId) || task.assignee?.toString() === userId;
  const blocked = statusMoveBlocker({ role, roleCategory, from: task.status, to: status, isAssignee });
  if (blocked) return res.status(blocked.status).json({ error: blocked.error });
  // D-176 (E-3): same status → nothing to do (before: Done → Done re-saved, moved completedAt and re-sent task.approved).
  if (isNoOpStatus(task.status, status)) return res.json({ success: true, task, unchanged: true });

  // V1 1.9: can't start (or submit) while a prerequisite is unfinished
  if ((status === "In-Progress" && ["Backlog", "To-Do"].includes(task.status)) || status === "In-Review") {
    const blocking = await blockingPrereqs(task);
    if (blocking.length) {
      return res.status(409).json({ error: `Finish the prerequisites first: ${blocking.map((t) => `"${t.title}" (${t.status})`).join(", ")}.`, blockedBy: blocking });
    }
  }

  const fromStatus = task.status;
  task.status    = status;
  task.updatedAt = new Date();
  if (status === "In-Review") {
    // Same lateness rule as POST /submit (D-057): fixed at the first submission.
    const now = new Date();
    const { firstSubmittedAt, isLate } = lateAtSubmission(task, now);
    task.submittedAt = now;
    task.firstSubmittedAt = firstSubmittedAt;
    task.isLate = isLate;
  }
  if (status === "Done")      task.completedAt = new Date();

  await task.save();
  Task.logActivity(task._id, userId, "status", { from: fromStatus, to: status });
  emitTaskChanged(req.user.orgId, task, status);
  if (status === "In-Review") notifyQaNeeded(task, req.user.orgId).catch((e) => console.error("[qa notify]", e.message)); // T-4 (D-137)

  if (status === "Done") {
    emitter.emit("task.approved", {
      taskId:       task._id,
      assignees:    task.assignees,
      qualityScore: req.body.qualityScore ?? 3,
      orgId:        req.user.orgId,
      taskTitle:    task.title,
    });
  }

  res.json({ success: true, task });
}

// FE-040: one event for "a task changed", sent to everyone in the org room so open
// dashboards (employee, team lead, manager) can refresh themselves.
// S12 (D-167): only to the task's people, no longer the whole org room.
function emitTaskChanged(orgId, task, status) {
  const io = getIo();
  if (!io) return;
  (task.projectId ? Project.findById(task.projectId, "members managerId").lean() : Promise.resolve(null))
    .then((p) => { for (const uid of taskEventAudience(task, p)) io.to(`user:${uid}`).emit("task:status_changed", { taskId: String(task._id), status }); })
    .catch((e) => console.error("[task event]", e.message));
}

// ── POST /api/tasks/:id/submit ────────────────────────────────────────────────
export async function submitTask(req, res) {
  const { id: userId, orgId } = req.user;
  const io = getIo();

  const task = await Task.findOne({ _id: req.params.id, orgId });
  if (!task) return res.status(404).json({ error: "Task not found" });

  // Must be the single assignee
  const isAssignee =
    task.assignee?.toString() === userId ||
    task.assignees.some((a) => a.toString() === userId);
  if (!isAssignee) {
    return res.status(403).json({ error: "Only the assignee can submit this task" });
  }

  if (!["To-Do", "In-Progress"].includes(task.status)) {
    return res.status(400).json({ error: "Task cannot be submitted in current status" });
  }
  const blocking = await blockingPrereqs(task); // V1 1.9
  if (blocking.length) {
    return res.status(409).json({ error: `Finish the prerequisites first: ${blocking.map((t) => `"${t.title}"`).join(", ")}.`, blockedBy: blocking });
  }

  if (task.resubmissionCount >= task.maxResubmissions) {
    return res.status(400).json({
      error: `Maximum ${task.maxResubmissions} submissions reached. Contact your Manager.`,
    });
  }

  let links = [];
  try { links = JSON.parse(req.body.links || "[]"); } catch {}

  // Text the AI may read (D-060..062). Files are never sent to the AI.
  const content = String(req.body.content ?? "");
  if (content.length > SUBMISSION_CONTENT_MAX) {
    return res.status(413).json({ error: "The pasted text is too long (100,000 characters max). Attach the full file and paste the main part." });
  }
  let checklist = [];
  try { checklist = JSON.parse(req.body.checklist || "[]"); } catch {}
  const allowedChecks = new Set(DESIGN_CHECKLIST.map((c) => c.key));
  // E-3: "ac:<n>" = acceptance criterion n ticked by the person in the composer.
  checklist = Array.isArray(checklist) ? [...new Set(checklist.map(String))].filter((k) => allowedChecks.has(k) || (/^ac:\d$/.test(k) && Number(k.slice(3)) < (task.acceptanceCriteria?.length ?? 0))) : [];

  const uploadedFiles = (req.files || []).map((f) => {
    // Cloudinary upload: f.path is the CDN URL
    // Disk fallback: f.path is an absolute filesystem path — convert to a relative API URL
    const isCloudinaryUrl = f.path && (f.path.startsWith("http://") || f.path.startsWith("https://"));
    const url = isCloudinaryUrl
      ? stripCloudinarySignature(f.path) // S-2 (D-164): the s--…-- signature never expires, so it is not stored
      : `/uploads/submissions/${f.filename}`;
    return {
      filename: f.originalname,
      url,
      publicId: f.filename ?? null,
      size:     f.size || 0,
    };
  });

  // D-057: lateness is fixed at the first submission; resubmissions keep it.
  const now            = new Date();
  const { firstSubmittedAt, isLate } = lateAtSubmission(task, now);

  // E-3: claim the task atomically, so a double click or a second tab cannot submit twice.
  const claimed = await Task.findOneAndUpdate({ _id: task._id, status: { $in: ["To-Do", "In-Progress"] } }, {
    status:          "In-Review",
    submittedAt:     now,
    firstSubmittedAt,
    submissionNote:  req.body.note || "",
    submissionFiles: uploadedFiles,
    submissionLinks: links,
    submissionContent:   content,
    submissionChecklist: checklist,
    submissionHandoff:   String(req.body.handoff ?? "").trim().slice(0, 1000), // E-3b (D-185): handed to the linked dev task on approval
    aiEval:          null,
    aiScore:         null,
    aiScores:        null,
    tlScore:         null,
    isLate,
    reviewStage:     "none",
    // E-4c (D-198): a resubmit uses no try; only a send-back does (revisionUpdate). attemptDelta("resubmit") is 0.
    ...(attemptDelta("resubmit") ? { $inc: { resubmissionCount: attemptDelta("resubmit") } } : {}),
  });
  // ponytail: the losing request's files stay in storage (no cleanup); the 5-file / 10 MB limit bounds it.
  if (!claimed) return res.status(409).json({ error: "This task was just submitted. Open it to see the submission." });
  Task.logActivity(task._id, userId, "submitted", { from: task.status, to: "In-Review", note: isLate ? "late" : "" });

  // D-182 → D-184 (E-3b): the task's own Team Leads (module, else project), else the project's Manager; plus a Senior of the
  // assignee's track who is on the same project (junior → senior review, S-1). Before: a same-department Senior, else the
  // organisation's first Team Lead, else its first Manager.
  const assignee   = await User.findById(task.assignee ?? userId).lean();
  const seniorRole = assignee ? JUNIOR_SENIOR[assignee.role] : null;
  const { leads, managerId, members } = await taskPeople(task);
  const seniors = seniorRole ? members.filter((m) => m.role === seniorRole && String(m._id) !== String(userId)).map((m) => String(m._id)) : [];
  for (const uid of reviewNoticeTargets({ leads, managerId, seniors })) {
    await Notification.create({
      userId:   uid,
      orgId:    task.orgId,
      type:     "review_requested",
      message:  `${assignee?.name ?? "Someone"} submitted "${task.title}" for review${isLate ? " (submitted late)" : ""}`,
      meta: { taskId: task._id, projectId: task.projectId },
    });
    if (io) io.to(`user:${uid}`).emit("notification:new", { type: "review_requested" });
  }

  notifyQaNeeded(task, orgId).catch((e) => console.error("[qa notify]", e.message)); // T-4 (D-137)

  // AI evaluation runs after the answer; it can fail or be off without blocking anything (spec §3).
  evaluateSubmission({ taskId: task._id, userId, role: req.user.role, orgId })
    .catch((e) => console.error("[aiEval]", e.message));

  return res.json({ message: "Task submitted for review", isLate });
}

// ── POST /api/tasks/:id/review ────────────────────────────────────────────────
export async function reviewTask(req, res) {
  const { action, qualityScore, note } = req.body;
  const { role, id: reviewerId, orgId } = req.user;
  const io = getIo();

  const task = await Task.findOne({ _id: req.params.id, orgId });
  if (!task || task.status !== "In-Review") {
    return res.status(400).json({ error: "Task is not awaiting review" });
  }

  const isSenior      = Boolean(SENIOR_JUNIOR[role]);
  const isManagerOrTL = ["Manager", "Team Lead"].includes(role);

  if (!isSenior && !isManagerOrTL) {
    return res.status(403).json({ error: "Insufficient permissions to review" });
  }
  // S-1 (D-159, FR03-09): a Senior reviews only on a project they are on.
  if (isSenior && !seniorMayReview(reviewerId, task.projectId ? await Project.findById(task.projectId, "members").lean() : null)) {
    return res.status(403).json({ error: "You can review only tasks on your own projects." });
  }

  // ── REJECT ────────────────────────────────────────────────────────────────
  if (action === "reject") {
    const newCount = task.resubmissionCount + 1;

    if (newCount >= task.maxResubmissions) {
      // Escalate to Manager
      await Task.findByIdAndUpdate(req.params.id, {
        $set: {
          reviewNote:        note,
          reviewedBy:        reviewerId,
          reviewedAt:        new Date(),
          reviewStage:       "manager_pending",
          resubmissionCount: newCount,
        },
      });
      Task.logActivity(task._id, reviewerId, "escalated", { note: "Max resubmissions — sent to Manager" });
      openLimitRequest(task, { id: reviewerId, name: req.user.name }, newCount).catch((e) => console.error("[limit request]", e.message)); // T-5 (D-142)
      reviewAudit(req, task, "task_review_revision", `"${task.title}" reached the resubmission limit and went to the Manager.`, { note: note ?? "" });

      const manager = await User.findOne({ orgId: task.orgId, role: "Manager", status: "active" }).lean();
      if (manager) {
        await Notification.create({
          userId:   manager._id,
          orgId:    task.orgId,
          type:     "manager_decision_required",
          message:  `"${task.title}" rejected ${task.maxResubmissions} times — your decision needed`,
          meta: { taskId: task._id },
        });
        if (io) io.to(`user:${manager._id}`).emit("notification:new", { type: "manager_decision_required" });
      }

      return res.json({ message: "Max submissions reached — escalated to Manager" });
    }

    // Normal rejection — return to assignee
    await Task.findByIdAndUpdate(req.params.id, {
      $set: {
        status:            "In-Progress", // D-059: reject always returns to In-Progress
        reviewNote:        note,
        reviewedBy:        reviewerId,
        reviewedAt:        new Date(),
        reviewStage:       "none",
        resubmissionCount: newCount,
      },
    });
    Task.logActivity(task._id, reviewerId, "status", { from: "In-Review", to: "In-Progress", note });
    reviewAudit(req, task, "task_review_revision", `Revision requested on "${task.title}".`, { note: note ?? "" });

    emitter.emit("task.rejected", {
      taskId:     task._id,
      reviewerId,
      reason:     note,
      orgId:      task.orgId,
    });

    // Notify assignees
    const assigneeIds = task.assignee
      ? [task.assignee]
      : task.assignees;
    await Promise.all(
      assigneeIds.map((uid) =>
        Notification.create({
          userId:   uid,
          orgId:    task.orgId,
          type:     "task_rejected",
          message:  note
            ? `Task rejected: ${note}`
            : `"${task.title}" was sent back for changes (attempt ${newCount}/${task.maxResubmissions})`,
          meta: { taskId: task._id },
        })
      )
    );

    return res.json({
      message: `Task rejected — returned to assignee (attempt ${newCount}/${task.maxResubmissions})`,
    });
  }

  // ── APPROVE ───────────────────────────────────────────────────────────────
  if (action === "approve") {
    // D-063/D-064: reviewers give a 0-100 score; stars = clamp(round(score/20),1,5). Old callers may still send 1-5 stars.
    const tlScore = parseTlScore(req.body.score);
    if (req.body.score !== undefined && tlScore === null) return res.status(400).json({ error: "Score must be a whole number from 0 to 100." });
    const qScore = tlScore !== null ? finalScore({ tlScore }).stars : Number(qualityScore);
    if (!qScore || qScore < 1 || qScore > 5) {
      return res.status(400).json({ error: "A score from 0 to 100 is required" });
    }

    if (isSelfReview(task, reviewerId)) return res.status(403).json({ error: "You worked on this task, so someone else must review it.", code: "self_review" });
    // Stage 1: Senior approves → route to Manager
    if (isSenior && task.reviewStage === "none") {
      await Task.findByIdAndUpdate(req.params.id, {
        $set: {
          reviewNote:   note,
          reviewedBy:   reviewerId,
          reviewedAt:   new Date(),
          qualityScore: qScore,
          reviewStage:  "senior_approved",
        },
      });
      Task.logActivity(task._id, reviewerId, "reviewed", { note: `Senior approved (${qScore}★)` });
      reviewAudit(req, task, "task_review_approved", `Senior reviewer approved "${task.title}" (${qScore}★), waiting for the final approval.`, { stars: qScore, stage: "senior" });

      await GamificationProfile.findOneAndUpdate(
        { userId: reviewerId },
        { $inc: { "stats.reviewsGiven": 1 } }
      );

      const manager = await User.findOne({ orgId: task.orgId, role: "Manager", status: "active" }).lean();
      if (manager) {
        await Notification.create({
          userId:   manager._id,
          orgId:    task.orgId,
          type:     "review_requested",
          message:  `${req.user.name} approved "${task.title}" — awaiting your final sign-off`,
          meta: { taskId: task._id },
        });
        if (io) io.to(`user:${manager._id}`).emit("notification:new", { type: "review_requested" });
      }

      return res.json({ message: "Senior review recorded — sent to Manager for final approval" });
    }

    // Final approval: Manager or TL
    if (isManagerOrTL) {
      const blockedFinal = approvalBlock({ task, reviewerId }); // T-4: same rule on every path to Done
      if (blockedFinal) return res.status(blockedFinal.status).json({ error: blockedFinal.error, code: blockedFinal.code });
      const finalQuality = qScore || task.qualityScore || 3;
      const ai = await Task.findById(task._id, "+aiScore").lean();
      const fs = tlScore !== null ? finalScore({ tlScore, aiScore: ai?.aiScore, by: reviewerId }) : { gap: null, flag: null };

      // Atomic: only one approval moves the task out of In-Review.
      const done = await Task.findOneAndUpdate({ _id: req.params.id, status: "In-Review" }, {
        $set: {
          status:       "Done",
          reviewNote:   note || task.reviewNote,
          reviewedBy:   reviewerId,
          reviewedAt:   new Date(),
          qualityScore: finalQuality,
          ...(tlScore !== null ? { tlScore } : {}),
          reviewStage:  "none",
          completedAt:  new Date(),
        },
        ...(fs.flag ? { $push: { reviewFlags: fs.flag } } : {}),
      });
      if (!done) return res.status(409).json({ error: "Task is not awaiting review" });
      Task.logActivity(task._id, reviewerId, "status", { from: "In-Review", to: "Done", note: `${finalQuality}★` });
      reviewAudit(req, task, "task_review_approved", `"${task.title}" approved (${finalQuality}★).`, { stars: finalQuality, score: tlScore, flagged: Boolean(fs.flag) });
      if (role === "Team Lead") awardTLReviewXp({ tlId: reviewerId, orgId, taskId: task._id, stars: finalQuality, submittedAt: task.submittedAt, approvedAt: new Date() }).catch((e) => console.error("[tl xp]", e.message)); // T-6 (D-148)

      await GamificationProfile.findOneAndUpdate(
        { userId: reviewerId },
        { $inc: { "stats.reviewsGiven": 1 } }
      );

      // Fire gamification event for all assignees
      const assigneeIds = task.assignee
        ? [task.assignee, ...task.assignees].filter(Boolean)
        : task.assignees;
      const uniqueAssigneeIds = [...new Set(assigneeIds.map(String))].map(
        (id) => new mongoose.Types.ObjectId(id)
      );

      emitter.emit("task.approved", {
        taskId:       task._id,
        assignees:    uniqueAssigneeIds,
        qualityScore: finalQuality,
        approverId:   reviewerId,
        orgId:        task.orgId,
        taskTitle:    task.title,
      });

      return res.json({
        message: "Task approved — XP awarded", stars: finalQuality, tlScore,
        aiScore: ai?.aiScore ?? null, gap: fs.gap, flagged: Boolean(fs.flag),
      });
    }

    return res.status(400).json({ error: "Review stage conflict — cannot approve at this stage" });
  }

  return res.status(400).json({ error: 'action must be "approve" or "reject"' });
}

// ── POST /api/tasks/:id/extension-respond ─────────────────────────────────────
export async function respondExtension(req, res) {
  const { extensionIndex, approved, note } = req.body;
  const io = getIo();

  if (!["Team Lead", "Manager"].includes(req.user.role)) {
    return res.status(403).json({ error: "Only Team Lead or Manager can approve extensions" });
  }

  const task = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId });
  const ext  = task?.extensionRequests?.[extensionIndex];
  if (!ext || ext.status !== "PENDING") {
    return res.status(400).json({ error: "Extension request not found or already resolved" });
  }

  const base   = `extensionRequests.${extensionIndex}`;
  const update = {
    [`${base}.status`]:      approved ? "APPROVED" : "REJECTED",
    [`${base}.approvedBy`]:  req.user.id,
    [`${base}.approvalNote`]: note || "",
  };
  if (approved) { update.deadline = ext.requestedDeadline; update.deadlineAlertSentAt = null; } // D-057 / 1.11d; 1.5 re-alert

  await Task.findByIdAndUpdate(req.params.id, { $set: update });
  Task.logActivity(task._id, req.user.id, "extension", { note: approved ? "Extension approved" : "Extension rejected" });

  await Notification.create({
    userId:   ext.requestedBy,
    orgId:    task.orgId,
    type:     approved ? "extension_approved" : "extension_rejected",
    message:  approved
      ? `Extension approved for "${task.title}". New deadline: ${ext.requestedDeadline.toLocaleDateString()}`
      : `Extension rejected for "${task.title}". ${note || ""}`,
    meta: { taskId: task._id },
  });
  if (io) {
    io.to(`user:${ext.requestedBy}`).emit("notification:new", {
      type: approved ? "extension_approved" : "extension_rejected",
    });
  }

  return res.json({ message: approved ? "Extension approved" : "Extension rejected" });
}

// ── POST /api/tasks/:id/approve (legacy) ──────────────────────────────────────
export async function approveTask(req, res) {
  const { orgId } = req.user;

  const task = await Task.findOne({ _id: req.params.id, orgId });
  if (!task) return res.status(404).json({ error: "Task not found." });
  if (task.status !== "In-Review") {
    return res.status(400).json({ error: "Task is not In-Review." });
  }
  const blockedLegacy = approvalBlock({ task, reviewerId: req.user.id }); // T-4
  if (blockedLegacy) return res.status(blockedLegacy.status).json({ error: blockedLegacy.error, code: blockedLegacy.code });

  task.status      = "Done";
  task.completedAt = new Date();
  task.updatedAt   = new Date();
  await task.save();
  Task.logActivity(task._id, req.user.id, "status", { from: "In-Review", to: "Done" });
  reviewAudit(req, task, "task_review_approved", `"${task.title}" approved.`);
  emitTaskChanged(orgId, task, "Done");

  const { qualityScore = 3 } = req.body ?? {};

  emitter.emit("task.approved", {
    taskId:       task._id,
    assignees:    task.assignees,
    qualityScore: Math.max(1, Math.min(5, Number(qualityScore) || 3)),
    approverId:   req.user.id,
    orgId,
    taskTitle:    task.title,
  });

  res.json({ success: true, task });
}

// ── POST /api/tasks/:id/reject (legacy) ───────────────────────────────────────
export async function rejectTask(req, res) {
  const { feedback = "" } = req.body;
  const { id: managerId, orgId } = req.user;

  const task = await Task.findOne({ _id: req.params.id, orgId });
  if (!task) return res.status(404).json({ error: "Task not found." });

  task.status            = "In-Progress";
  task.rejectionFeedback = feedback || null;
  task.updatedAt         = new Date();

  if (feedback?.trim()) {
    task.comments.push({
      author:    managerId,
      text:      `Rejected: ${feedback.trim()}`,
      createdAt: new Date(),
    });
  }
  await task.save();
  Task.logActivity(task._id, req.user.id, "status", { from: "In-Review", to: "In-Progress", note: task.rejectionFeedback ?? "" });
  reviewAudit(req, task, "task_review_revision", `Revision requested on "${task.title}".`, { note: task.rejectionFeedback ?? "" });
  emitTaskChanged(orgId, task, "In-Progress");

  await Promise.all(
    task.assignees.map((uid) =>
      Notification.create({
        userId:  uid,
        orgId,
        type:    "task_rejected",
        title:   "Task Rejected",
        message: feedback?.trim()
          ? `Task rejected: ${feedback.trim()}`
          : `"${task.title}" was sent back for changes.`,
      })
    )
  );

  emitter.emit("task.rejected", {
    taskId:     task._id,
    reason:     feedback || null,
    reviewerId: managerId,
    orgId,
  });

  res.json({ success: true, task });
}

// ── POST /api/tasks/:id/comment ───────────────────────────────────────────────
export async function addComment(req, res) {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "Comment text is required." });
  const tooLong = firstLengthError([["Comment", text, "comment"]]);
  if (tooLong) return res.status(400).json({ error: tooLong });

  const task = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId });
  if (!task) return res.status(404).json({ error: "Task not found." });

  const members = await commentMembers(task);
  const mentions = mentionedIds(text, members, req.user.id);
  task.comments.push({ author: req.user.id, text: text.trim(), createdAt: new Date(), mentions });
  task.updatedAt = new Date();
  await task.save();
  Task.logActivity(task._id, req.user.id, "comment", { note: text.trim() });
  notifyMentions(task, mentions, req.user, text);

  const updated = await Task.findById(task._id)
    .populate("comments.author", "name role")
    .select("comments")
    .lean();

  res.json({ success: true, comments: updated.comments });
}

// T-4 (D-139): people who can be mentioned on this task = its project's members + Manager.
export async function commentMembers(task) {
  if (!task.projectId) return [];
  const p = await Project.findById(task.projectId, "members managerId").lean();
  const users = await User.find({ _id: { $in: [...(p?.members ?? []), ...(p?.managerId ? [p.managerId] : [])] }, status: { $ne: "deleted" } }, "name role").lean();
  return users.map((u) => ({ id: String(u._id), name: u.name, role: u.role }));
}
function notifyMentions(task, ids, author, text) {
  for (const uid of ids) createNotification({ userId: uid, orgId: author.orgId, type: "mention", title: "You were mentioned", message: `${author.name ?? "Someone"} mentioned you on "${task.title}": ${String(text).trim().slice(0, 160)}`, meta: { taskId: task._id, projectId: task.projectId } }).catch(() => {});
}
const commentOf = (task, id) => (mongoose.isValidObjectId(id) ? task.comments.id(id) : null);
// PATCH /api/tasks/:id/comments/:commentId { text } (own comment; only newly named people are notified)
export async function editComment(req, res) {
  const task = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId });
  const c = task && commentOf(task, req.params.commentId);
  if (!c) return res.status(404).json({ error: "Comment not found." });
  if (!canChangeComment(c, req.user.id)) return res.status(403).json({ error: "You can only edit your own comment." });
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "Comment text is required." });
  const tooLong = firstLengthError([["Comment", text, "comment"]]);
  if (tooLong) return res.status(400).json({ error: tooLong });
  const mentions = mentionedIds(text, await commentMembers(task), req.user.id);
  const before = (c.mentions ?? []).map(String);
  c.text = text; c.mentions = mentions; c.editedAt = new Date();
  await task.save();
  notifyMentions(task, mentions.filter((m) => !before.includes(m)), req.user, text);
  res.json({ ok: true });
}
// DELETE /api/tasks/:id/comments/:commentId (own comment)
export async function deleteComment(req, res) {
  const task = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId });
  const c = task && commentOf(task, req.params.commentId);
  if (!c) return res.status(404).json({ error: "Comment not found." });
  if (!canChangeComment(c, req.user.id)) return res.status(403).json({ error: "You can only delete your own comment." });
  c.deleteOne();
  await task.save();
  Task.logActivity(task._id, req.user.id, "comment", { note: "Deleted a comment" });
  res.json({ ok: true });
}
// POST /api/tasks/:id/comments/:commentId/reactions { emoji } → toggles this person's reaction
export async function reactComment(req, res) {
  const task = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId });
  const c = task && commentOf(task, req.params.commentId);
  if (!c) return res.status(404).json({ error: "Comment not found." });
  const next = toggleReaction((c.reactions ?? []).map((r) => ({ emoji: r.emoji, user: String(r.user) })), req.body?.emoji, req.user.id);
  if (!next) return res.status(400).json({ error: "Pick one of the available reactions." });
  c.reactions = next;
  await task.save();
  res.json({ ok: true, reactions: next.filter((r) => r.emoji === req.body.emoji).length });
}

// T-4 (D-136): every review write is in the audit log, on the older paths too.
export function reviewAudit(req, task, action, detail, after = {}) {
  AuditLog.create({ action, orgId: mongoose.isValidObjectId(task.orgId) ? task.orgId : null, performedBy: req.user.id, targetProjectId: task.projectId, detail, after: { taskId: String(task._id), ...after } }).catch((e) => console.error("[review audit]", e.message));
}

// ── POST /api/tasks/:id/time-log ──────────────────────────────────────────────
export async function logTime(req, res) {
  const minutes = Number(req.body?.minutes);
  const note    = String(req.body?.note ?? "").trim();
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    return res.status(400).json({ error: "Minutes must be a whole number from 1 to 1440 (24 h)." });
  }
  if (note.length > 300) return res.status(400).json({ error: "Note is too long (max 300 characters)." });

  const task = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId });
  if (!task) return res.status(404).json({ error: "Task not found." });

  // Only people working on the task log time on it.
  const uid = String(req.user.id);
  const isAssignee = task.assignees.some((a) => String(a) === uid) || String(task.assignee ?? "") === uid;
  if (!isAssignee) return res.status(403).json({ error: "Only an assignee can log time on this task." });

  task.timeLogs.push({ user: req.user.id, minutes, note, loggedAt: new Date() });
  task.actualHours = Math.round((task.timeLogs.reduce((m, l) => m + (l.minutes ?? 0), 0) / 60) * 100) / 100;
  task.updatedAt = new Date();
  await task.save();
  Task.logActivity(task._id, req.user.id, "time", { note: `${minutes} min${note ? ` — ${note}` : ""}` });

  const updated = await Task.findById(task._id, "timeLogs actualHours").populate("timeLogs.user", "name").lean();
  res.json({ success: true, timeLogs: updated.timeLogs, actualHours: updated.actualHours });
}

// ── DELETE /api/tasks/:id ─────────────────────────────────────────────────────
export async function deleteTask(req, res) {
  const task = await Task.findOneAndDelete({ _id: req.params.id, orgId: req.user.orgId });
  if (!task) return res.status(404).json({ error: "Task not found." });
  res.json({ success: true });
}

// ── GET /api/tasks/review-queue ───────────────────────────────────────────────
export async function getReviewQueue(req, res) {
  const { orgId } = req.user;
  const page     = Math.max(1, parseInt(req.query.page)  || 1);
  const limit    = Math.min(50, parseInt(req.query.limit) || 20);
  const type     = req.query.type     || null;
  const priority = req.query.priority || null;

  const scoped = await reviewListFilter(req, res); if (!scoped) return;
  const query = { orgId, status: "In-Review", ...scoped };
  if (type)     query.type     = type;
  if (priority) query.priority = priority;

  const [tasks, total] = await Promise.all([
    Task.find(query)
      .sort({ submittedAt: -1, updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("assignees", "name role avatarSeed")
      .populate("assignee",  "name role avatarSeed")
      .populate("createdBy", "name role")
      .lean(),
    Task.countDocuments(query),
  ]);

  res.json({
    success: true,
    tasks: tasks.map((t) => ({
      id:           t._id,
      title:        t.title,
      description:  t.description,
      type:         t.type,
      priority:     t.priority,
      xpValue:      t.xpValue,
      goldValue:    t.goldValue,
      deadline:     t.deadline,
      submittedAt:  t.submittedAt ?? t.updatedAt,
      reviewStage:  t.reviewStage,
      isLate:       t.isLate,
      qualityScore: t.qualityScore,
      assignees:    (t.assignees ?? []).map((a) => ({
        id:         a._id,
        name:       a.name,
        role:       a.role,
        avatarSeed: a.avatarSeed ?? a.name,
      })),
      assignee: t.assignee
        ? { id: t.assignee._id, name: t.assignee.name, role: t.assignee.role }
        : null,
      createdBy:  t.createdBy ? { name: t.createdBy.name, role: t.createdBy.role } : null,
      projectId:  t.projectId ?? null,
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
}

// ── GET /api/tasks/mentoring-stats ────────────────────────────────────────────
export async function getMentoringStats(req, res) {
  const { id: userId, orgId } = req.user;
  const now      = new Date();
  const weekAgo  = new Date(now - 7  * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const tasksWithComments = await Task.find(
    { orgId, "comments.author": userId },
    "title type priority status xpValue comments assignees assignee"
  )
    .populate("assignees", "name role avatarSeed")
    .lean();

  const allComments = tasksWithComments.flatMap((t) =>
    t.comments
      .filter((c) => c.author?.toString() === userId.toString())
      .map((c) => ({
        commentId:   c._id,
        text:        c.text,
        createdAt:   c.createdAt,
        isRejection: c.text?.startsWith("Rejected:"),
        task: {
          id:        t._id,
          title:     t.title,
          type:      t.type,
          priority:  t.priority,
          status:    t.status,
          xpValue:   t.xpValue,
          assignees: (t.assignees ?? []).map((a) => ({
            name:       a.name,
            role:       a.role,
            avatarSeed: a.avatarSeed ?? a.name,
          })),
        },
      }))
  );

  allComments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const weekComments  = allComments.filter((c) => new Date(c.createdAt) >= weekAgo);
  const monthComments = allComments.filter((c) => new Date(c.createdAt) >= monthAgo);
  const rejections    = allComments.filter((c) => c.isRejection);

  const byType = {};
  for (const c of allComments) {
    const t = c.task.type ?? "Other";
    byType[t] = (byType[t] ?? 0) + 1;
  }

  const dailyMap = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dailyMap[d.toISOString().slice(0, 10)] = 0;
  }
  for (const c of allComments) {
    const key = new Date(c.createdAt).toISOString().slice(0, 10);
    if (key in dailyMap) dailyMap[key]++;
  }
  const dailyActivity = Object.entries(dailyMap).map(([date, count]) => ({ date, count }));

  const juniorRoles  = new Set(["Junior Developer", "Junior Designer", "Junior Tester"]);
  const mentoredSet  = new Set();
  for (const t of tasksWithComments) {
    for (const a of (t.assignees ?? [])) {
      if (juniorRoles.has(a.role)) mentoredSet.add(String(a._id));
    }
  }

  res.json({
    success: true,
    stats: {
      totalFeedback:     allComments.length,
      feedbackThisWeek:  weekComments.length,
      feedbackThisMonth: monthComments.length,
      tasksReviewed:     tasksWithComments.length,
      rejectionsGiven:   rejections.length,
      juniorsHelped:     mentoredSet.size,
    },
    byType,
    dailyActivity,
    recentFeedback: allComments.slice(0, 15),
  });
}

// ── GET /api/tasks/current-sprint ─────────────────────────────────────────────
export async function getCurrentSprint(req, res) {
  const { id: userId, orgId } = req.user;

  // S-1 (D-161): an employee sees sprints of their own projects only.
  const mine = isEmployee(req.user) ? { projectId: { $in: (await Project.find({ members: userId }, "_id").lean()).map((p) => p._id) } } : {};
  let sprint = await Sprint.findOne({ orgId, status: "Active", ...mine })
    .populate({
      path:     "tasks",
      populate: { path: "assignees", select: "name role avatarSeed" },
    })
    .lean();

  if (!sprint) {
    sprint = await Sprint.findOne({ orgId, ...mine })
      .sort({ createdAt: -1 })
      .populate({
        path:     "tasks",
        populate: { path: "assignees", select: "name role avatarSeed" },
      })
      .lean();
  }

  if (!sprint) {
    return res.json({ sprint: null, myTasks: [], stats: null });
  }

  const allTasks = (sprint.tasks ?? []).map((t) => ({
    id:          t._id,
    title:       t.title,
    description: t.description ?? "",
    type:        t.type,
    priority:    t.priority,
    status:      t.status,
    xpValue:     t.xpValue,
    goldValue:   t.goldValue,
    deadline:    t.deadline,
    labels:      t.labels ?? [],
    assignees:   (t.assignees ?? []).map((a) => ({
      id:         a._id,
      name:       a.name,
      role:       a.role,
      avatarSeed: a.avatarSeed ?? a.name,
    })),
  }));

  const myTasks    = allTasks.filter((t) => t.assignees.some((a) => String(a.id) === String(userId)));
  const total      = allTasks.length;
  const done       = allTasks.filter((t) => t.status === "Done").length;
  const inProgress = allTasks.filter((t) => t.status === "In-Progress").length;
  const totalXp    = allTasks.reduce((s, t) => s + (t.xpValue ?? 0), 0);
  const earnedXp   = allTasks.filter((t) => t.status === "Done").reduce((s, t) => s + (t.xpValue ?? 0), 0);
  const myDone       = myTasks.filter((t) => t.status === "Done").length;
  const myInProgress = myTasks.filter((t) => t.status === "In-Progress").length;
  const myXp         = myTasks.filter((t) => t.status === "Done").reduce((s, t) => s + (t.xpValue ?? 0), 0);

  res.json({
    sprint: {
      id:        sprint._id,
      name:      sprint.name,
      goal:      sprint.goal,
      status:    sprint.status,
      startDate: sprint.startDate,
      endDate:   sprint.endDate,
    },
    myTasks,
    stats: { total, done, inProgress, totalXp, earnedXp, myDone, myInProgress, myXp, myTotal: myTasks.length },
  });
}
