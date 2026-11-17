// QA2-23 + QA3 G-11: XP per role from ALL-TIME XP (the same number as the leaderboard; currentXp is only the part inside the current level).
// A role that has people but 0 XP still gets a row (0). Also: headcount and per-person average, so a bigger team does not just look "better".
export function xpTotalsByRole(members, profiles) {
  const roleOf = new Map(members.map((m) => [String(m._id), m.role ?? "Unknown"]));
  const totals = {}, people = {};
  for (const role of roleOf.values()) { totals[role] = 0; people[role] = (people[role] ?? 0) + 1; }
  for (const p of profiles) { const role = roleOf.get(String(p.userId)) ?? "Unknown"; totals[role] = (totals[role] ?? 0) + (p.totalXp ?? 0); }
  return Object.entries(totals).map(([role, totalXp]) => ({ role, totalXp, people: people[role] ?? 0, avgXp: people[role] ? Math.round(totalXp / people[role]) : 0 }))
    .sort((a, b) => b.totalXp - a.totalXp || a.role.localeCompare(b.role));
}
