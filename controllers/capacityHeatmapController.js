import { orgWorkTime, teamWeeklyCapacity } from "../services/workloadRules.js";
import Organization from "../models/Organization.js";
import Team         from "../models/Team.js";
import Task         from "../models/Task.js";
import User         from "../models/User.js";

const IS_OID   = /^[0-9a-f]{24}$/i;
const orgFilter = (orgId) => IS_OID.test(orgId) ? { _id: orgId } : { orgId };

// ── GET /api/director/capacity-heatmap?weeks=4 ────────────────────────────────
export async function capacityHeatmap(req, res) {
  const { orgId } = req.user;
  const weeks = Math.min(Math.max(parseInt(req.query.weeks ?? "4"), 1), 12);

  const org = await Organization.findOne(orgFilter(orgId), "orgId _id workingTime").lean();
  if (!org) return res.status(404).json({ error: "Org not found" });

  const { hoursPerDay, workingDays } = orgWorkTime(org); // Director Settings → Working Time

  const teams = await Team.find({ orgId, status: { $ne: "archived" } }).select("name members").lean();

  // Build week date ranges (current week = week 0, going back)
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  const dayOfWeek = weekStart.getDay();
  weekStart.setDate(weekStart.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));

  // Forward-looking: current week + next (weeks-1) weeks — capacity planning is a forward view.
  const weekRanges = [];
  for (let w = 0; w < weeks; w++) {
    const start = new Date(weekStart);
    start.setDate(weekStart.getDate() + w * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    const label = `W${String(start.getMonth() + 1).padStart(2,"0")}/${String(start.getDate()).padStart(2,"0")}`;
    weekRanges.push({ start, end, label });
  }

  const rows = await Promise.all(teams.map(async (team) => {
    const cells = await Promise.all(weekRanges.map(async (wr) => {
      const [plannedAgg] = await Task.aggregate([
        {
          $match: {
            orgId,
            teamId: team._id,
            status: { $nin: ["Done"] },
            deadline: { $gte: wr.start, $lte: wr.end },
            estimatedHours: { $gt: 0 },
          },
        },
        { $group: { _id: null, total: { $sum: "$estimatedHours" } } },
      ]);
      const plannedHours = plannedAgg?.total ?? 0;
      // 4.2a: real member count (Team.capacity defaulted to 10 for every team)
      const availableHours = teamWeeklyCapacity({ memberCount: team.members?.length ?? 0, hoursPerDay, workingDays });
      // No members → no capacity: pct is null (not 0 %), so the UI can say "No members" instead of "Healthy".
      const pct = availableHours > 0 ? Math.round((plannedHours / availableHours) * 100) : null;
      return { week: wr.label, plannedHours, availableHours, pct, noMembers: availableHours === 0 };
    }));
    return { teamId: team._id, teamName: team.name, cells };
  }));

  res.json({ weeks: weekRanges.map((w) => w.label), rows });
}
