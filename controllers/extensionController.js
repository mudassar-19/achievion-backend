import ExtensionRequest from "../models/ExtensionRequest.js";
import Task             from "../models/Task.js";
import Project          from "../models/Project.js";
import Organization     from "../models/Organization.js";
import AuditLog         from "../models/AuditLog.js";
import { createNotification } from "./notificationController.js";
import mongoose from "mongoose";
import Milestone from "../models/Milestone.js";
import { expireAndRemind, resolveNotifications } from "../services/decisionHub.js";

const IS_OID = /^[0-9a-f]{24}$/i;
const orgFilter = (orgId) => IS_OID.test(orgId) ? { _id: orgId } : { orgId };

// ── POST /api/extensions  (Manager submits) ───────────────────────────────────
export async function requestExtension(req, res) {
  const { id: userId, orgId, role } = req.user;
  const { taskId, reason, requestedDays } = req.body ?? {};

  if (!taskId || !reason?.trim() || !requestedDays)
    return res.status(400).json({ error: "taskId, reason, requestedDays required." });
  if (requestedDays < 1 || requestedDays > 365)
    return res.status(400).json({ error: "requestedDays must be 1–365." });

  const task = await Task.findById(taskId).lean();
  if (!task || task.orgId !== orgId) return res.status(404).json({ error: "Task not found." });

  // Prevent duplicate pending request for the same task
  const existing = await ExtensionRequest.findOne({ taskId, status: "pending" }).lean();
  if (existing) return res.status(409).json({ error: "Extension request already pending for this task." });

  const org = await Organization.findOne(orgFilter(orgId), "extensionRules _id").lean();
  const rules = org?.extensionRules ?? {};

  // Auto-apply threshold check
  const [existingCount, cumulativeDays] = await Promise.all([
    ExtensionRequest.countDocuments({ taskId, status: { $in: ["approved", "auto_applied"] } }),
    ExtensionRequest.aggregate([
      { $match: { taskId: new mongoose.Types.ObjectId(String(taskId)), status: { $in: ["approved", "auto_applied"] } } },
      { $group: { _id: null, total: { $sum: "$requestedDays" } } },
    ]).then((r) => r[0]?.total ?? 0),
  ]);

  const maxExtensions = rules.maxExtensionsPerTask ?? 3;
  const maxDays       = rules.extensionMaxDays ?? 3 /* QA4 D-QA4-12: default 3 working days */;
  const maxPct        = rules.extensionMaxPct  ?? 20;
  const maxCumCapPct  = rules.extensionCumCapPct ?? 20;

  // Pct of original duration: if no deadline, origDays=0 → pctUsed=101 (auto-blocks, requires queuing)
  const origDays = task.deadline && task.createdAt
    ? Math.ceil((new Date(task.deadline) - new Date(task.createdAt)) / 86400000)
    : 0;
  const pctUsed    = origDays > 0 ? (requestedDays / origDays) * 100 : 101;
  const cumDays    = cumulativeDays + requestedDays;
  const cumPctUsed = origDays > 0 ? (cumDays / origDays) * 100 : 101;

  if (existingCount < maxExtensions && requestedDays <= maxDays && pctUsed <= maxPct && cumPctUsed <= maxCumCapPct) {
    // Auto-apply: update task deadline
    const newDeadline = task.deadline
      ? new Date(task.deadline.getTime() + requestedDays * 86400000)
      : null;
    if (newDeadline) await Task.findByIdAndUpdate(taskId, { $set: { deadline: newDeadline, deadlineAlertSentAt: null } });

    const ext = await ExtensionRequest.create({
      orgId: new mongoose.Types.ObjectId(String(org._id)),
      taskId, projectId: task.projectId ?? null,
      requestedBy: new mongoose.Types.ObjectId(userId),
      reason: reason.trim(),
      requestedDays,
      originalDeadline: task.deadline ?? null,
      status: "auto_applied",
      autoApplied: true,
    });

    await AuditLog.create({
      action: "extension_requested",
      orgId:  new mongoose.Types.ObjectId(String(org._id)),
      performedBy: new mongoose.Types.ObjectId(userId),
      detail: `Extension auto-applied (+${requestedDays}d, within limits: days≤${maxDays}, pct≤${maxPct}%) on task "${task.title}"`,
      scope:  "extension",
    });

    return res.json({ extension: ext, autoApplied: true });
  }

  // Queue path: notify Director
  const ext = await ExtensionRequest.create({
    orgId: new mongoose.Types.ObjectId(String(org._id)),
    taskId, projectId: task.projectId ?? null,
    requestedBy: new mongoose.Types.ObjectId(userId),
    reason: reason.trim(),
    requestedDays,
    originalDeadline: task.deadline ?? null,
  });

  // Notify the decider: up to the limit the project's Manager decides (QA4 D-QA4-12), above it the Director(s)
  const { default: User } = await import("../models/User.js");
  const mgrId = requestedDays <= maxDays && task.projectId ? (await Project.findById(task.projectId, "managerId").lean())?.managerId : null;
  const directors = mgrId && String(mgrId) !== String(userId) ? [{ _id: mgrId }] : await User.find({ orgId, role: "Director", status: { $ne: "deleted" } }, "_id").lean();
  const [who, proj] = await Promise.all([User.findById(userId, "name").lean(), task.projectId ? Project.findById(task.projectId, "title").lean() : null]); // B-3: name the person and the project
  for (const dir of directors) {
    await createNotification({
      userId: dir._id.toString(),
      orgId,
      type:    "needs_action",
      title:   "Extension request",
      message: `${who?.name ?? "A " + role} (${role}) asked for ${requestedDays} more working day${requestedDays === 1 ? "" : "s"} on "${task.title}"${proj ? ` in ${proj.title}` : ""}.`,
      meta:    { extensionRequestId: ext._id, taskId },
    });
  }

  // QA3 G-15 / B-27: plain words, working days (the unit the rule uses)
  const exceedReason = requestedDays > maxDays ? `more than the ${maxDays}-working-day limit` : `more than ${maxPct}% of the plan`;
  await AuditLog.create({
    action: "extension_requested",
    orgId:  new mongoose.Types.ObjectId(String(org._id)),
    performedBy: new mongoose.Types.ObjectId(userId),
    detail: `Sent to the Director: ${requestedDays} working day${requestedDays === 1 ? "" : "s"} asked, ${exceedReason}, for task "${task.title}"`,
    scope:  "extension",
  });

  res.status(201).json({ extension: ext, autoApplied: false });
}

