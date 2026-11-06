import Risk          from "../models/Risk.js";
import Organization  from "../models/Organization.js";
import AuditLog      from "../models/AuditLog.js";
import { createNotification } from "./notificationController.js";
import mongoose from "mongoose";

const IS_OID = /^[0-9a-f]{24}$/i;
const orgFilter = (orgId) => IS_OID.test(orgId) ? { _id: orgId } : { orgId };

// D-022b: Manager+Director only (route guard handles this).
// D-022c: audit on create, close, escalate, likelihood/impact/status change.

// ── POST /api/risks  — register a risk ───────────────────────────────────────
export async function createRisk(req, res) {
  const { id: userId, orgId } = req.user;
  const {
    title, description, category, likelihood, impact,
    projectId, ownerId, dueDate, mitigation,
  } = req.body ?? {};

  if (!title?.trim())  return res.status(400).json({ error: "title required." });
  if (!likelihood || !impact) return res.status(400).json({ error: "likelihood and impact required." });

  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  const risk = await Risk.create({
    orgId:      org._id,
    title:      title.trim(),
    description: description?.trim() ?? "",
    category:   category ?? "other",
    likelihood: Number(likelihood),
    impact:     Number(impact),
    projectId:  projectId ? new mongoose.Types.ObjectId(projectId) : null,
    owner:      ownerId   ? new mongoose.Types.ObjectId(ownerId)   : new mongoose.Types.ObjectId(userId),
    dueDate:    dueDate ? new Date(dueDate) : null,
    mitigation: mitigation?.trim() ?? null,
    createdBy:  new mongoose.Types.ObjectId(userId),
  });

  await AuditLog.create({
    action:      "risk_created",
    orgId:       org._id,
    performedBy: new mongoose.Types.ObjectId(userId),
    detail:      `Risk registered: "${risk.title}" score=${risk.score}`,
    scope:       "risk",
    after:       { likelihood: risk.likelihood, impact: risk.impact, score: risk.score, status: risk.status },
  });

  res.status(201).json({ risk });
}

// ── GET /api/risks  — register table ─────────────────────────────────────────
export async function listRisks(req, res) {
  const { orgId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  const { status, projectId, page = 1, limit = 50 } = req.query;
  const filter = { orgId: org._id };
  if (status && status !== "all") filter.status = status;
  if (projectId) filter.projectId = new mongoose.Types.ObjectId(projectId);

  const [items, total] = await Promise.all([
    Risk.find(filter)
      .sort({ score: -1, createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .populate("owner",     "name role")
      .populate("createdBy", "name role")
      .lean(),
    Risk.countDocuments(filter),
  ]);

  res.json({ items, total, page: Number(page) });
}

// ── PATCH /api/risks/:id  — update (D-022c: audit only on relevant changes) ──
export async function updateRisk(req, res) {
  const { id: userId, orgId } = req.user;
  const { likelihood, impact, status, mitigation, escalateToId, resolution, ...rest } = req.body ?? {};

  const org  = await Organization.findOne(orgFilter(orgId), "_id").lean();
  const risk = await Risk.findOne({ _id: req.params.id, orgId: org._id });
  if (!risk) return res.status(404).json({ error: "Risk not found." });
  if (risk.status === "closed") return res.status(409).json({ error: "Risk is closed." });

  const before = {
    likelihood: risk.likelihood,
    impact:     risk.impact,
    status:     risk.status,
    score:      risk.score,
  };

  // D-022c: track which fields changed for audit
  let auditAction = null;
  const changed = {};

  if (likelihood !== undefined && Number(likelihood) !== risk.likelihood) {
    risk.likelihood = Number(likelihood);
    changed.likelihood = risk.likelihood;
    auditAction = "risk_updated";
  }
  if (impact !== undefined && Number(impact) !== risk.impact) {
    risk.impact = Number(impact);
    changed.impact = risk.impact;
    auditAction = "risk_updated";
  }
  if (mitigation !== undefined) risk.mitigation = mitigation;

  // Status transitions
  if (status && status !== risk.status) {
    risk.status = status;
    changed.status = status;
    if (status === "closed") {
      risk.closedAt = new Date();
      if (resolution) risk.resolution = resolution;
      auditAction = "risk_closed";
    } else if (status === "escalated") {
      const escalateTo = escalateToId
        ? new mongoose.Types.ObjectId(escalateToId)
        : null;
      risk.escalatedTo = escalateTo;
      risk.escalatedAt = new Date();
      auditAction      = "risk_escalated";
      if (escalateTo) {
        await createNotification({
          userId:  escalateTo.toString(),
          orgId,
          type:    "critical",
          title:   "Risk Escalated",
          message: `Risk "${risk.title}" (score ${risk.score}) has been escalated.`,
          meta:    { riskId: risk._id },
        });
      }
    } else {
      auditAction = "risk_updated";
    }
  }

  await risk.save();  // pre-save recomputes score

  // Audit only when score/likelihood/impact/status changed
  if (auditAction) {
    await AuditLog.create({
      action:      auditAction,
      orgId:       org._id,
      performedBy: new mongoose.Types.ObjectId(userId),
      detail:      `Risk "${risk.title}" updated`,
      scope:       "risk",
      before,
      after: {
        likelihood: risk.likelihood,
        impact:     risk.impact,
        score:      risk.score,
        status:     risk.status,
      },
    });
  }

  res.json({ risk });
}
