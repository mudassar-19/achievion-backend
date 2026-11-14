import Approval        from "../models/Approval.js";
import Organization     from "../models/Organization.js";
import User             from "../models/User.js";
import * as approvalSvc from "../services/approvalService.js";
import mongoose          from "mongoose";

// ── helper: resolve org ObjectId from the Director's string orgId ─────────────
// Supports both the orgId code string ("ORG-XXXXXX") and raw ObjectId strings
// (legacy Directors created before the orgId-fix were stored with ObjectId).
async function resolveOrgObjectId(orgIdString) {
  let org = await Organization.findOne({ orgId: orgIdString }).select("_id");
  if (org) return org._id;
  if (mongoose.Types.ObjectId.isValid(orgIdString)) {
    org = await Organization.findById(orgIdString).select("_id");
  }
  return org?._id ?? null;
}

// ── getPendingApprovals ────────────────────────────────────────────────────────
// GET /api/approvals  (Director only)
export async function getPendingApprovals(req, res) {
  if (req.user.role !== "Director") {
    return res.status(403).json({ error: "Director access required." });
  }

  const orgObjectId = await resolveOrgObjectId(req.user.orgId);
  if (!orgObjectId) return res.status(404).json({ error: "Organization not found." });

  const approvals = await Approval.find({
    orgId:  orgObjectId,
    status: "PENDING",
  })
    .populate("requestedBy",      "name email role")
    .populate("targetEmployeeId", "name email role")
    .sort({ createdAt: -1 });

  res.json({ approvals });
}

// ── getApprovalHistory ────────────────────────────────────────────────────────
// GET /api/approvals/history  (Director only)
// Optional ?status=APPROVED|REJECTED|PENDING  filter
export async function getApprovalHistory(req, res) {
  if (req.user.role !== "Director") {
    return res.status(403).json({ error: "Director access required." });
  }

  const orgObjectId = await resolveOrgObjectId(req.user.orgId);
  if (!orgObjectId) return res.status(404).json({ error: "Organization not found." });

  const filter = { orgId: orgObjectId };
  const { status } = req.query;
  if (status && ["PENDING", "APPROVED", "REJECTED"].includes(status.toUpperCase())) {
    filter.status = status.toUpperCase();
  }

  const approvals = await Approval.find(filter)
    .populate("requestedBy",      "name email role")
    .populate("targetEmployeeId", "name email role")
    .populate("resolvedBy",       "name role")
    .sort({ createdAt: -1 });

  res.json({ approvals });
}

// ── approveRequest ────────────────────────────────────────────────────────────
// POST /api/approvals/:id/approve  (Director only)
export async function approveRequest(req, res) {
  if (req.user.role !== "Director") {
    return res.status(403).json({ error: "Director access required." });
  }

  // Guard: Director cannot approve suspension of themselves or another Director
  const approval = await Approval.findById(req.params.id).populate("targetEmployeeId", "role _id");
  if (!approval) return res.status(404).json({ error: "Approval not found." });

  if (approval.actionType === "SUSPEND_EMPLOYEE") {
    const target = approval.targetEmployeeId;
    const dirId  = req.user._id ?? req.user.id;
    if (target?.role === "Director") {
      return res.status(403).json({ error: "Director accounts cannot be suspended via this flow." });
    }
    if (String(target?._id) === String(dirId)) {
      return res.status(403).json({ error: "You cannot approve your own suspension." });
    }
    // 410 only for non-emergency (emergency stays PENDING/staleFlagged; Director can still act)
    if (approval.expiresAt && new Date() > approval.expiresAt && !approval.payload?.emergency) {
      return res.status(410).json({ error: "Suspension approval window has expired (72h). Request a new suspension." });
    }
  }

  await approvalSvc.executeApproval(req.params.id, req.user._id ?? req.user.id);
  res.json({ success: true, message: "Request approved and executed" });
}

// ── rejectRequest ─────────────────────────────────────────────────────────────
// POST /api/approvals/:id/reject  (Director only)
export async function rejectRequest(req, res) {
  if (req.user.role !== "Director") {
    return res.status(403).json({ error: "Director access required." });
  }

  // Guard: Director cannot revert suspension of themselves or another Director
  const approval = await Approval.findById(req.params.id).populate("targetEmployeeId", "role _id");
  if (!approval) return res.status(404).json({ error: "Approval not found." });
  if (approval.actionType === "SUSPEND_EMPLOYEE") {
    const target = approval.targetEmployeeId;
    const dirId  = req.user._id ?? req.user.id;
    if (target?.role === "Director") {
      return res.status(403).json({ error: "Director accounts cannot be suspended via this flow." });
    }
    if (String(target?._id) === String(dirId)) {
      return res.status(403).json({ error: "You cannot act on your own suspension." });
    }
  }

  const rejectionReason = req.body.reason ?? null;
  await approvalSvc.rejectApproval(req.params.id, rejectionReason, req.user._id ?? req.user.id);
  res.json({ success: true, message: "Request rejected" });
}
