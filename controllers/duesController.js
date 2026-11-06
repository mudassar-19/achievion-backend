import { orgWorkTime } from "../services/workloadRules.js";
/**
 * GET /api/director/dues
 * Returns top 5 projects by soonest deadline (active only) plus the org's
 * working-time config so the frontend can compute business-hours-based time left.
 */
import Project      from "../models/Project.js";
import User         from "../models/User.js";
import Organization from "../models/Organization.js";
import mongoose     from "mongoose";

function orgFilter(orgId) {
  return mongoose.Types.ObjectId.isValid(orgId ?? "") ? { _id: orgId } : { orgId };
}

export async function getDues(req, res) {
  const { orgId } = req.user;

  const [directorIds, org] = await Promise.all([
    User.find({ orgId, role: "Director" }, "_id").lean(),
    Organization.findOne(orgFilter(orgId), "workingTime").lean(),
  ]);
  const dirIds = directorIds.map((d) => d._id);

  const projects = await Project.find({
    director: { $in: dirIds },
    status:   { $nin: ["Completed", "Archived", "Frozen", "Deleted"] },
    deadline: { $ne: null },
  })
    .sort({ deadline: 1 })
    .limit(5)
    .populate("managerId", "name")
    .lean();

  const { hoursPerDay: workingHoursPerDay, workingDays } = orgWorkTime(org); // 4.2a: one reader for Working Time

  res.json({
    workingHoursPerDay,
    workingDays,
    projects: projects.map((p) => ({
      id:        p._id,
      title:     p.title,
      status:    p.status,
      deadline:  p.deadline,
      managerId: p.managerId?._id ?? null,
      manager:   p.managerId?.name ?? null,
    })),
  });
}