// ── GET /api/director/extensions  (Director reads queue) ─────────────────────
export async function listExtensions(req, res) {
  const { orgId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  await expireAndRemind(org._id).catch((e) => console.warn("[decision-hub]", e.message)); // C-6
  const { status = "pending", page = 1, limit = 25 } = req.query;
  const filter = { orgId: org._id };
  if (status === "history") filter.status = { $in: ["approved", "rejected", "counter_proposed", "expired"] };
  else if (status !== "all") filter.status = status;

  const [items, total] = await Promise.all([
    ExtensionRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .populate("requestedBy", "name role")
      .populate({ path: "taskId", select: "title deadline projectId milestoneId assignee createdAt", populate: [{ path: "assignee", select: "name role" }] })
      .populate("decidedBy", "name role")
      .lean(),
    ExtensionRequest.countDocuments(filter),
  ]);

  // C-7: context for the decision: project, module, who does the task, and how much extension it already had.
  const taskIds = items.filter((x) => x.taskId?._id).map((x) => x.taskId._id);
  const [prior, projs, mods] = await Promise.all([
    taskIds.length ? ExtensionRequest.aggregate([{ $match: { taskId: { $in: taskIds }, status: { $in: ["approved", "auto_applied"] } } }, { $group: { _id: "$taskId", count: { $sum: 1 }, days: { $sum: "$requestedDays" } } }]) : [],
    Project.find({ _id: { $in: items.map((x) => x.taskId?.projectId ?? x.projectId).filter(Boolean) } }, "title").lean(),
    Milestone.find({ _id: { $in: items.map((x) => x.taskId?.milestoneId).filter(Boolean) } }, "title").lean(),
  ]);
  const priorBy = Object.fromEntries(prior.map((p) => [String(p._id), p])), projBy = Object.fromEntries(projs.map((p) => [String(p._id), p.title])), modBy = Object.fromEntries(mods.map((m) => [String(m._id), m.title]));
  for (const x of items) {
    const t = x.taskId, p = t?._id ? priorBy[String(t._id)] : null;
    const origDays = t?.deadline && t?.createdAt ? Math.max(1, Math.ceil((new Date(t.deadline) - new Date(t.createdAt)) / 86400000)) : null;
    x.context = {
      project: projBy[String(t?.projectId ?? x.projectId)] ?? null, module: t?.milestoneId ? modBy[String(t.milestoneId)] ?? null : null,
      assignee: t?.assignee?.name ?? null, earlierExtensions: p?.count ?? 0, earlierDays: p?.days ?? 0,
      totalPct: origDays ? Math.round((((p?.days ?? 0) + x.requestedDays) / origDays) * 100) : null, // this request plus earlier ones, as % of the task's original length
    };
  }

  // Project-level requests (M-2) have no task; give the Director queue a readable title in the same place.
  const projIds = items.filter((x) => !x.taskId && x.projectId).map((x) => x.projectId);
  const titles = projIds.length ? Object.fromEntries((await Project.find({ _id: { $in: projIds } }, "title deadline").lean()).map((p) => [String(p._id), p])) : {};
  for (const x of items) if (!x.taskId && titles[String(x.projectId)]) {
    const p = titles[String(x.projectId)];
    x.taskId = { title: `Project deadline: ${p.title}`, deadline: p.deadline };
  }
  res.json({ items, total, page: Number(page) });
}

// ── PATCH /api/director/extensions/:id  (approve | reject | counter_propose) ─
export async function decideExtension(req, res) {
  const { id: directorId, orgId } = req.user;
  const { action, directorNote, counterDays } = req.body ?? {};

  if (!["approve", "reject", "counter_propose"].includes(action))
    return res.status(400).json({ error: "action must be approve|reject|counter_propose." });
  if (action === "reject") {
    const note = directorNote?.trim() ?? "";
    if (note.length < 10) return res.status(400).json({ error: "Rejection reason required (min 10 chars)." });
    if (note.length > 500) return res.status(400).json({ error: "Rejection reason too long (max 500 chars)." });
  }

  const ext = await ExtensionRequest.findById(req.params.id)
    .populate("taskId", "title deadline orgId");
  if (!ext) return res.status(404).json({ error: "Extension request not found." });
  if (ext.taskId?.orgId?.toString() !== orgId && ext.orgId?.toString() !== orgId)
    return res.status(403).json({ error: "Forbidden." });
  if (ext.status !== "pending")
    return res.status(409).json({ error: "Extension request already decided." });

  const org = await Organization.findOne(orgFilter(orgId), "_id extensionRules").lean();
  // QA4 D-QA4-12: a Manager decides requests up to the limit (default 3 working days) on projects they manage; above that only the Director.
  if (req.user.role === "Manager") {
    const limit = org?.extensionRules?.extensionMaxDays ?? 3;
    const own = ext.projectId && await Project.exists({ _id: ext.projectId, managerId: req.user.id });
    if (!own) return res.status(404).json({ error: "Extension request not found." });
    if (ext.requestedDays > limit || (action === "counter_propose" && counterDays > limit)) return res.status(403).json({ error: `Requests above ${limit} working days are decided by the Director.`, code: "NEEDS_DIRECTOR", limit });
  }

  const update = {
    decidedBy:    new mongoose.Types.ObjectId(directorId),
    decidedAt:    new Date(),
    directorNote: directorNote?.trim() ?? null,
  };

  let auditAction;
  let deadlineBefore = null;
  let deadlineAfter  = null;
  if (action === "approve") {
    update.status = "approved";
    auditAction   = "extension_approved";
    // Apply new deadline to the task, or to the project for a project-level request (M-2, taskId null)
    const task = ext.taskId ? await Task.findById(ext.taskId._id) : null;
    if (!ext.taskId && ext.projectId) {
      const project = await Project.findById(ext.projectId);
      if (project?.deadline) {
        deadlineBefore = project.deadline;
        project.deadline = new Date(project.deadline.getTime() + ext.requestedDays * 86400000);
        deadlineAfter = project.deadline;
        await project.save();
      }
    }
    if (task?.deadline) {
      deadlineBefore = task.deadline;
      task.deadline  = new Date(task.deadline.getTime() + ext.requestedDays * 86400000);
      task.deadlineAlertSentAt = null; // 1.5: alert again for the new date
      deadlineAfter  = task.deadline;
      await task.save();
    }
  } else if (action === "reject") {
    update.status = "rejected";
    if (req.body.directorNote?.trim()) update.directorNote = req.body.directorNote.trim();
    auditAction   = "extension_rejected";
  } else {
    if (!counterDays || counterDays < 1)
      return res.status(400).json({ error: "counterDays required for counter_propose." });
    update.status      = "counter_proposed";
    update.counterDays = counterDays;
    auditAction        = "extension_counter_proposed";
  }

  const updated = await ExtensionRequest.findByIdAndUpdate(
    ext._id, { $set: update }, { returnDocument: "after", new: true }
  );

  await AuditLog.create({
    action: auditAction,
    orgId:  org?._id ?? null,
    performedBy: new mongoose.Types.ObjectId(directorId),
    detail: `Extension ${action}: ${ext.taskId ? `task "${ext.taskId.title}"` : "project deadline"}${counterDays ? ` counter=${counterDays}d` : ""}`,
    targetProjectId: ext.projectId ?? null,
    scope:  "extension",
    before: { status: "pending", ...(deadlineBefore ? { deadline: deadlineBefore } : {}) },
    after:  { status: update.status, ...(deadlineAfter  ? { deadline: deadlineAfter  } : {}) },
  });

  // B-2: the Directors' "needs action" bell items for this request close with the outcome.
  await resolveNotifications(ext._id, action === "approve" ? "Approved" : action === "reject" ? "Rejected" : "Counter-proposed");

  // Notify requester
  await createNotification({
    userId:  ext.requestedBy.toString(),
    orgId,
    type:    "needs_action",
    title:   `Extension ${action === "approve" ? "Approved" : action === "reject" ? "Rejected" : "Counter-Proposed"}`,
    message: directorNote ?? `Director has ${action === "counter_propose" ? `counter-proposed ${counterDays}d` : action + "d"} your extension request.`,
    meta:    { extensionRequestId: ext._id },
  });

  res.json({ extension: updated });
}

// QA4 D-QA4-12: GET /api/manager/extensions/pending: pending requests on this Manager's projects that they may decide (up to the limit).
export async function listManagerPendingExtensions(req, res) {
  const org = await Organization.findOne(orgFilter(req.user.orgId), "_id extensionRules").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });
  const limit = org.extensionRules?.extensionMaxDays ?? 3;
  const pids = (await Project.find({ managerId: req.user.id, isDeleted: { $ne: true } }, "_id").lean()).map((p) => p._id);
  const rows = await ExtensionRequest.find({ orgId: org._id, projectId: { $in: pids }, status: "pending" }).populate("requestedBy", "name").populate("taskId", "title").populate("projectId", "title").sort({ createdAt: 1 }).limit(50).lean();
  res.json({ limit, items: rows.map((e) => ({ id: e._id, task: e.taskId?.title ?? null, project: e.projectId?.title ?? null, requestedBy: e.requestedBy?.name ?? "Former member", days: e.requestedDays, reason: e.reason, createdAt: e.createdAt, canDecide: e.requestedDays <= limit })) });
}
