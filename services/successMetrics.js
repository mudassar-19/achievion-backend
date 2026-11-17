// Item 22 (D-537): the Director's Success Metrics, as progress toward each target. Pure: rows in, cards out.
// Targets are the project proposal's "Success Criterion"; what the proposal leaves open (how many users, which actions) is our
// definition and is labelled as such in docs/SUCCESS_METRICS_DATA_PLAN.md. Nothing is invented: no data means "NO DATA".
// Statuses: NO DATA · IN PROGRESS (some data, not enough to decide) · VERIFIED · NOT VERIFIED (enough data and below target).
export const PERF_ACTIONS = ["login", "dashboard_load", "create_task", "move_task", "submit_task", "approve_extension", "open_portfolio"];
export const TARGETS = {
  survey: { minResponses: 20, aim: 30, bothPct: 85, susAvg: 68, source: "Proposal: at least 85% of test users find it enjoyable and easy. Number of users: our plan, 20 to 30." },
  ai: { cases: 30, judges: 2, passPct: 80, source: "Proposal: AI features at least 80% efficiency in controlled tests. Measured as agreement with two human judges (AI evaluation spec)." },
  speed: { p95Ms: 3000, minSamples: 20, source: "Proposal: react within 3 seconds for primary actions. p95 over at least 20 real samples per action." },
  uptime: { pct: 100, minutes: 120, source: "Proposal: 100% uptime for a minimum of 2 consecutive hours during stress testing." },
};

const pct = (a, b) => Math.round((a / b) * 100);

function satisfaction(surveys) {
  const n = surveys.length, T = TARGETS.survey;
  const base = { n, needed: T.minResponses, aim: T.aim, progress: `${n} of ${T.minResponses} responses`, target: T.source };
  if (n === 0) return { ...base, status: "NO DATA" };
  if (n < T.minResponses) return { ...base, status: "IN PROGRESS" };
  const sus = surveys.filter((s) => s.susScore != null);
  const susAvg = sus.length ? Math.round(sus.reduce((a, r) => a + r.susScore, 0) / sus.length) : null;
  const bothPct = pct(surveys.filter((s) => (s.enjoyableScore ?? 0) >= 4 && (s.easyScore ?? 0) >= 4).length, n);
  return { ...base, status: bothPct >= T.bothPct && (susAvg == null || susAvg >= T.susAvg) ? "VERIFIED" : "NOT VERIFIED",
    enjoyPct: pct(surveys.filter((s) => s.enjoyableScore >= 4).length, n), easyPct: pct(surveys.filter((s) => s.easyScore >= 4).length, n), bothPct, susAvg };
}

function ai(cases) {
  const T = TARGETS.ai;
  const judged = cases.filter((c) => new Set((c.judgedBy ?? []).map(String)).size >= T.judges);
  const passing = judged.filter((c) => c.pass).length;
  const base = { cases: cases.length, judged: judged.length, passing, needed: T.cases, progress: `${judged.length} of ${T.cases} test cases judged by ${T.judges} judges`, target: T.source };
  if (judged.length === 0) return { ...base, status: "NO DATA" };
  if (judged.length < T.cases) return { ...base, status: "IN PROGRESS", passPct: pct(passing, judged.length) };
  const passPct = pct(passing, judged.length);
  return { ...base, status: passPct >= T.passPct ? "VERIFIED" : "NOT VERIFIED", passPct };
}

