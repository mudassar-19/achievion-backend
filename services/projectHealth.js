// Project health, computed when read — never stored (D-077). Tests: server/tests/projectHealth.test.mjs.
// expected% = elapsed / total time; behind = max(0, expected - progress%);
// overdueRatio = overdue / open tasks; health = clamp(100 - behind - 50 * overdueRatio, 0, 100).
import { projectBand } from "./healthScale.js";
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// U-1 (D-134, amends D-077): a project without any task is "Not started" — no score, never red, no health alert.
export function projectHealth({ startDate, deadline, now = new Date(), progressPct = 0, openTasks = 0, overdueTasks = 0, totalTasks }) {
  if (totalTasks === 0) return { score: null, band: "Not started", expectedPct: null, behind: 0, overdueRatio: 0 };
  const s = startDate ? +new Date(startDate) : NaN, e = deadline ? +new Date(deadline) : NaN, t = +new Date(now);
  const expectedPct = Number.isFinite(s) && Number.isFinite(e) && e > s ? clamp(((t - s) / (e - s)) * 100, 0, 100) : null;
  const behind = expectedPct === null ? 0 : Math.max(0, expectedPct - (Number(progressPct) || 0));
  const overdueRatio = openTasks > 0 ? clamp(overdueTasks / openTasks, 0, 1) : 0;
  let score = Math.round(clamp(100 - behind - 50 * overdueRatio, 0, 100));
  // C-3: past the deadline with work still open can never read "On track" (96% done and 3 days late is At risk, not green).
  const daysPast = Number.isFinite(e) && openTasks > 0 && t > e + 86_400_000 ? Math.floor((t - e) / 86_400_000) : 0;
  if (daysPast > 0) score = Math.min(score, 60);
  return { score, band: healthBand(score), expectedPct: expectedPct === null ? null : Math.round(expectedPct), behind: Math.round(behind), overdueRatio, daysPastDeadline: daysPast };
}

export const healthBand = projectBand; // QA4 D-QA4-11: the one health scale (healthScale.js)
