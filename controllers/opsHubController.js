import { LIMIT_TYPE, limitDecision } from "../services/reviewRules.js";
import { ATTENTION_FROM } from "../services/healthScale.js"; // QA4 D-QA4-11
import { createNotification } from "./notificationController.js";
import mongoose from "mongoose";
import User                from "../models/User.js";
import ExtensionRequest from "../models/ExtensionRequest.js";
import Task                from "../models/Task.js";
import Project             from "../models/Project.js";
import Milestone           from "../models/Milestone.js";
import Organization        from "../models/Organization.js";
import AuditLog            from "../models/AuditLog.js";
import GamificationProfile from "../models/GamificationProfile.js";
import OperationalRequest  from "../models/OperationalRequest.js";
import { healthForProjects } from "../services/projectHealthService.js";
import { calendarDaysOver, alertableModule, severityForDays, SEVERITY_RULE, REVIEW_QUEUE_MIN, REVIEW_QUEUE_DAYS, overloadedList } from "../services/managerAlerts.js";
import { activityQuery } from "../services/auditText.js";
import { getBulkWorkloadSnapshots } from "../services/workloadService.js";
import { orgWorkTime } from "../services/workloadRules.js";
import { effectiveThreshold, loadLabel } from "../services/resourceRules.js";
import { getAlertSettings } from "../services/alertRules.js";

const IS_OID = /^[0-9a-f]{24}$/i;
function orgFilterMgr(orgId) {
  return IS_OID.test(orgId ?? "") ? { _id: orgId } : { orgId };
}

// ── Resolve org IDs ─────────────────────────────────────────────────────────────
async function resolveOrg(orgId) {
  const org = await Organization.findOne(orgFilterMgr(orgId), "_id orgId workingTime alertSettings workloadThresholdPct").lean();
  if (!org) return null;
  const ids = [org._id.toString(), ...(org.orgId ? [org.orgId] : [])];
  const filter = ids.length === 1
    ? { orgId: ids[0] }
    : { $or: ids.map((id) => ({ orgId: id })) };
  return { org, ids, filter };
}

// ── Severity ordering ────────────────────────────────────────────────────────────
const SEV_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

