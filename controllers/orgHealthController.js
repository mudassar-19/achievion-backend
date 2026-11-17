import Organization    from "../models/Organization.js";
import User           from "../models/User.js";
import Task            from "../models/Task.js";
import OrgHealthSnapshot from "../models/OrgHealthSnapshot.js";
import WellbeingSnapshot from "../models/WellbeingSnapshot.js";
import { snapshotWellbeing } from "../services/reportService.js";
import { computeOrgHealth, saveSnapshot, orgFilter } from "../services/orgHealthService.js";
import { WEIGHTS, MIN_SAMPLES, MIN_FACTORS } from "../services/orgHealthRules.js";
import { onTimeExpr } from "../services/onTimeRule.js";

// ── GET /api/director/org-health ──────────────────────────────────────────────
// Item 18 / RND-08: `overall` is null with status "not_enough_data" unless 3 of 4 factors have their minimum sample.
// RND-07: the weights are the shown defaults (our design choice), not editable per organisation.
export async function getOrgHealth(req, res) {
  const h = await computeOrgHealth(req.user.orgId);
  res.json({
    overall: h.overall, status: h.status, subScores: h.subScores, factors: h.factors, present: h.present,
    weights: WEIGHTS, minSamples: MIN_SAMPLES, minFactors: MIN_FACTORS,
    explain: h.explain, bands: { healthy: 75, attention: 50 }, // QA3 G-3 / G-5: points, band and inputs per factor
    assumptionNote: "Default weights: Delivery 35 / Capacity 25 / Risk control 20 / Quality 20. They are a design choice, checked by a sensitivity test whose result is under How is this calculated?",
  });
}

// ── POST /api/director/org-health/snapshot  — store a snapshot ───────────────
export async function saveOrgHealthSnapshot(req, res) {
  const snap = await saveSnapshot(req.user.orgId);
  res.status(201).json({ snapshot: snap });
}

// ── GET /api/director/org-health/history  — 12-week history ──────────────────
export async function getOrgHealthHistory(req, res) {
  const { orgId } = req.user;
  const snapshots = await OrgHealthSnapshot.find({ orgId })
    .sort({ calculatedAt: -1 })
    .limit(12)
    .lean();
  res.json({ snapshots });
}

// ── GET /api/director/dept/:deptName  — per-department metrics ────────────────
// D-038: NO ranking/leaderboard. Aggregates: delivery on-time, rework rate, quality, workload.
export async function getDeptDetail(req, res) {
  const { orgId } = req.user;
  const deptName  = decodeURIComponent(req.params.deptName ?? "");
  if (!deptName) return res.status(400).json({ error: "Department name required." });

  const org = await Organization.findOne(orgFilter(orgId), "_id workingTime").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });
  const oid = org._id.toString(); // hex — matches req.user.orgId and API-created Task records

  // Members in this department
  const members = await User.find({ orgId: oid, department: deptName, status: { $ne: "deleted" } }, "_id").lean();
  if (!members.length) return res.status(404).json({ error: "Department not found or has no members." });
  const memberIds = members.map(m => m._id);

  const [onTime, totalDone, reworked, totalTasks, qualAgg, workloadAgg] = await Promise.all([
    Task.countDocuments({ orgId: oid, assignees: { $in: memberIds }, status: { $in: ["Done"] }, $expr: { $and: [{ $ne: ["$completedAt", null] }, { $ne: ["$deadline", null] }, onTimeExpr(org.workingTime?.timezone)] } }),
    Task.countDocuments({ orgId: oid, assignees: { $in: memberIds }, status: "Done", deadline: { $ne: null } }),
    Task.countDocuments({ orgId: oid, assignees: { $in: memberIds }, resubmissionCount: { $gt: 0 } }),
    Task.countDocuments({ orgId: oid, assignees: { $in: memberIds } }),
    Task.aggregate([
      { $match: { orgId: oid, assignees: { $in: memberIds }, qualityScore: { $ne: null, $exists: true } } },
      { $group: { _id: null, avg: { $avg: "$qualityScore" }, count: { $sum: 1 } } },
    ]),
    Task.aggregate([
      { $match: { orgId: oid, assignees: { $in: memberIds }, status: { $nin: ["Done"] }, estimatedHours: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$estimatedHours" } } },
    ]),
  ]);

  const deliveryOnTime = totalDone > 0 ? Math.round((onTime / totalDone) * 100) : null;
  const reworkRate     = totalTasks > 0 ? Math.round((reworked / totalTasks) * 100) : null;
  const qualityAvg     = qualAgg[0]?.avg != null ? Math.round(((qualAgg[0].avg - 1) / 4) * 100) : null;
  const workloadHours  = workloadAgg[0]?.total ?? 0;

  res.json({
    department:    deptName,
    memberCount:   members.length,
    deliveryOnTime,
    reworkRate,
    qualityAvg,
    workloadHours,
    taskStats: { total: totalTasks, done: totalDone },
  });
}

// ── GET /api/director/departments  — list all departments with summary ─────────
export async function listDepartments(req, res) {
  const { orgId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });
  const depts = await User.distinct("department", { orgId: org._id.toString(), status: { $ne: "deleted" }, department: { $ne: null } });
  res.json({ departments: depts.filter(Boolean).sort() });
}

// ── GET /api/director/org-health/wellbeing — team well-being, counts only (no names, no one person's HP) ───────
// Today's numbers are taken fresh (and stored as today's snapshot); the trend is the last 30 daily snapshots.
export async function getOrgWellbeing(req, res) {
  const org = await Organization.findOne(orgFilter(req.user.orgId), "_id orgId").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });
  const today = await snapshotWellbeing(org);
  const trend = await WellbeingSnapshot.find({ orgId: String(org._id) }, "day tiers avgHp members").sort({ day: -1 }).limit(30).lean();
  res.json({ today, trend: trend.reverse() });
}
