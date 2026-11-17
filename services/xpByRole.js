// QA2-23: XP total per role. A role that has people but 0 XP still gets a row (0), so the chart shows every role.
export function xpTotalsByRole(members, profiles) {
  const roleOf = new Map(members.map((m) => [String(m._id), m.role ?? "Unknown"]));
  const totals = {};
  for (const role of roleOf.values()) totals[role] = 0;
  for (const p of profiles) { const role = roleOf.get(String(p.userId)) ?? "Unknown"; totals[role] = (totals[role] ?? 0) + (p.currentXp ?? 0); }
  return Object.entries(totals).map(([role, totalXp]) => ({ role, totalXp })).sort((a, b) => b.totalXp - a.totalXp || a.role.localeCompare(b.role));
}
