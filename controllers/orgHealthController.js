import { orgWorkTime, teamWeeklyCapacity } from "../services/workloadRules.js";
import Organization    from "../models/Organization.js";
import User           from "../models/User.js";
import Task            from "../models/Task.js";
import Risk            from "../models/Risk.js";
import Team            from "../models/Team.js";
import OrgHealthSnapshot from "../models/OrgHealthSnapshot.js";

const IS_OID   = /^[0-9a-f]{24}$/i;
const orgFilter = (orgId) => IS_OID.test(orgId) ? { _id: orgId } : { orgId };

// Weights (D-025a — ASSUMPTION, configurable later)
const WEIGHTS = { delivery: 35, capacity: 25, risk: 20, quality: 20 };

async function computeSubScores(orgId) {
  const org = await Organization.findOne(orgFilter(orgId), "_id workingTime").lean();
  if (!org) throw new Error("Org not found");
  const oid = org._id.toString(); // hex — matches req.user.orgId and API-created Task/Team records

  // Delivery
  const [onTime, totalDone] = await Promise.all([
    Task.countDocuments({ orgId: oid, status: "Done", $expr: { $lte: ["$completedAt","$deadline"] } }),
    Task.countDocuments({ orgId: oid, status: "Done", deadline: { $ne: null } }),
  ]);
  const delivery = totalDone > 0 ? Math.round((onTime / totalDone) * 100) : null;

  // Capacity — sum estimatedHours for open tasks vs available hours across teams
  const [teams, openHours] = await Promise.all([
    Team.find({ orgId: oid, status: { $ne: "archived" } }).select("members").lean(),
    Task.aggregate([
      { $match: { orgId: oid, status: { $nin: ["Done"] }, estimatedHours: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$estimatedHours" } } },
    ]),
  ]);
  const { hoursPerDay, workingDays } = orgWorkTime(org);
  // 4.2a: real members per team (Team.capacity defaulted to 10)
  const availHours  = teams.reduce((s, t) => s + teamWeeklyCapacity({ memberCount: t.members?.length ?? 0, hoursPerDay, workingDays }), 0);
  const plannedHrs  = openHours[0]?.total ?? 0;
  const capacity    = availHours > 0
    ? Math.round(Math.max(0, 100 - Math.max(0, (plannedHrs / availHours - 1) * 100)))
    : null;

  // Risk — open high-severity (score >= 15 = likelihood×impact >= 15)
  const [highRisks, allOpenRisks] = await Promise.all([
    Risk.countDocuments({ orgId: org._id, status: "open", score: { $gte: 15 } }),
    Risk.countDocuments({ orgId: org._id, status: "open" }),
  ]);
  const risk = allOpenRisks > 0
    ? Math.round(100 - (highRisks / allOpenRisks) * 100)
    : null;

  // Quality — mean qualityScore normalized to 0–100 (oid already hex from org._id)
  const qualAgg = await Task.aggregate([
    { $match: { orgId: oid, qualityScore: { $ne: null, $exists: true } } },
    { $group: { _id: null, avg: { $avg: "$qualityScore" } } },
  ]);
  const quality = qualAgg[0]?.avg != null
    ? Math.round(((qualAgg[0].avg - 1) / 4) * 100)
    : null;

  return { delivery, capacity, risk, quality };
}

// ── GET /api/director/org-health ──────────────────────────────────────────────
export async function getOrgHealth(req, res) {
  const { orgId } = req.user;
  const subScores = await computeSubScores(orgId);
  const { delivery, capacity, risk, quality } = subScores;

  // Overall weighted average (skip null sub-scores)
  let weightSum = 0, scoreSum = 0;
  if (delivery != null) { scoreSum += delivery  * WEIGHTS.delivery;  weightSum += WEIGHTS.delivery; }
  if (capacity != null) { scoreSum += capacity  * WEIGHTS.capacity;  weightSum += WEIGHTS.capacity; }
  if (risk     != null) { scoreSum += risk      * WEIGHTS.risk;      weightSum += WEIGHTS.risk; }
  if (quality  != null) { scoreSum += quality   * WEIGHTS.quality;   weightSum += WEIGHTS.quality; }
  const overall = weightSum > 0 ? Math.round(scoreSum / weightSum) : null;

  res.json({ overall, subScores, weights: WEIGHTS, assumptionNote: "Weights are ASSUMPTION — Delivery 35 / Capacity 25 / Risk 20 / Quality 20" });
}

// ── POST /api/director/org-health/snapshot  — store a snapshot ───────────────
export async function saveOrgHealthSnapshot(req, res) {
  const { orgId } = req.user;
  const subScores = await computeSubScores(orgId);
  const { delivery, capacity, risk, quality } = subScores;

  let weightSum = 0, scoreSum = 0;
  if (delivery != null) { scoreSum += delivery  * WEIGHTS.delivery;  weightSum += WEIGHTS.delivery; }
  if (capacity != null) { scoreSum += capacity  * WEIGHTS.capacity;  weightSum += WEIGHTS.capacity; }
  if (risk     != null) { scoreSum += risk      * WEIGHTS.risk;      weightSum += WEIGHTS.risk; }
  if (quality  != null) { scoreSum += quality   * WEIGHTS.quality;   weightSum += WEIGHTS.quality; }
  const overall = weightSum > 0 ? Math.round(scoreSum / weightSum) : 0;

  const snap = await OrgHealthSnapshot.create({
    orgId, overall, subScores, inputs: subScores, calculatedAt: new Date(),
  });
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
  if (!org) return res.status(404).json({ error: "Organisation not found." });
  const oid = org._id.toString(); // hex — matches req.user.orgId and API-created Task records

  // Members in this department
  const members = await User.find({ orgId: oid, department: deptName, status: { $ne: "deleted" } }, "_id").lean();
  if (!members.length) return res.status(404).json({ error: "Department not found or has no members." });
  const memberIds = members.map(m => m._id);

  const [onTime, totalDone, reworked, totalTasks, qualAgg, workloadAgg] = await Promise.all([
    Task.countDocuments({ orgId: oid, assignees: { $in: memberIds }, status: { $in: ["Done"] }, $expr: { $and: [{ $ne: ["$completedAt", null] }, { $ne: ["$deadline", null] }, { $lte: ["$completedAt", "$deadline"] }] } }),
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
  if (!org) return res.status(404).json({ error: "Organisation not found." });
  const depts = await User.distinct("department", { orgId: org._id.toString(), status: { $ne: "deleted" }, department: { $ne: null } });
  res.json({ departments: depts.filter(Boolean).sort() });
}
