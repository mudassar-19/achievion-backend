// Item 8 (D-532): guardrails for a Director's manual XP adjustment. It is a correction or a special case, not a reward. Pure.
// Tests: server/tests/xpAdjustMonthly.test.mjs. (The per-adjustment ±500 and 3-a-day limits stay in the controller / service.)
export const MONTH_MAX_COUNT = 5;
export const MONTH_MAX_XP = 1000; // total, either direction

// monthCount / monthAbsTotal: this employee's adjustments so far this calendar month. amount: the new one.
export function monthlyAdjustError({ monthCount, monthAbsTotal, amount }) {
  if (monthCount >= MONTH_MAX_COUNT) return `At most ${MONTH_MAX_COUNT} XP adjustments per employee per month: a correction, not a reward. Wait for next month.`;
  const left = MONTH_MAX_XP - monthAbsTotal;
  if (Math.abs(amount) > left) return `Adjustments for one employee add up to at most ${MONTH_MAX_XP} XP a month (either direction); ${Math.max(0, left)} XP left this month.`;
  return null;
}

// The anomaly detector flags an adjustment that is an outlier, large (300 or more), or the 3rd or later of the month.
export const shouldFlagAdjust = ({ amount, monthCount, outlier }) => !!outlier || Math.abs(amount) >= 300 || monthCount >= 3;
