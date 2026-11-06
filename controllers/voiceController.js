import VoiceReport, { VoiceMessage } from "../models/VoiceReport.js";
import Organization from "../models/Organization.js";
import User         from "../models/User.js";
import AuditLog     from "../models/AuditLog.js";
import { createNotification } from "./notificationController.js";
import mongoose from "mongoose";

const IS_OID = /^[0-9a-f]{24}$/i;
const orgFilter = (orgId) => IS_OID.test(orgId) ? { _id: orgId } : { orgId };

// ── POST /api/voice  — submit a new voice report ─────────────────────────────
export async function createReport(req, res) {
  const { id: userId, orgId } = req.user;
  const { subject, description, category, anonymous, targetId, priority } = req.body ?? {};

  if (!subject?.trim() || !description?.trim())
    return res.status(400).json({ error: "subject and description required." });

  const org = await Organization.findOne(orgFilter(orgId), "_id settings").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  // Routing: complaint against a Director → escalationContact; else → Director(s)
  let assignedTo = null;
  if (targetId) {
    const target = await User.findById(targetId, "role").lean();
    if (target?.role === "Director") {
      assignedTo = org.settings?.escalationContactId ?? null;
    }
  }

  // Fall back to first Director in org
  if (!assignedTo) {
    const director = await User.findOne({ orgId, role: "Director", status: { $ne: "deleted" } }, "_id").lean();
    assignedTo = director?._id ?? null;
  }

  const report = await VoiceReport.create({
    orgId:      org._id,
    reporterId: new mongoose.Types.ObjectId(userId),
    anonymous:  !!anonymous,
    targetId:   targetId ? new mongoose.Types.ObjectId(targetId) : null,
    category:   category ?? "concern",
    subject:    subject.trim(),
    description: description.trim(),
    priority:   priority ?? "medium",
    assignedTo,
  });

  await AuditLog.create({
    action:      "voice_report_created",
    orgId:       org._id,
    performedBy: new mongoose.Types.ObjectId(userId),
    detail:      `Voice report: "${subject.trim()}" (${category ?? "concern"})`,
    scope:       "voice",
  });

  if (assignedTo) {
    await createNotification({
      userId:  assignedTo.toString(),
      orgId,
      type:    "needs_action",
      title:   "New Voice Report",
      message: `A ${category ?? "concern"} has been submitted: "${subject.trim()}"`,
      meta:    { reportId: report._id },
    });
  }

  res.status(201).json({ report });
}

