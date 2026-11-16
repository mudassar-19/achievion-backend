// Org Health from the database (item 18, RND-01..08). The formulas are in orgHealthRules.js (pure, tested).
// Delivery reads the same shared project health as the Manager, Team Lead and Director lists (healthForProjects).
import Organization from "../models/Organization.js";
import User from "../models/User.js";
import Task from "../models/Task.js";
import Risk from "../models/Risk.js";
import Team from "../models/Team.js";
import Project from "../models/Project.js";
import OrgHealthSnapshot from "../models/OrgHealthSnapshot.js";
import { healthForProjects } from "./projectHealthService.js";
import { orgWorkTime, teamWeeklyCapacity } from "./workloadRules.js";
import { deliveryScore, capacityScore, riskScore, combineFactors } from "./orgHealthRules.js";
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
  const projects = await Project.find({ director: { $in: dirIds }, status: { $ne: "Deleted" } }, "startDate createdAt deadline").lean();
  const [health, hoursAgg, doneWithDeadline] = await Promise.all([
    healthForProjects(projects, now),
    Task.aggregate([{ $match: { projectId: { $in: projects.map((p) => p._id) } } }, { $group: { _id: "$projectId", h: { $sum: { $ifNull: ["$estimatedHours", 0] } } } }]),
    Task.countDocuments({ orgId: oid, status: "Done", deadline: { $ne: null } }),
  ]);
  const hours = Object.fromEntries(hoursAgg.map((r) => [String(r._id), r.h]));
  const delivery = deliveryScore(projects.map((p) => ({ score: health.get(String(p._id))?.score ?? null, hours: hours[String(p._id)] ?? 0 })));

  // Capacity (RND-04): this week's planned hours (open tasks due this week) over the teams' weekly capacity, as in the heat map.
  const { hoursPerDay, workingDays } = orgWorkTime(org);
  const teams = await Team.find({ orgId: oid, status: { $ne: "archived" } }).select("members").lean();
  const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - (weekStart.getDay() === 0 ? 6 : weekStart.getDay() - 1));
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6); weekEnd.setHours(23, 59, 59, 999);
  const [planned] = await Task.aggregate([
    { $match: { orgId: oid, teamId: { $in: teams.map((t) => t._id) }, status: { $ne: "Done" }, deadline: { $gte: weekStart, $lte: weekEnd }, estimatedHours: { $gt: 0 } } },
    { $group: { _id: null, total: { $sum: "$estimatedHours" } } },
  ]);
  const avail = teams.reduce((s, t) => s + teamWeeklyCapacity({ memberCount: t.members?.length ?? 0, hoursPerDay, workingDays }), 0);
  const withMembers = teams.filter((t) => t.members?.length).length;
  const capacity = avail > 0 ? capacityScore(((planned?.total ?? 0) / avail) * 100) : null;

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
  return { ...r, subScores };
}

// Stores one snapshot (the manual button and the weekly job). overall stays null when there is not enough data.
export async function saveSnapshot(orgId, now = new Date()) {
  const h = await computeOrgHealth(orgId, now);
  return OrgHealthSnapshot.create({ orgId, overall: h.overall, subScores: h.subScores, inputs: h.factors, calculatedAt: now });
}
