// U-1 (D-133): leaderboard rules (UC-13, FR05-05, D-020, D-025, D-081). Tests: server/tests/u1Rules.test.mjs.
const RANKED = ["Developer", "Designer", "Tester", "Team Lead"];
const base = (role) => String(role ?? "").replace(/^(Senior|Junior) /, "");
// Only roles that earn XP are ranked. Managers and Directors are never ranked (D-025, D-081).
export const isRankable = (role) => RANKED.includes(base(role));

// Competition ranking: ties share a rank, the next rank skips (1, 1, 3). Sorted by value, high first.
export function rankRows(rows, valueOf) {
  const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
  let last = null, rank = 0;
  return sorted.map((r, i) => { const v = valueOf(r); if (v !== last) { rank = i + 1; last = v; } return { ...r, rank }; });
}
export function rankChange(prev, now) {
  if (prev === null || prev === undefined) return { dir: "new", by: 0 };
  if (prev === now) return { dir: "same", by: 0 };
  return prev > now ? { dir: "up", by: prev - now } : { dir: "down", by: now - prev };
}
// Who sees which scope: Director the whole org; Manager the people on their projects; Team Lead their team;
// contributors the company, their team (people on their projects) or one project.
export function scopesFor(viewerRole) {
  if (viewerRole === "Director") return ["company", "project"];
  if (viewerRole === "Manager" || viewerRole === "Team Lead") return ["team", "project"];
  return ["company", "team", "project"];
}
export const MIN_PEOPLE = 2; // UC-13 precondition
