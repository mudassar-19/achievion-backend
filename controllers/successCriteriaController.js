import SatisfactionSurvey from "../models/SatisfactionSurvey.js";
import AITestCase         from "../models/AITestCase.js";
import PerformanceLog     from "../models/PerformanceLog.js";
import StressTestResult   from "../models/StressTestResult.js";

const PERF_ACTIONS = ["login","dashboard_load","create_task","move_task","submit_task","approve_extension","open_portfolio"];
const SUS_PASS_THRESHOLD = 68;
const PERF_P95_MAX_MS    = 3000;

// ── GET /api/director/success-criteria ───────────────────────────────────────
export async function getSuccessCriteria(req, res) {
  const { orgId } = req.user;

  // 1 ── Satisfaction: ≥ 85% rate 4-5 on enjoyable+easy; SUS avg ≥ 68
  const surveys = await SatisfactionSurvey.find({ orgId }).lean();
  const n = surveys.length;
  const SATISFACTION_MIN_N = 20;
  let satisfaction;
  if (n === 0) {
    satisfaction = { status: "NOT VERIFIED", reason: "No survey data", n: 0 };
  } else if (n < SATISFACTION_MIN_N) {
    satisfaction = { status: "NOT VERIFIED", reason: `Data kam hai (n=${n}, need ≥${SATISFACTION_MIN_N})`, n };
  } else {
    const enjoyPassCount = surveys.filter((s) => s.enjoyableScore >= 4).length;
    const easyPassCount  = surveys.filter((s) => s.easyScore >= 4).length;
    const enjoyPct = Math.round((enjoyPassCount / n) * 100);
    const easyPct  = Math.round((easyPassCount  / n) * 100);
    const susScored = surveys.filter((s) => s.susScore != null);
    const susAvg    = susScored.length > 0
      ? Math.round(susScored.reduce((s, r) => s + r.susScore, 0) / susScored.length)
      : null;
    const bothPct = Math.round(surveys.filter((s) => (s.enjoyableScore ?? 0) >= 4 && (s.easyScore ?? 0) >= 4).length / n * 100);
    const pass = bothPct >= 85 && (susAvg == null || susAvg >= SUS_PASS_THRESHOLD);
    satisfaction = {
      status:   pass ? "VERIFIED" : "NOT VERIFIED",
      n,
      enjoyPct, easyPct, bothPct,
      susAvg,
      target: "≥85% rate 4–5 on both items; SUS avg ≥ 68",
    };
  }

  // 2 ── AI accuracy: ≥ 80% of cases pass, ≥ 30 cases, 2 evaluators each
  const aiCases = await AITestCase.find({ orgId }).lean();
  const aiN = aiCases.length;
  let ai;
  if (aiN === 0) {
    ai = { status: "NOT VERIFIED", reason: "No AI test cases — test set empty", n: 0 };
  } else {
    const passing = aiCases.filter((c) => c.pass && new Set((c.judgedBy ?? []).map(String)).size >= 2).length;
    const pct     = Math.round((passing / aiN) * 100);
    ai = {
      status:  pct >= 80 && aiN >= 30 ? "VERIFIED" : "NOT VERIFIED",
      n: aiN, passing, pct,
      issues: [
        aiN < 30     ? `Need ≥30 cases (have ${aiN})`   : null,
        pct  < 80    ? `Need ≥80% pass (have ${pct}%)`  : null,
      ].filter(Boolean),
      target: "≥80% pass, ≥30 cases, 2 evaluators each",
    };
  }

  // 3 ── Speed: p95 per named action ≤ 3000ms
  const perfRows = await PerformanceLog.find({ orgId }).lean();
  const perAction = {};
  for (const action of PERF_ACTIONS) {
    const rows = perfRows.filter((r) => (r.action ?? r.actionName) === action).map((r) => r.durationMs).sort((a,b) => a-b);
    if (rows.length < 20) { perAction[action] = { status: "NOT VERIFIED", reason: rows.length === 0 ? "No data" : `Need ≥20 logs (have ${rows.length})`, n: rows.length }; continue; }
    const allSeeded = perfRows.filter((r) => (r.action ?? r.actionName) === action).every((r) => r.seeded === true);
    const p95idx = Math.floor(rows.length * 0.95);
    const p95    = rows[Math.min(p95idx, rows.length - 1)];
    if (allSeeded) {
      perAction[action] = { status: "NOT VERIFIED", reason: "Seeded data (D-016)", p95, n: rows.length, limit: PERF_P95_MAX_MS, seeded: true };
      continue;
    }
    perAction[action] = { status: p95 <= PERF_P95_MAX_MS ? "VERIFIED" : "NOT VERIFIED", p95, n: rows.length, limit: PERF_P95_MAX_MS };
  }
  const speedOverall = Object.values(perAction).every((a) => a.status === "VERIFIED") ? "VERIFIED" : "NOT VERIFIED";

  // 4 ── Uptime: latest stress test result
  const latest = await StressTestResult.findOne({ orgId }).sort({ runAt: -1 }).lean();
  const uptime = latest
    ? (latest.durationMinutes != null && latest.durationMinutes < 120)
      ? { status: "NOT VERIFIED", reason: `Run duration ${latest.durationMinutes} min — need ≥120 min (2h)`, uptimePct: latest.uptimePct, runAt: latest.runAt, virtualUsers: latest.virtualUsers, durationMinutes: latest.durationMinutes }
      : { status: latest.passed ? "VERIFIED" : "NOT VERIFIED", uptimePct: latest.uptimePct, runAt: latest.runAt, virtualUsers: latest.virtualUsers, durationMinutes: latest.durationMinutes }
    : { status: "NOT VERIFIED", reason: "No load-test log — run autocannon/k6 and submit result" };

  res.json({ satisfaction, ai, speed: { overall: speedOverall, perAction }, uptime });
}