function speed(perfRows) {
  const T = TARGETS.speed, perAction = {};
  for (const action of PERF_ACTIONS) {
    // QA3 G-9: samples taken while the free-tier server was just waking up (coldStart) are shown on their own and do not decide the p95.
    const mine = perfRows.filter((r) => (r.action ?? r.actionName) === action);
    const rows = mine.filter((r) => r.coldStart !== true), cold = mine.filter((r) => r.coldStart === true);
    const p95Of = (list) => { const ms = list.map((r) => r.durationMs).sort((a, b) => a - b); return ms.length ? ms[Math.min(Math.floor(ms.length * 0.95), ms.length - 1)] : null; };
    const n = rows.length, progress = `${Math.min(n, T.minSamples)} of ${T.minSamples} samples`, coldInfo = { coldN: cold.length, coldP95: p95Of(cold) };
    if (n === 0) { perAction[action] = { status: "NO DATA", n, p95: null, progress, ...coldInfo }; continue; }
    if (n < T.minSamples) { perAction[action] = { status: "IN PROGRESS", n, p95: null, progress, ...coldInfo }; continue; }
    const p95 = p95Of(rows);
    if (rows.every((r) => r.seeded === true)) { perAction[action] = { status: "NOT VERIFIED", n, p95, progress, seeded: true, reason: "Seeded sample data, not a real measurement", ...coldInfo }; continue; }
    perAction[action] = { status: p95 <= T.p95Ms ? "VERIFIED" : "NOT VERIFIED", n, p95, progress, ...coldInfo };
  }
  const all = Object.values(perAction);
  const overall = all.every((a) => a.status === "NO DATA") ? "NO DATA" : all.every((a) => a.status === "VERIFIED") ? "VERIFIED"
    : all.every((a) => ["VERIFIED", "NOT VERIFIED"].includes(a.status)) ? "NOT VERIFIED" : "IN PROGRESS";
  return { overall, perAction, limitMs: T.p95Ms, minSamples: T.minSamples, target: T.source };
}

function uptime(stress) {
  const T = TARGETS.uptime;
  if (!stress) return { status: "NO DATA", uptimePct: null, progress: `0 of ${T.minutes} minutes`, target: T.source, targetPct: T.pct, targetMinutes: T.minutes };
  const minutes = stress.durationMinutes ?? 0;
  const status = (stress.uptimePct ?? 0) < T.pct ? "NOT VERIFIED" : minutes < T.minutes ? "IN PROGRESS" : "VERIFIED";
  return { status, uptimePct: stress.uptimePct ?? null, durationMinutes: minutes, runAt: stress.runAt, progress: `${Math.min(minutes, T.minutes)} of ${T.minutes} minutes`,
    target: T.source, targetPct: T.pct, targetMinutes: T.minutes };
}

export const buildSuccessMetrics = ({ surveys, aiCases, perfRows, stress, aiPairs = [] }) =>
  ({ satisfaction: satisfaction(surveys), ai: ai(aiCases), efficiency: aiAgreement(aiPairs), speed: speed(perfRows), uptime: uptime(stress) });

// QA4 D-QA4-13: the proposal's "80% efficiency" = the AI evaluation is acceptable: within 20 points of the Team Lead (or Director) score,
// on at least 30 evaluated cases. Shown on Success Metrics; the Manager profile's old "Efficiency" is now called "Decision speed".
export const EFFICIENCY = { cases: 30, withinPoints: 20, passPct: 80, source: "Proposal: AI features at least 80% efficiency. Measured as the share of AI evaluations within 20 points of the Team Lead's score (RND-06 gap rule) over at least 30 cases." };
export function aiAgreement(pairs = []) {
  const ok = pairs.filter((p) => p.aiScore != null && p.tlScore != null), n = ok.length;
  const base = { n, needed: EFFICIENCY.cases, withinPoints: EFFICIENCY.withinPoints, progress: `${Math.min(n, EFFICIENCY.cases)} of ${EFFICIENCY.cases} evaluated cases`, target: EFFICIENCY.source };
  if (!n) return { ...base, status: "NO DATA", withinPct: null };
  const withinPct = Math.round((ok.filter((p) => Math.abs(p.aiScore - p.tlScore) <= EFFICIENCY.withinPoints).length / n) * 100);
  if (n < EFFICIENCY.cases) return { ...base, status: "IN PROGRESS", withinPct };
  return { ...base, status: withinPct >= EFFICIENCY.passPct ? "VERIFIED" : "NOT VERIFIED", withinPct };
}
