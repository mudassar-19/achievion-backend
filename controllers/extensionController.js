import ExtensionRequest from "../models/ExtensionRequest.js";
import Task             from "../models/Task.js";
import Project          from "../models/Project.js";
import Organization     from "../models/Organization.js";
import AuditLog         from "../models/AuditLog.js";
import { createNotification } from "./notificationController.js";
import mongoose from "mongoose";

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
  const existingCount = await ExtensionRequest.countDocuments({
    taskId,
    status: { $in: ["approved", "auto_applied"] },
  });
  const maxExtensions = rules.maxExtensionsPerTask ?? 3;
  const maxDays       = rules.extensionMaxDays ?? 30;

  if (existingCount < maxExtensions && requestedDays <= maxDays) {
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
      detail: `Extension auto-applied: +${requestedDays}d on task "${task.title}"`,
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

  // Notify Director(s) in this org
  const { default: User } = await import("../models/User.js");
  const directors = await User.find({ orgId, role: "Director", status: { $ne: "deleted" } }, "_id").lean();
  for (const dir of directors) {
    await createNotification({
      userId: dir._id.toString(),
      orgId,
      type:    "needs_action",
      title:   "Extension Request",
      message: `${role} requested +${requestedDays}d extension on "${task.title}".`,
      meta:    { extensionRequestId: ext._id, taskId },
    });
  }

  await AuditLog.create({
    action: "extension_requested",
    orgId:  new mongoose.Types.ObjectId(String(org._id)),
    performedBy: new mongoose.Types.ObjectId(userId),
    detail: `Extension requested: +${requestedDays}d on task "${task.title}"`,
    scope:  "extension",
  });

  res.status(201).json({ extension: ext, autoApplied: false });
}

// ── GET /api/director/extensions  (Director reads queue) ─────────────────────
export async function listExtensions(req, res) {
  const { orgId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  const { status = "pending", page = 1, limit = 25 } = req.query;
  const filter = { orgId: org._id };
  if (status === "history") filter.status = { $in: ["approved", "rejected", "counter_proposed"] };
  else if (status !== "all") filter.status = status;

  const [items, total] = await Promise.all([
    ExtensionRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .populate("requestedBy", "name role")
      .populate("taskId", "title deadline")
      .lean(),
    ExtensionRequest.countDocuments(filter),
  ]);

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

  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();

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
