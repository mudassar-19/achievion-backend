// Org Health from the database (item 18, RND-01..08). The formulas are in orgHealthRules.js (pure, tested).
// Delivery reads the same shared project health as the Manager, Team Lead and Director lists (healthForProjects).
import Organization from "../models/Organization.js";
import User from "../models/User.js";
import Task from "../models/Task.js";
import Risk from "../models/Risk.js";
import Project from "../models/Project.js";
import OrgHealthSnapshot from "../models/OrgHealthSnapshot.js";
import { healthForProjects } from "./projectHealthService.js";
import { orgWeekLoadPct } from "./capacity.js";
import { deliveryScore, capacityScore, riskScore, combineFactors, explainFactors } from "./orgHealthRules.js";
import { onTimeExpr } from "./onTimeRule.js";
import { orgProjectScope } from "./directorScope.js";
import { orgQualityFactor } from "./orgQuality.js";

const IS_OID = /^[0-9a-f]{24}$/i;
export const orgFilter = (orgId) => (IS_OID.test(orgId) ? { _id: orgId } : { orgId });
const DAY = 86_400_000;

// → { overall|null, status: "ok"|"not_enough_data", factors: { delivery|capacity|risk|quality: { score, samples, enough } }, weights,
//     subScores: { delivery, capacity, risk, quality }  (plain numbers, kept for the snapshot and the old client) }
export async function computeOrgHealth(orgId, now = new Date()) {
  const org = await Organization.findOne(orgFilter(orgId), "_id workingTime").lean();
  if (!org) throw new Error("Org not found");
  const oid = org._id.toString(); // hex: matches req.user.orgId and API-created Task/Team records

  // Delivery (RND-01): hours-weighted mean of project health over the same projects the Garden shows.
  const dirIds = (await User.find({ orgId: oid, role: "Director" }, "_id").lean()).map((d) => d._id);
  const projects = await Project.find({ ...(await orgProjectScope(oid)), status: { $ne: "Deleted" } }, "startDate createdAt deadline").lean();
  const [health, hoursAgg, doneWithDeadline] = await Promise.all([
    healthForProjects(projects, now),
    Task.aggregate([{ $match: { projectId: { $in: projects.map((p) => p._id) } } }, { $group: { _id: "$projectId", h: { $sum: { $ifNull: ["$estimatedHours", 0] } } } }]),
    Task.countDocuments({ orgId: oid, status: "Done", deadline: { $ne: null } }),
  ]);
  // QA3 G-5: how many of those were on time under the one on-time rule; shown as an input of the Delivery factor.
  const onTimeDone = await Task.countDocuments({ orgId: oid, status: "Done", deadline: { $ne: null }, completedAt: { $ne: null }, $expr: onTimeExpr(org.workingTime?.timezone) });
  const hours = Object.fromEntries(hoursAgg.map((r) => [String(r._id), r.h]));
  const delivery = deliveryScore(projects.map((p) => ({ score: health.get(String(p._id))?.score ?? null, hours: hours[String(p._id)] ?? 0 })));

  // Capacity (RND-04): this week's planned hours (open tasks due this week) over the teams' weekly capacity, as in the heat map.
  const load = await orgWeekLoadPct(org, now); // G-1: same function as the heatmap and the Manager's workload
  const withMembers = load.teamsWithMembers;
  const capacity = load.pct != null ? capacityScore(load.pct) : null;

  // Risk (RND-05): open high (score >= 15) and medium (8-14); No data when none was ever logged.
  const [high, medium, everLogged] = await Promise.all([
    Risk.countDocuments({ orgId: org._id, status: "open", score: { $gte: 15 } }),
    Risk.countDocuments({ orgId: org._id, status: "open", score: { $gte: 8, $lt: 15 } }),
    Risk.countDocuments({ orgId: org._id }),
  ]);

  // Quality (RND-06): shared with the Director home card (LB-2).
  const quality = await orgQualityFactor(oid, now);

  const r = combineFactors({
    delivery: { score: delivery, samples: doneWithDeadline },
    capacity: { score: capacity, samples: withMembers },
    risk: { score: riskScore({ high, medium, everLogged }), samples: everLogged },
    quality,
  });
  const subScores = Object.fromEntries(Object.entries(r.factors).map(([k, f]) => [k, f.score]));
  // QA3 G-3 / G-5: points and inputs per factor (the screen, the AI text and the "How calculated?" panel all read these).
  const explain = explainFactors(r, { delivery: { doneWithDeadline, onTimeDone }, capacity: { pct: load.pct }, risk: { high, medium }, quality });
  return { ...r, subScores, explain };
}

// Stores one snapshot (the manual button and the weekly job). overall stays null when there is not enough data.
export async function saveSnapshot(orgId, now = new Date()) {
  const h = await computeOrgHealth(orgId, now);
  return OrgHealthSnapshot.create({ orgId, overall: h.overall, subScores: h.subScores, inputs: h.factors, calculatedAt: now });
}
