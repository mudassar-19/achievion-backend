// Notification tier by type (items 32, 34). Old records stored `tier: "fyi"` for approval requests (the schema default), so the type
// decides for the types listed here and the stored tier decides for the rest. Pure. Tests: server/tests/notifTier.test.mjs.
export const TIER_FROM_TYPE = {
  escalation: "critical", org_health_drop: "critical", system_incident: "critical",
  approval_pending: "needs_action", approval_required: "needs_action", project_at_risk: "needs_action",
};
export const TIERS = ["critical", "needs_action", "fyi"];
const KNOWN = Object.keys(TIER_FROM_TYPE);

export const tierOf = (n) => TIER_FROM_TYPE[n.type] ?? n.tier ?? "fyi";

// Mongo filter for "this tier", or null for an unknown tier name.
export function tierFilter(tier) {
  if (!TIERS.includes(tier)) return null;
  return { $or: [{ type: { $in: KNOWN.filter((t) => TIER_FROM_TYPE[t] === tier) } }, { type: { $nin: KNOWN }, tier }] };
}

// rows from an aggregate grouped by { type, tier }: [{ _id: { type, tier }, n }] → unread totals per tier.
export function countByTier(rows) {
  const out = { total: 0, critical: 0, needs_action: 0, fyi: 0 };
  for (const r of rows) { out[tierOf(r._id)] += r.n; out.total += r.n; }
  return out;
}