// ── GET /api/manager/ops-hub ─────────────────────────────────────────────────────
export async function getOpsHub(req, res) {
  const { orgId } = req.user;
  const now         = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 86_400_000);
  const todayEnd    = new Date(now); todayEnd.setHours(23, 59, 59, 999);

  const resolved = await resolveOrg(orgId);
  if (!resolved) return res.json(emptyHub());

  const { org, ids, filter: projectOrgFilter } = resolved;

  // ── Parallel base queries ─────────────────────────────────────────────────────
  // QA4 D-QA4-8: a Manager's Inbox is built from the projects they manage only.
  const mine = req.user.role === "Manager";
  const [projects, pendingRequests, recentActivityAll, workforceAll] = await Promise.all([
    Project.find({ ...projectOrgFilter, isDeleted: { $ne: true }, ...(mine ? { managerId: req.user.id } : {}) },
      "_id title status riskLevel deadline members startDate createdAt priority"
    ).lean(),

    OperationalRequest.find({ orgId, status: { $in: ["Pending", "In Progress"] } })
      .populate("requesterId", "name role avatarSeed")
      .populate({ path: "taskId", select: "title assignee", populate: { path: "assignee", select: "name" } })
      .populate("projectId",   "title status")
      .populate("milestoneId", "title")
      .sort({ priority: -1, createdAt: -1 })
      .limit(20)
      .lean(),

    AuditLog.find({ orgId: org._id })
      .sort({ createdAt: -1 })
      .limit(25)
      .lean(),

    User.find({ orgId, status: { $ne: "deleted" } },
      "name role department avatarSeed"
    ).lean(),
  ]);

  const ownPeople = new Set(projects.flatMap((p) => (p.members ?? []).map(String)));
  const workforceMembers = mine ? workforceAll.filter((m) => ownPeople.has(String(m._id))) : workforceAll;
  const projectIds = projects.map((p) => p._id);
  const recentActivity = mine ? await AuditLog.find(activityQuery({ role: "Manager", userId: [String(req.user.id), new mongoose.Types.ObjectId(req.user.id)], orgOid: org._id, projectIds })).sort({ createdAt: -1 }).limit(25).lean() : recentActivityAll;
  const projectMap = Object.fromEntries(projects.map((p) => [String(p._id), p]));
  const memberIds  = workforceMembers.map((m) => m._id);

  // ── Milestone + task queries (depend on projectIds / memberIds) ───────────────
  // Activity actors only depend on round 1, so they load in this round too (D-078).
  const performedByIds = recentActivity
    .map((a) => a.performedBy)
    .filter((id) => IS_OID.test(String(id ?? "")));
  const [upcomingMs, overdueMs, tasksInReview, openTaskAgg, gpList, actorUsers, healthMap] = await Promise.all([
    Milestone.find({
      projectId: { $in: projectIds },
      $or: [{ endDate: { $gte: now, $lte: weekFromNow } }, { dueDate: { $gte: now, $lte: weekFromNow } }],
      status: { $nin: ["Completed"] },
    })
      .sort({ endDate: 1, dueDate: 1 })
      .limit(12)
      .lean(),

    Milestone.find({
      projectId: { $in: projectIds },
      $or: [
        { endDate: { $lt: now }, status: { $nin: ["Completed"] } },
        { dueDate: { $lt: now }, status: { $nin: ["Completed"] } },
        { status: "Delayed" },
      ],
    })
      .sort({ endDate: 1 })
      .limit(10)
      .lean(),

    Task.find({ orgId, status: "In-Review", ...(mine ? { projectId: { $in: projectIds } } : {}) })
      .populate("assignees", "name role avatarSeed")
      .populate("projectId", "title")
      .sort({ updatedAt: -1 })
      .limit(15)
      .lean(),

    Task.aggregate([
      { $match: { orgId, assignees: { $in: memberIds }, status: { $nin: ["Done"] } } },
      { $unwind: "$assignees" },
      {
        $group: {
          _id:        "$assignees",
          inProgress: { $sum: { $cond: [{ $eq: ["$status", "In-Progress"] }, 1, 0] } },
          overdue:    {
            $sum: {
              $cond: [
                { $and: [{ $ne: ["$deadline", null] }, { $lt: ["$deadline", now] }] },
                1, 0,
              ],
            },
          },
          total: { $sum: 1 },
        },
      },
    ]),

    GamificationProfile.find({ userId: { $in: memberIds } }, "userId hp level currentStreak").lean(),

    User.find({ _id: { $in: performedByIds } }, "name role avatarSeed").lean(),

    healthForProjects(projects, now), // computed health (D-077), not the stored default
  ]);

  // ── Build workforce warning map ─────────────────────────────────────────────
  const taskMap = Object.fromEntries(openTaskAgg.map((r) => [String(r._id), r]));
  const gpMap   = Object.fromEntries(gpList.map((g) => [String(g.userId), g]));

  const workforceWarnings = workforceMembers
    .map((m) => {
      const uid    = String(m._id);
      const bucket = taskMap[uid] ?? { inProgress: 0, overdue: 0, total: 0 };
      const hp     = gpMap[uid]?.hp ?? 100;
      const utilization = Math.min(100, Math.round((bucket.inProgress / 5) * 100));
      const burnoutRisk = Math.min(100, Math.round(
        (bucket.overdue / 3) * 50 + ((100 - hp) / 100) * 30 + (bucket.inProgress / 5) * 20
      ));
      let availability;
      if (bucket.inProgress >= 4 || hp < 30 || bucket.overdue >= 3) availability = "Overloaded";
      else if (bucket.inProgress >= 2 || hp < 60 || bucket.overdue >= 1) availability = "Busy";
      else availability = "Available";

      return {
        id: uid,
        name:         m.name,
        role:         m.role,
        department:   m.department ?? null,
        avatarSeed:   m.avatarSeed ?? m.name,
        hp,
        utilization,
        burnoutRisk,
        availability,
        inProgress:   bucket.inProgress,
        overdue:      bucket.overdue,
        total:        bucket.total,
      };
    })
    .filter((m) => m.availability === "Overloaded" || m.burnoutRisk >= 50)
    .sort((a, b) => b.burnoutRisk - a.burnoutRisk)
    .slice(0, 10);

  // ── Auto-generate operational alerts ──────────────────────────────────────────
  const alerts = [];
  const alertId = (() => { let n = 0; return () => `alert_${n++}`; })();

  // Delayed/at-risk projects
  for (const p of projects) {
    if (p.status === "Delayed") {
      const dDiff = p.deadline ? Math.ceil((new Date(p.deadline) - now) / 86_400_000) : null;
      alerts.push({
        id:       alertId(),
        type:     "project_delayed",
        severity: dDiff !== null && dDiff < 0 ? "Critical" : "High",
        title:    `Project delayed`,
        message:  `"${p.title}" is currently delayed${dDiff !== null ? ` — deadline ${dDiff < 0 ? `${Math.abs(dDiff)}d overdue` : `in ${dDiff}d`}` : ""}`,
        subject:  { type: "project", id: p._id, title: p.title },
      });
    }
    // QA4 M-31 (QA3 C-3): a project past its deadline day that is not finished is overdue, with calendar days in the org time zone.
    const overdueDays = ["Active", "In Review", "On Hold", "Delayed"].includes(p.status) ? calendarDaysOver(p.deadline, now, org.workingTime?.timezone ?? "Asia/Karachi") : 0;
    if (overdueDays > 0 && p.status !== "Delayed") {
      alerts.push({ id: alertId(), type: "project_overdue", rule: SEVERITY_RULE, severity: severityForDays(overdueDays), title: "Project overdue",
        message: `"${p.title}" passed its deadline ${overdueDays} day${overdueDays === 1 ? "" : "s"} ago and is not finished.`, actions: ["open", "request_extension"], subject: { type: "project", id: p._id, title: p.title } });
    }
    const hs = healthMap.get(String(p._id))?.score ?? 100;
    if (hs < ATTENTION_FROM && p.status !== "Completed" && p.status !== "Archived") {
      alerts.push({
        id:       alertId(),
        type:     "health_critical",
        severity: hs < 25 ? "Critical" : "High",
        title:    `Critical project health`,
        message:  `"${p.title}" health at ${hs}/100 — requires attention`,
        subject:  { type: "project", id: p._id, title: p.title },
      });
    }
  }

  // Overdue milestones (QA4 M-31): a finished module or a closed project is never overdue; days are calendar days in the org time zone.
  const tz = org.workingTime?.timezone ?? "Asia/Karachi";
  const msCounts = Object.fromEntries((await Task.aggregate([{ $match: { milestoneId: { $in: overdueMs.map((m) => m._id) } } }, { $group: { _id: "$milestoneId", total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ["$status", "Done"] }, 1, 0] } } } }])).map((r) => [String(r._id), r]));
  const lateMs = overdueMs.filter((ms) => alertableModule({ ...(msCounts[String(ms._id)] ?? { total: 0, done: 0 }), status: ms.status }, projectMap[String(ms.projectId)]?.status));
  for (const ms of lateMs) {
    const proj = projectMap[String(ms.projectId)];
    const dDate = ms.endDate ?? ms.dueDate;
    const daysLate = dDate ? calendarDaysOver(dDate, now, tz) : null;
    if (daysLate === 0) continue;
    alerts.push({
      id:       alertId(),
      type:     "milestone_overdue",
      rule:     SEVERITY_RULE,
      severity: daysLate !== null ? severityForDays(daysLate) : "High",
      title:    `Milestone overdue`,
      message:  `"${ms.title}"${proj ? ` in "${proj.title}"` : ""} is overdue${daysLate !== null ? ` by ${daysLate}d` : ""}`,
      subject:  { type: "milestone", id: ms._id, title: ms.title, projectId: ms.projectId, projectTitle: proj?.title },
    });
  }

  // Workforce overload (QA4 M-4 / M-31): the SAME capacity numbers as Resources, the AI and the Director; only ABOVE the limit counts.
  const snaps = await getBulkWorkloadSnapshots(workforceMembers.map((m) => m._id), { workTime: orgWorkTime(org) });
  const limit = effectiveThreshold(getAlertSettings(org).overloadLimitPct, (await User.findById(req.user.id, "workloadThresholdPct").lean())?.workloadThresholdPct);
  const over = overloadedList(snaps.map((x) => ({ id: String(x.userId), utilisation: x.utilisation, snap: x })), limit);
  const memberById = Object.fromEntries(workforceMembers.map((m) => [String(m._id), m]));
  for (const o of over) {
    const m = memberById[o.id]; if (!m) continue;
    alerts.push({
      id:       alertId(),
      type:     "member_overloaded",
      rule:     `Over their limit of ${limit}% of daily capacity.`,
      severity: o.utilisation >= 150 ? "Critical" : "High",
      title:    `${m.name} is over capacity`,
      message:  `${m.name} is at ${o.utilisation}% of daily capacity (limit ${limit}%).`,
      actions:  ["open", "nudge_team_lead", "request_reallocation"],
      subject:  { type: "member", id: m._id, name: m.name, role: m.role, avatarSeed: m.avatarSeed ?? m.name },
    });
  }
  for (const m of workforceMembers) {
    const uid    = String(m._id);
    const bucket = taskMap[uid] ?? { inProgress: 0, overdue: 0 };
    if (bucket.overdue >= 2) {
      alerts.push({
        id:       alertId(),
        type:     "member_overdue",
        severity: "Medium",
        title:    `Overdue tasks detected`,
        message:  `${m.name} has ${bucket.overdue} overdue tasks — review workload`,
        subject:  { type: "member", id: m._id, name: m.name, role: m.role, avatarSeed: m.avatarSeed ?? m.name },
      });
    }
  }

  // Tasks awaiting review > threshold
  const oldestReviewDays = tasksInReview.reduce((m, t) => Math.max(m, Math.floor((+now - +new Date(t.updatedAt)) / 86_400_000)), 0);
  if (tasksInReview.length >= REVIEW_QUEUE_MIN || oldestReviewDays >= REVIEW_QUEUE_DAYS) {
    alerts.push({
      id:       alertId(),
      type:     "review_queue_high",
      severity: "Medium",
      title:    `Review queue backed up`,
      rule:     `Shown when ${REVIEW_QUEUE_MIN} or more tasks wait, or any task has waited ${REVIEW_QUEUE_DAYS} days or more.`,
      message:  `${tasksInReview.length} tasks are waiting for review${oldestReviewDays ? `, the oldest for ${oldestReviewDays} day${oldestReviewDays === 1 ? "" : "s"}` : ""}.`,
      actions:  ["open", "nudge_team_lead"],
      subject:  { type: "system", title: "Review Queue" },
    });
  }

  alerts.sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));

  // ── Enrich upcoming milestones with project title ─────────────────────────────
  const enrichedUpcoming = upcomingMs.map((ms) => ({
    ...ms,
    projectTitle: projectMap[String(ms.projectId)]?.title ?? "Unknown",
    projectStatus: projectMap[String(ms.projectId)]?.status ?? "Unknown",
  }));

  const enrichedOverdue = lateMs.map((ms) => ({
    ...ms,
    projectTitle:  projectMap[String(ms.projectId)]?.title ?? "Unknown",
    projectStatus: projectMap[String(ms.projectId)]?.status ?? "Unknown",
  }));

  // ── Enriched activity with performedBy user info ───────────────────────────────
  const actorMap = Object.fromEntries(actorUsers.map((u) => [String(u._id), u]));

  const enrichedActivity = recentActivity.map((a) => ({
    id:           String(a._id),
    action:       a.action,
    detail:       a.detail,
    projectTitle: a.projectTitle ?? null,
    actor:        actorMap[String(a.performedBy)] ?? null,
    createdAt:    a.createdAt,
  }));

  // ── Stats ─────────────────────────────────────────────────────────────────────
  const wfCounts = workforceMembers.reduce((acc, m) => {
    const uid = String(m._id);
    const bucket = taskMap[uid] ?? { inProgress: 0, overdue: 0 };
    const hp = gpMap[uid]?.hp ?? 100;
    let av;
    if (bucket.inProgress >= 4 || hp < 30 || bucket.overdue >= 3) av = "Overloaded";
    else if (bucket.inProgress >= 2 || hp < 60 || bucket.overdue >= 1) av = "Busy";
    else av = "Available";
    acc[av] = (acc[av] ?? 0) + 1;
    return acc;
  }, {});

  // M-2: project deadline extensions this Manager sent to the Director (last 30 days), shown read-only in Requests.
  const myExtensions = await ExtensionRequest.find({ requestedBy: req.user.id, createdAt: { $gte: new Date(now - 90 * 86_400_000) } }, // QA4 M-38: ALL requests this Manager sent (task and project), not only project ones
    "projectId taskId requestedDays counterDays reason status directorNote originalDeadline decidedAt createdAt").populate("projectId", "title").populate("taskId", "title").sort({ createdAt: -1 }).limit(50).lean();

  res.json({
    myExtensions: myExtensions.map((e) => ({ id: e._id, projectId: e.projectId?._id ?? null, projectTitle: e.projectId?.title ?? "Project", kind: e.taskId ? "task" : "project", taskTitle: e.taskId?.title ?? null, originalDeadline: e.originalDeadline ?? null, newDeadline: e.originalDeadline ? new Date(+new Date(e.originalDeadline) + e.requestedDays * 86_400_000) : null, decidedAt: e.decidedAt ?? null, counterDays: e.counterDays ?? null, days: e.requestedDays, reason: e.reason, status: e.status, note: e.directorNote ?? null, at: e.createdAt })),
    requests:          pendingRequests,
    alerts:            alerts.slice(0, 20),
    activity:          enrichedActivity,
    upcomingDeadlines: enrichedUpcoming,
    overdueItems:      enrichedOverdue,
    tasksInReview,
    workforceWarnings,
    stats: {
      pendingRequests:   pendingRequests.length,
      activeAlerts:      alerts.length, // items; groups = alertGroups
      alertGroups:       new Set(alerts.map((a) => a.type)).size,
      tasksInReview:     tasksInReview.length,
      upcomingDeadlines: enrichedUpcoming.length,
      overdueItems:      enrichedOverdue.length,
      workforceIssues:   workforceWarnings.length,
      available:         wfCounts.Available  ?? 0,
      busy:              wfCounts.Busy       ?? 0,
      overloaded:        over.length, // QA4: one overloaded meaning (shared capacity, above the limit)
      totalProjects:     projects.length,
      activeProjects:    projects.filter((p) => p.status === "Active").length,
      delayedProjects:   projects.filter((p) => p.status === "Delayed").length,
    },
  });
}