// ── GET /api/director/voice  — Director inbox ─────────────────────────────────
export async function listReports(req, res) {
  const { orgId, id: directorId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  const { status = "open", page = 1, limit = 25 } = req.query;
  const filter = { orgId: org._id };
  if (status !== "all") filter.status = status;

  const [items, total] = await Promise.all([
    VoiceReport.find(filter)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .populate({ path: "reporterId", select: "name role" })
      .populate({ path: "targetId",   select: "name role" })
      .lean(),
    VoiceReport.countDocuments(filter),
  ]);

  res.json({
    items: items.map((r) => ({
      id:          r._id,
      subject:     r.subject,
      category:    r.category,
      status:      r.status,
      priority:    r.priority,
      anonymous:   r.anonymous,
      reporter:    r.anonymous ? null : { id: r.reporterId?._id, name: r.reporterId?.name, role: r.reporterId?.role },
      target:      r.targetId ? { id: r.targetId._id, name: r.targetId.name, role: r.targetId.role } : null,
      createdAt:   r.createdAt,
      escalatedAt: r.escalatedAt ?? null,
    })),
    total,
    page: Number(page),
  });
}

// ── GET /api/director/voice/:id  — report detail + thread ────────────────────
export async function getReport(req, res) {
  const { orgId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();

  const report = await VoiceReport.findOne({ _id: req.params.id, orgId: org._id })
    .populate("reporterId", "name role")
    .populate("targetId", "name role")
    .lean();
  if (!report) return res.status(404).json({ error: "Report not found." });

  const messages = await VoiceMessage.find({ reportId: report._id })
    .sort({ createdAt: 1 })
    .populate("senderId", "name role")
    .lean();

  res.json({ report, messages });
}

// ── POST /api/director/voice/:id/message  — reply in thread ──────────────────
export async function addMessage(req, res) {
  const { id: userId, orgId } = req.user;
  const { content } = req.body ?? {};
  if (!content?.trim()) return res.status(400).json({ error: "content required." });

  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();
  const report = await VoiceReport.findOne({ _id: req.params.id, orgId: org._id });
  if (!report) return res.status(404).json({ error: "Report not found." });
  if (report.status === "closed") return res.status(409).json({ error: "Report is closed." });

  const { id: senderId, role: senderRole } = req.user;
  const msg = await VoiceMessage.create({
    reportId:   report._id,
    senderId:   new mongoose.Types.ObjectId(senderId),
    senderRole,
    content:    content.trim(),
  });

  // Update report status to in_progress on first reply
  if (report.status === "open") {
    report.status = "in_progress";
    await report.save();
  }

  res.status(201).json({ message: msg });
}

// ── PATCH /api/director/voice/:id  — escalate or close ───────────────────────
export async function updateReport(req, res) {
  const { id: directorId, orgId } = req.user;
  const { action, resolution, escalateToId } = req.body ?? {};

  if (!["escalate", "close", "resolve", "set_in_progress", "set_awaiting"].includes(action))
    return res.status(400).json({ error: "action must be escalate|close|resolve|set_in_progress|set_awaiting." });

  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();
  const report = await VoiceReport.findOne({ _id: req.params.id, orgId: org._id });
  if (!report) return res.status(404).json({ error: "Report not found." });
  if (report.status === "closed") return res.status(409).json({ error: "Report already closed." });

  // Simple status transitions
  if (action === "set_in_progress") {
    report.status = "in_progress";
    await report.save();
    return res.json({ report });
  }
  if (action === "set_awaiting") {
    report.status = "awaiting_response";
    await report.save();
    return res.json({ report });
  }
  if (action === "resolve") {
    report.status = "resolved";
    await report.save();
    return res.json({ report });
  }

  let auditAction;
  if (action === "escalate") {
    const escalateTo = escalateToId
      ? new mongoose.Types.ObjectId(escalateToId)
      : (org.settings?.escalationContactId ?? null);
    report.status      = "escalated";
    report.escalatedTo  = escalateTo;
    report.escalatedAt  = new Date();
    auditAction         = "voice_report_escalated";
    if (escalateTo) {
      await createNotification({
        userId:  escalateTo.toString(),
        orgId,
        type:    "critical",
        title:   "Escalated Voice Report",
        message: `Voice report "${report.subject}" has been escalated to you.`,
        meta:    { reportId: report._id },
      });
    }
  } else {
    if (!resolution?.trim()) return res.status(400).json({ error: "resolution required to close." });
    report.status     = "closed";
    report.closedAt   = new Date();
    report.resolution = resolution.trim();
    auditAction       = "voice_report_closed";
  }

  await report.save();

  await AuditLog.create({
    action: auditAction,
    orgId:  org._id,
    performedBy: new mongoose.Types.ObjectId(directorId),
    detail: `Voice report "${report.subject}" — ${action}`,
    scope:  "voice",
  });

  res.json({ report });
}

// ── GET /api/manager/voice  — Manager sees project-scoped reports, excl. self ─
export async function listManagerReports(req, res) {
  const { orgId, id: managerId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  const { status, page = 1, limit = 25 } = req.query;
  const filter = {
    orgId: org._id,
    targetId: { $ne: new mongoose.Types.ObjectId(managerId) }, // D-022: cannot see reports about self
  };
  if (status && status !== "all") filter.status = status;

  const [items, total] = await Promise.all([
    VoiceReport.find(filter)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .populate({ path: "reporterId", select: "name role" })
      .populate({ path: "targetId",   select: "name role" })
      .lean(),
    VoiceReport.countDocuments(filter),
  ]);

  res.json({
    items: items.map((r) => ({
      id:        r._id,
      subject:   r.subject,
      category:  r.category,
      status:    r.status,
      anonymous: r.anonymous,
      reporter:  r.anonymous ? null : { id: r.reporterId?._id, name: r.reporterId?.name },
      target:    r.targetId  ? { id: r.targetId._id, name: r.targetId.name } : null,
      createdAt: r.createdAt,
    })),
    total,
    page: Number(page),
  });
}
