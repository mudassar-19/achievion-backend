// Org Health rules (master list item 18; RND-01, 04, 05, 06, 07, 08 in docs/rnd/RND_LOCKED.md). Pure: no DB, no clock.
// Tests: server/tests/orgHealthRules.test.mjs.
import { scoreToStars } from "./xpEngine.js";
import { healthBand } from "./healthScale.js";
import { localDate, localDayBoundsUTC } from "./streakService.js";

// Weekly automatic snapshot: due on Monday in the org timezone, once per Monday (the hourly job asks this every hour).
export function snapshotDue(now, timezone, lastSnapshotAt) {
  const today = localDate(now, timezone), weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  if (weekday === 1) return !lastSnapshotAt || new Date(lastSnapshotAt) < localDayBoundsUTC(today, timezone).start;
  // QA3 G-6 catch-up: the free-tier server sleeps. If it slept all Monday, the first check after it wakes takes this week's snapshot (an org with none yet waits for its first Monday).
  if (!lastSnapshotAt) return false;
  const monday = new Date(Date.parse(`${today}T00:00:00Z`) - ((weekday + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
  return new Date(lastSnapshotAt) < localDayBoundsUTC(monday, timezone).start;
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

// QA3 G-5: the bands, written down (the colours on screen follow them).
export const bandOf = healthBand; // QA4 D-QA4-11: the one health scale (75 / 60), see healthScale.js

const LABELS = { delivery: "Delivery", capacity: "Capacity", risk: "Risk control (higher is safer)", quality: "Quality" };
const n = (v, one, many) => `${v} ${v === 1 ? one : many}`;
// QA3 G-3 / G-5: what each factor is, its weight among the factors that count, the points it adds, its band and the inputs behind the score.
// result: combineFactors() output; d: { delivery: { doneWithDeadline, onTimeDone }, capacity: { pct }, risk: { high, medium }, quality: { samples } }
export function explainFactors(result, d = {}) {
  const wsum = Object.keys(result.weights).reduce((s, k) => s + (result.factors[k].enough ? result.weights[k] : 0), 0);
  return Object.keys(result.weights).map((key) => {
    const f = result.factors[key], weightPct = f.enough && wsum ? Math.round((result.weights[key] / wsum) * 100) : 0;
    const points = f.enough && wsum ? Math.round(((f.score * result.weights[key]) / wsum) * 10) / 10 : 0;
    let input;
    if (key === "delivery") input = f.enough ? `Average health of the projects, weighted by planned hours. ${d.delivery ? `${d.delivery.onTimeDone} of ${d.delivery.doneWithDeadline} finished tasks were on time.` : ""}`.trim() : `Not enough finished tasks with a deadline yet (${f.samples}, need ${MIN_SAMPLES.delivery}).`;
    else if (key === "capacity") input = f.enough ? `Planned work this week is ${d.capacity?.pct ?? "?"}% of the available hours. Up to 90% is full marks, above 110% it drops.` : "No team has members with planned hours yet.";
    else if (key === "risk") input = f.enough ? `${n(d.risk?.high ?? 0, "high risk", "high risks")} and ${n(d.risk?.medium ?? 0, "medium risk", "medium risks")} are open. A higher score means fewer open risks.` : "No risk has been logged yet.";
    else input = f.enough ? `Average Team Lead review score of ${n(f.samples, "task", "tasks")} finished in the last 30 days.` : `Not enough reviewed tasks yet (${f.samples}, need ${MIN_SAMPLES.quality}).`;
    return { key, label: LABELS[key], score: f.score, enough: f.enough, samples: f.samples, weightPct, points, band: bandOf(f.enough ? f.score : null), input };
  });
}
