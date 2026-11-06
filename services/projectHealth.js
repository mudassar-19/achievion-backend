// Project health, computed when read — never stored (D-077). Tests: server/tests/projectHealth.test.mjs.
// expected% = elapsed / total time; behind = max(0, expected - progress%);
// overdueRatio = overdue / open tasks; health = clamp(100 - behind - 50 * overdueRatio, 0, 100).
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// U-1 (D-134, amends D-077): a project without any task is "Not started" — no score, never red, no health alert.
export function projectHealth({ startDate, deadline, now = new Date(), progressPct = 0, openTasks = 0, overdueTasks = 0, totalTasks }) {
  if (totalTasks === 0) return { score: null, band: "Not started", expectedPct: null, behind: 0, overdueRatio: 0 };
  const s = startDate ? +new Date(startDate) : NaN, e = deadline ? +new Date(deadline) : NaN, t = +new Date(now);
  const expectedPct = Number.isFinite(s) && Number.isFinite(e) && e > s ? clamp(((t - s) / (e - s)) * 100, 0, 100) : null;
  const behind = expectedPct === null ? 0 : Math.max(0, expectedPct - (Number(progressPct) || 0));
  const overdueRatio = openTasks > 0 ? clamp(overdueTasks / openTasks, 0, 1) : 0;
  const score = Math.round(clamp(100 - behind - 50 * overdueRatio, 0, 100));
  return { score, band: healthBand(score), expectedPct: expectedPct === null ? null : Math.round(expectedPct), behind: Math.round(behind), overdueRatio };
}

export const healthBand = (score) => (score >= 70 ? "On track" : score >= 40 ? "At risk" : "Off track");
