// Item 36 (D-539): where leaderboard XP comes from, and one period for XP and Tasks done. Pure. Tests: tests/leaderboardXp.test.mjs.
// Why "Tasks done 0" next to XP is not a contradiction: XP also comes from challenges, badges, streaks and Director corrections.
const GROUP = {
  task_approved: "Tasks", task_accepted: "Tasks", task_rejected: "Tasks", assigner_bonus: "Tasks",
  quest: "Challenges", handover_share: "Handover share", badge: "Badges", streak_bonus: "Streaks", adjust: "Director adjustment", flag_reversal: "Corrections",
};
export const xpSourceGroup = (source) => GROUP[source] ?? (String(source).startsWith("tl_") ? "Team Lead work" : "Other");

// rows: [{ source, xp }] → [{ label, xp }] biggest first, groups that add up to 0 dropped.
export function groupXpBySource(rows) {
  const sum = new Map();
  for (const r of rows) sum.set(xpSourceGroup(r.source), (sum.get(xpSourceGroup(r.source)) ?? 0) + r.xp);
  return [...sum].filter(([, xp]) => xp !== 0).map(([label, xp]) => ({ label, xp })).sort((a, b) => b.xp - a.xp);
}

// The cut-off both XP and Tasks done use: week = the last 7 days, month = since the 1st, all = no cut-off.
export function periodSince(period, now = new Date()) {
  if (period === "week") return new Date(+now - 7 * 86_400_000);
  if (period === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  return null;
}

// QA3 B-21: the parts shown must add up to the total. XP that was written to the profile without a ledger row shows as its own part.
export function withResidual(parts, total) {
  const gap = total - parts.reduce((a, p) => a + p.xp, 0);
  return gap === 0 ? parts : [...parts, { label: "Earlier XP (not itemised)", xp: gap }];
}
