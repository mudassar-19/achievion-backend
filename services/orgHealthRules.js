// Org Health rules (master list item 18; RND-01, 04, 05, 06, 07, 08 in docs/rnd/RND_LOCKED.md). Pure: no DB, no clock.
// Tests: server/tests/orgHealthRules.test.mjs.
import { scoreToStars } from "./xpEngine.js";
import { localDate, localDayBoundsUTC } from "./streakService.js";

// Weekly automatic snapshot: due on Monday in the org timezone, once per Monday (the hourly job asks this every hour).
export function snapshotDue(now, timezone, lastSnapshotAt) {
  const today = localDate(now, timezone);
  if (new Date(`${today}T00:00:00Z`).getUTCDay() !== 1) return false;
  return !lastSnapshotAt || new Date(lastSnapshotAt) < localDayBoundsUTC(today, timezone).start;
}

// RND-07: default weights, shown on screen as "Default weights" (our design choice, sensitivity in ORG_HEALTH_RND.md 2.1).
export const WEIGHTS = { delivery: 35, capacity: 25, risk: 20, quality: 20 };
// RND-08: minimum samples per factor (our rule, [U]) and the number of factors needed for an overall number.
export const MIN_SAMPLES = { delivery: 5, quality: 5, risk: 1, capacity: 1 };
export const MIN_FACTORS = 3;

const lerp = (x, x0, x1, y0, y1) => y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);

// RND-01: hours-weighted mean of project health scores. projects: [{ score|null, hours }]; "Not started" (score null) is left out.
export function deliveryScore(projects = []) {
  const live = projects.filter((p) => p.score != null);
  if (!live.length) return null;
  const hours = live.reduce((s, p) => s + Math.max(0, p.hours || 0), 0);
  if (hours === 0) return Math.round(live.reduce((s, p) => s + p.score, 0) / live.length); // no estimates: plain mean
  return Math.round(live.reduce((s, p) => s + p.score * Math.max(0, p.hours || 0), 0) / hours);
}

// RND-04: utilisation % (planned / available hours in the same week as the heat map) → score.
// 70 when idle, 100 on the plateau 40-90 %, 50 at 110 %, 0 from 150 %.
export function capacityScore(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const p = Math.max(0, pct);
  const s = p < 40 ? lerp(p, 0, 40, 70, 100) : p <= 90 ? 100 : p <= 110 ? lerp(p, 90, 110, 100, 50) : p < 150 ? lerp(p, 110, 150, 50, 0) : 0;
  return Math.round(s);
}

// RND-05: open high risks (score >= 15) and medium (8-14). "No data" (null) when no risk was ever logged.
export function riskScore({ high = 0, medium = 0, everLogged = 0 }) {
  if (!everLogged) return null;
  return 100 - Math.min(100, 8 * high + 2 * medium);
}

// RND-06: final Team Lead scores (0-100) → mean stars → (stars - 1) / 4 x 100. The AI score is not mixed in (D-063).
export function qualityScore(tlScores = []) {
  const stars = tlScores.map(scoreToStars).filter((s) => s != null);
  if (!stars.length) return null;
  return Math.round(((stars.reduce((a, b) => a + b, 0) / stars.length - 1) / 4) * 100);
}

// RND-08: a factor counts only with its minimum sample; the overall number needs 3 of 4 (weights of present factors re-normalised).
// input: { delivery|capacity|risk|quality: { score, samples } } → { overall, status, factors: { key: { score, samples, enough } }, weights }
export function combineFactors(input, weights = WEIGHTS) {
  const factors = {};
  let sum = 0, wsum = 0, present = 0;
  for (const k of Object.keys(weights)) {
    const { score = null, samples = 0 } = input[k] ?? {};
    const enough = score != null && samples >= MIN_SAMPLES[k];
    factors[k] = { score, samples, enough };
    if (enough) { sum += score * weights[k]; wsum += weights[k]; present++; }
  }
  const ok = present >= MIN_FACTORS;
  return { overall: ok ? Math.round(sum / wsum) : null, status: ok ? "ok" : "not_enough_data", factors, weights, present };
}
