// Capacity Heatmap pure rules (QA2 item 20). One tier set everywhere: the workload engine's (Free <= 40, Moderate <= 80, Busy <= 100, Critical > 100).
import { workloadTier } from "./workloadRules.js";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "Nov 9-15", or "Nov 30-Dec 6" across a month end.
export function weekLabel(start, end) {
  const sameMonth = start.getMonth() === end.getMonth();
  return `${MON[start.getMonth()]} ${start.getDate()}–${sameMonth ? "" : `${MON[end.getMonth()]} `}${end.getDate()}`;
}

// Tasks that count for a team: those tagged with the team, or assigned to one of its members (Task.teamId is rarely set,
// which is why the heatmap was empty before).
export const teamTaskFilter = (team) => ({ $or: [{ teamId: team._id }, { assignees: { $in: team.members ?? [] } }] });

// pct → tier label from the shared engine; null when there is no capacity to compare with.
export const cellTier = (pct) => (pct == null ? null : workloadTier(pct).label);

// Rebalance basis from the heatmap rows: a team's load is its busiest week. Over = Critical (> 100 %), under = Free or Moderate (<= 80 %).
// The AI is asked only when at least one team is over AND at least one is under; otherwise there is nothing to move and nothing is asked.
export function rebalanceBasis(data) {
  const peak = (Array.isArray(data?.rows) ? data.rows : []).map((r) => ({ name: String(r?.teamName ?? "").slice(0, 80), load: Math.max(-1, ...(Array.isArray(r?.cells) ? r.cells : []).map((c) => (Number.isFinite(c?.pct) ? c.pct : -1))) })).filter((t) => t.name && t.load >= 0);
  const over = peak.filter((t) => t.load > 100), under = peak.filter((t) => t.load <= 80);
  if (!peak.length) return { ok: false, reason: "There is no capacity data yet, so there is nothing to rebalance." };
  if (!over.length) return { ok: false, reason: "No team is over capacity, so nothing needs to move." };
  if (!under.length) return { ok: false, reason: "Every team is busy, so there is nobody with spare capacity to take work." };
  return { ok: true, teams: [...over, ...under] };
}