function emptyHub() {
  return {
    requests: [], alerts: [], activity: [], upcomingDeadlines: [],
    overdueItems: [], tasksInReview: [], workforceWarnings: [],
    stats: {
      pendingRequests: 0, activeAlerts: 0, tasksInReview: 0,
      upcomingDeadlines: 0, overdueItems: 0, workforceIssues: 0,
      available: 0, busy: 0, overloaded: 0, totalProjects: 0,
      activeProjects: 0, delayedProjects: 0,
    },
  };
}

// ── GET /api/manager/requests ─────────────────────────────────────────────────
export async function getRequests(req, res) {
  const { orgId } = req.user;
  const { status = "", limit = 30 } = req.query;

  const filter = { orgId };
  if (status) filter.status = status;

  const requests = await OperationalRequest.find(filter)
    .populate("requesterId", "name role avatarSeed")
    .populate("projectId",   "title status")
    .populate("milestoneId", "title")
    .populate("resolvedBy",  "name role")
    .sort({ priority: -1, createdAt: -1 })
    .limit(Number(limit))
    .lean();

  res.json(requests);
}

// ── POST /api/manager/requests ────────────────────────────────────────────────
export async function createRequest(req, res) {
  const { orgId, id: requesterId } = req.user;
  const { type, priority, title, message, projectId, milestoneId } = req.body;

  if (!title?.trim()) return res.status(400).json({ error: "Title is required." });

  const request = await OperationalRequest.create({
    orgId,
    type:        type       ?? "Other",
    priority:    priority   ?? "Medium",
    title:       title.trim(),
    message:     message    ?? "",
    projectId:   projectId  ?? null,
    milestoneId: milestoneId ?? null,
    requesterId,
    status:      "Pending",
  });

  const populated = await OperationalRequest.findById(request._id)
    .populate("requesterId", "name role avatarSeed")
    .populate("projectId",   "title status")
    .populate("milestoneId", "title")
    .lean();

  res.status(201).json(populated);
}

