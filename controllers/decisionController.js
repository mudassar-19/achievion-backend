// Items 10 and 55: decided account requests with both notes (Director) and the same list for the Org admin.
// GET /api/approvals/decisions?scope=decided|rejected|suspended   (Director)
// GET /api/org/decisions?scope=...                                (Org admin, organisation token)
import mongoose from "mongoose";
import Approval from "../models/Approval.js";
import Organization from "../models/Organization.js";
import { decisionRow, decisionFilter } from "../services/decisionHistory.js";

async function rows(orgObjectId, scope) {
  const docs = await Approval.find({ orgId: orgObjectId, ...decisionFilter(scope) }, "actionType status payload targetEmployeeId directorNote rejectionReason createdAt resolvedAt resolvedBy")
    .populate("targetEmployeeId", "name role").populate("resolvedBy", "name")
    .sort({ resolvedAt: -1, createdAt: -1 }).limit(200).lean();
  return docs.map(decisionRow);
}

export async function directorDecisions(req, res) {
  const id = String(req.user.orgId);
  const org = await Organization.findOne(/^[0-9a-f]{24}$/i.test(id) ? { _id: id } : { orgId: id }, "_id").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });
  res.json({ decisions: await rows(org._id, req.query.scope) });
}

export async function orgDecisions(req, res) {
  res.json({ decisions: await rows(new mongoose.Types.ObjectId(req.org.orgDbId), req.query.scope) });
}
