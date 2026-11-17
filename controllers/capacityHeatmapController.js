import { teamCapacity } from "../services/capacity.js";
import Organization from "../models/Organization.js";

const IS_OID   = /^[0-9a-f]{24}$/i;
const orgFilter = (orgId) => IS_OID.test(orgId) ? { _id: orgId } : { orgId };

// ── GET /api/director/capacity-heatmap?weeks=4 ────────────────────────────────
export async function capacityHeatmap(req, res) {
  const { orgId } = req.user;
  const weeks = Math.min(Math.max(parseInt(req.query.weeks ?? "4"), 1), 12);

  const org = await Organization.findOne(orgFilter(orgId), "orgId _id workingTime").lean();
  if (!org) return res.status(404).json({ error: "Org not found" });

  // G-1: the one shared capacity function (same engine as the Manager's Resources screen).
  res.json(await teamCapacity(org, { weeks }));
}
