// Pure XP engine — no DB, no I/O. Rules: docs/design/CURRENT_RULES.md + D-056/057/058/064/066.
// Unit tests: server/tests/xpEngine.test.mjs (cd server && node --test).

export const PRIORITY_BASE_XP = { Critical: 100, High: 75, Medium: 50, Low: 25 }; // D-066 fallback
export const XP_VALUE_MIN = 10;
export const XP_VALUE_MAX = 1000;

export const ON_TIME_BONUS_PCT   = 0.20;
export const EARLY_BONUS_PCT     = 0.10; // on time and >= 24 h before deadline
export const EARLY_HOURS         = 24;
export const LATE_XP_PENALTY_PCT = 0.15; // D-056: every late task
export const LATE_HP_PENALTY     = 5;
export const DEFAULT_STREAK_BONUS = 1.1; // 1.11a: multiplier, not +5
export const QUALITY_MULTIPLIER  = { 1: 0.70, 2: 0.85, 3: 1.00, 4: 1.15, 5: 1.30 };
export const GOLD_PER_XP         = 0.5;  // 1.11f
export const HP_BURNOUT          = 30;   // 1.11e / 1.11g: one threshold everywhere
export const LEVEL_STEP_XP       = 1000; // D-058: level L → L+1 costs L × 1000

const clampStars = (s) => Math.min(5, Math.max(1, Math.round(Number(s) || 3)));

export function defaultXpValue(priority) {
  return PRIORITY_BASE_XP[priority] ?? PRIORITY_BASE_XP.Medium;
}

// isLate comes from the first submission (D-057); deadline/submittedAt only decide the early bonus.
export function calculateTaskXP({ task, submittedAt, isLate = false, qualityStars = 3, streakDays = 0, orgRules = null }) {
  const xpv  = Number(task?.xpValue);
  const base = Number.isFinite(xpv) && xpv > 0 ? xpv : defaultXpValue(task?.priority);

  const typeMult = Number((orgRules?.xpMultipliers ?? {})[task?.type] ?? 1) || 0;

  let timeMult = 1.0;
  if (!isLate) {
    timeMult += ON_TIME_BONUS_PCT;
    const deadline = task?.deadline ? new Date(task.deadline) : null;
    if (deadline && submittedAt && (deadline - new Date(submittedAt)) / 3_600_000 >= EARLY_HOURS) {
      timeMult += EARLY_BONUS_PCT;
    }
  }

  const stars      = clampStars(qualityStars);
  const qualMult   = QUALITY_MULTIPLIER[stars];
  const streakMult = streakDays > 0 ? Number(orgRules?.streakBonus ?? DEFAULT_STREAK_BONUS) || 1 : 1;
  const lateMult   = isLate ? 1 - LATE_XP_PENALTY_PCT : 1;

  const finalXP = Math.max(0, Math.round(base * typeMult * timeMult * qualMult * streakMult * lateMult));
  return {
    base, typeMult, timeMult, qualMult, streakMult, lateMult, stars,
    finalXP,
    gold:    Math.floor(finalXP * GOLD_PER_XP),
    // 1.6: if the missed deadline was already charged by the daily job, don't charge HP twice
    hpDelta: isLate && !task?.overduePenaltyAt ? -LATE_HP_PENALTY : 0,
    isLate,
  };
}

// D-058: total XP to reach level L = 500 × L × (L − 1). No cap.
export function levelFromTotalXp(totalXp) {
  const t = Math.max(0, Number(totalXp) || 0);
  let level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * t) / LEVEL_STEP_XP)) / 2));
  const startOf = (l) => (LEVEL_STEP_XP / 2) * l * (l - 1);
  while (startOf(level + 1) <= t) level++;          // float guard
  while (level > 1 && startOf(level) > t) level--;
  return { level, currentXp: t - startOf(level), maxXp: level * LEVEL_STEP_XP };
}

// D-064: AI 0-100 → 1-5 stars.
export function scoreToStars(score) {
  if (score === null || score === undefined || score === "" || !Number.isFinite(Number(score))) return null;
  return Math.min(5, Math.max(1, Math.round(Number(score) / 20)));
}

// D-057: the first submission fixes lateness; later resubmissions keep it.
export function lateAtSubmission(task, now = new Date()) {
  if (task?.firstSubmittedAt) return { firstSubmittedAt: task.firstSubmittedAt, isLate: Boolean(task.isLate) };
  const deadline = task?.deadline ? new Date(task.deadline) : null;
  return { firstSubmittedAt: now, isLate: deadline ? now > deadline : false };
}

// 1.11b: the midnight cron judges the day that just ended. Mon-Fri only.
export function streakWindow(now = new Date(), workingDays = [1, 2, 3, 4, 5]) {
  const end   = new Date(now); end.setHours(0, 0, 0, 0);
  const start = new Date(end); start.setDate(end.getDate() - 1);
  return { start, end, isWorkingDay: workingDays.includes(start.getDay()) };
}

// 1.11e: notify once, when HP drops below the threshold.
export function crossedBurnout(prevHp, nextHp) {
  return prevHp >= HP_BURNOUT && nextHp < HP_BURNOUT;
}

// ── Deadline jobs (V1 1.5, 1.6) ───────────────────────────────────────────────
export const DEADLINE_ALERT_HOURS = 24;
export const MISSED_DEADLINE_HP   = 5;
const OPEN = ["Backlog", "To-Do", "In-Progress"]; // not yet submitted

export function deadlineAlertDue(task, now = new Date()) {
  if (!task?.deadline || task.deadlineAlertSentAt || !OPEN.includes(task.status)) return false;
  const left = new Date(task.deadline) - now;
  return left > 0 && left <= DEADLINE_ALERT_HOURS * 3_600_000;
}

export function missedDeadlinePenalty(task, now = new Date()) {
  return Boolean(task?.deadline) && !task.overduePenaltyAt && OPEN.includes(task.status) && new Date(task.deadline) <= now;
}

// D-155 (FR03-07): assignees get the alert; the Team Lead hears too, once, also when nobody is assigned yet.
export function deadlineAudience(task, leadIds = []) {
  const assignees = [...new Set([...(task.assignees ?? []), ...(task.assignee ? [task.assignee] : [])].map(String))];
  return { assignees, leads: [...new Set(leadIds.map(String))].filter((id) => !assignees.includes(id)) };
}

// ── Team Lead review XP (T-6, D-148, D-020). Pure. The single award path is tlGamificationService.awardTLReviewXp. ──
export const TL_REVIEW_XP = 40;
const RUBBER_STAMP_WINDOW_MS = 2 * 60_000; // same window as anomalyRules.RUBBER_STAMP_MS
// No XP for a rubber-stamp (5 stars inside 2 minutes) or a conditional approval (QA was skipped).
export function tlReviewAward({ stars, submittedAt, approvedAt, conditional = false }) {
  if (conditional) return { xp: 0, reason: "conditional" };
  if (stars === 5 && submittedAt && approvedAt && new Date(approvedAt) - new Date(submittedAt) < RUBBER_STAMP_WINDOW_MS) return { xp: 0, reason: "rubber_stamp" };
  return { xp: TL_REVIEW_XP, reason: null };
}


// E-4b (D-195): what one awardXp call adds, as one atomic $inc. The month moves with the total (it was left out before,
// the same bug D-148 fixed in awardTLXp); a negative amount never pays gold.
export const xpIncrement = (amount, gold) => ({ totalXp: amount, monthlyXp: amount, gold: amount > 0 ? gold : 0 });
