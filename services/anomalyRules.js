// Anomaly rules for Manager Flags (ACHIEVION_AI_EVAL_SPEC.md §5, D-076) — pure, no DB.
// A flag only shows; the Manager dismisses or confirms. Tests: server/tests/anomalyRules.test.mjs.
import { isDisagreement } from "./aiEvalRules.js";

export const Z_LIMIT = 3;
export const MIN_HISTORY = 5;
export const RUBBER_STAMP_MS = 2 * 60_000;
export const BURST_WINDOW_MS = 60 * 60_000;
export const BURST_COUNT = 3;

// z of this task's XP against the user's own past task XP; null when it can't be measured.
export function xpZScore(history, xp) {
  if (!Array.isArray(history) || history.length < MIN_HISTORY) return null;
  const mean = history.reduce((s, v) => s + v, 0) / history.length;
  const sd = Math.sqrt(history.reduce((s, v) => s + (v - mean) ** 2, 0) / history.length);
  return sd > 0 ? (xp - mean) / sd : null;
}
export const isXpOutlier = (history, xp) => { const z = xpZScore(history, xp); return z !== null && Math.abs(z) > Z_LIMIT; };

export const isRubberStamp = ({ stars, submittedAt, approvedAt }) =>
  stars === 5 && !!submittedAt && !!approvedAt && new Date(approvedAt) - new Date(submittedAt) < RUBBER_STAMP_MS;

// approvals: [{ approverId, userId, at }] → [{ approverId, userId, count }] where 3+ fall inside one hour.
export function findBursts(approvals) {
  const groups = new Map();
  for (const a of approvals ?? []) {
    const k = `${a.approverId}|${a.userId}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(+new Date(a.at));
  }
  const out = [];
  for (const [k, times] of groups) {
    times.sort((x, y) => x - y);
    let best = 0;
    for (let i = 0, j = 0; j < times.length; j++) {
      while (times[j] - times[i] >= BURST_WINDOW_MS) i++;
      best = Math.max(best, j - i + 1);
    }
    if (best >= BURST_COUNT) { const [approverId, userId] = k.split("|"); out.push({ approverId, userId, count: best }); }
  }
  return out;
}

export const isAiTlDisagreement = isDisagreement;

// ── M-5: Anomalies screen ────────────────────────────────────────────────────
export const FLAG_KINDS = ["ai_tl_disagreement", "xp_outlier", "rubber_stamp", "burst"];
export const FLAG_LABEL = {
  ai_tl_disagreement: "AI and Team Lead scores differ",
  xp_outlier:         "XP far from this person's usual",
  rubber_stamp:       "Approved very quickly with 5 stars",
  burst:              "Many approvals in one hour",
};

// Plain, neutral sentence for the drawer ("needs review", never blame).
export function flagReason(kind, ev = {}) {
  if (kind === "ai_tl_disagreement") return `The AI scored ${ev.aiScore ?? "?"} and the Team Lead scored ${ev.tlScore ?? "?"} (a gap of ${ev.gap ?? "?"} points). This needs review.`;
  if (kind === "xp_outlier") return `This award (${ev.xp} XP) is ${Math.abs(ev.z ?? 0).toFixed(1)} standard deviations from this person's usual ${ev.mean} XP per task. This needs review.`;
  if (kind === "rubber_stamp") return ev.minutes < 1
    ? "The task got 5 stars within a minute of being submitted. This needs review."
    : `The task got 5 stars ${ev.minutes} minute${ev.minutes === 1 ? "" : "s"} after it was submitted. This needs review.`;
  if (kind === "burst") return `The same reviewer approved ${ev.count} of this person's tasks within one hour. This needs review.`;
  return "This award needs review.";
}

// Flags worth writing for one award (non-blocking caller; never throws on odd input).
export function flagsForAward({ xp, history = [], stars, submittedAt, approvedAt, recentApprovals = [], userId }) {
  const out = [];
  const z = xpZScore(history, xp);
  if (z !== null && Math.abs(z) > Z_LIMIT) {
    const mean = Math.round(history.reduce((s, v) => s + v, 0) / history.length);
    out.push({ kind: "xp_outlier", evidence: { xp, z: Math.round(z * 10) / 10, mean, samples: history.length } });
  }
  if (isRubberStamp({ stars, submittedAt, approvedAt })) {
    out.push({ kind: "rubber_stamp", evidence: { stars, minutes: Math.max(0, Math.round((new Date(approvedAt) - new Date(submittedAt)) / 60_000)) } });
  }
  const burst = findBursts(recentApprovals).find((b) => String(b.userId) === String(userId));
  if (burst) out.push({ kind: "burst", evidence: { count: burst.count, approverId: burst.approverId } });
  return out;
}

// XP reversal for a confirmed flag: one NEGATIVE ledger row per original award; totals never below 0.
// `alreadyReversed` = a reversal row for this award exists → nothing to do (idempotent).
export function reversalPlan({ original, profile, alreadyReversed = false }) {
  if (alreadyReversed || !original || !(original.amount > 0)) return null;
  const gold = Math.max(0, Math.round(original.breakdown?.gold ?? original.gold ?? 0));
  const total = profile?.totalXp ?? 0, monthly = profile?.monthlyXp ?? 0, g = profile?.gold ?? 0;
  return {
    amount: -original.amount,
    goldDelta: -Math.min(gold, g),
    totalXp: Math.max(0, total - original.amount),
    monthlyXp: Math.max(0, monthly - original.amount),
    gold: Math.max(0, g - gold),
  };
}