// ── POST /api/manager/requests/:id/limit-decision { decision: allow|decline, note } (T-5, D-142, D-027) ──
// The Manager's only write on the task: one more try (limit +1). The request moves once, so a double click gives one try.
export async function decideLimitRequest(req, res) {
  const { orgId, id: userId } = req.user;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Request not found." });
  const request = await OperationalRequest.findOne({ _id: req.params.id, orgId }).lean();
  if (!request) return res.status(404).json({ error: "Request not found." });
  const d = limitDecision(request, req.body ?? {});
  if (d.error) return res.status(d.httpStatus).json({ error: d.error });
  const task = await Task.findOne({ _id: request.taskId, orgId }, "title assignee assignees projectId maxResubmissions reviewStage").lean();
  if (!task) return res.status(404).json({ error: "The task of this request no longer exists." });
  const moved = await OperationalRequest.findOneAndUpdate({ _id: request._id, status: { $in: ["Pending", "In Progress"] } }, { $set: { status: d.status, managerNote: d.note, resolvedAt: new Date(), resolvedBy: userId } }, { returnDocument: "after" });
  if (!moved) return res.status(409).json({ error: "This request was already decided." });
  if (d.incLimit) await Task.updateOne({ _id: task._id }, { $inc: { maxResubmissions: d.incLimit }, $set: { reviewStage: "none" } });
  if (d.incLimit && task.reviewStage === "manager_pending") await Task.updateOne({ _id: task._id, status: "In-Review" }, { $set: { status: "In-Progress" } }); // parked by the older review path
  const allowed = d.status === "Resolved";
  const by = req.user.role === "Team Lead" ? "Team Lead" : "Manager"; // E-3 (D-180): the Team Lead decides through /api/teamlead/requests
  AuditLog.create({ action: allowed ? "resubmission_allowed" : "resubmission_declined", orgId: mongoose.isValidObjectId(orgId) ? orgId : null, performedBy: userId, targetProjectId: task.projectId, detail: `${allowed ? "One more try allowed" : "Declined another try"} on "${task.title}".${d.note ? ` ${d.note}` : ""}`, after: { taskId: String(task._id), requestId: String(request._id), maxResubmissions: (task.maxResubmissions ?? 3) + d.incLimit } }).catch((e) => console.error("[limit audit]", e.message));
  Task.logActivity(task._id, userId, "edited", { note: allowed ? `${by} allowed one more submission` : `${by} declined another submission` });
  const who = [...new Set([request.requesterId, task.assignee, ...(task.assignees ?? [])].filter(Boolean).map(String))];
  await Promise.all(who.map((uid) => createNotification({ userId: uid, orgId, type: "resubmission_decided", title: allowed ? "One more try allowed" : "No more tries", message: `The ${by} ${allowed ? "allowed one more submission" : "declined another submission"} on "${task.title}".${d.note ? ` ${d.note.slice(0, 200)}` : ""}`, meta: { taskId: task._id, projectId: task.projectId } }).catch(() => {})));
  res.json({ ok: true, status: d.status });
}

// ── PATCH /api/manager/requests/:id ─────────────────────────────────────────
export async function updateRequest(req, res) {
  const { orgId, id: userId } = req.user;
  const { id } = req.params;
  const { status, managerNote } = req.body;

  const request = await OperationalRequest.findOne({ _id: id, orgId });
  if (!request) return res.status(404).json({ error: "Request not found." });
  // T-5 (D-142): a resubmission limit is decided only through Allow / Decline, which also change the task.
  if (request.type === LIMIT_TYPE && status && status !== "In Progress") return res.status(409).json({ error: "Use Allow another try or Decline for this request." });

  if (status) request.status = status;
  if (managerNote !== undefined) request.managerNote = managerNote;

  if (["Resolved", "Rejected"].includes(status)) {
    request.resolvedAt = new Date();
    request.resolvedBy = userId;
  }

  await request.save();

  const populated = await OperationalRequest.findById(request._id)
    .populate("requesterId", "name role avatarSeed")
    .populate("projectId",   "title status")
    .populate("milestoneId", "title")
    .populate("resolvedBy",  "name role")
    .lean();

  res.json(populated);
}
