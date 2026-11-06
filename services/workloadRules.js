// Workload rules (V1 4.2a) — pure, no DB. Tests: server/tests/workloadRules.test.mjs.
import { HP_BURNOUT } from "./xpEngine.js";

export const DEFAULT_HOURS_PER_DAY = 7;
export const DEFAULT_WORKING_DAYS  = [1, 2, 3, 4, 5]; // 0 = Sun … 6 = Sat

export const WORKLOAD_TIERS = {
  FREE:     { max: 40,  label: "Free",              color: "#10b981" },
  MODERATE: { max: 80,  label: "Moderate Load",     color: "#eab308" },
  HIGH:     { max: 100, label: "Busy",              color: "#f97316" },
  CRITICAL: { max: 999, label: "Critical Overload", color: "#ef4444" },
};

// Director Settings → Working Time (Organization.workingTime). Old docs used `workDays`.
export function orgWorkTime(org) {
  const wt = org?.workingTime ?? {};
  const days = Array.isArray(wt.workingDays) && wt.workingDays.length ? wt.workingDays
    : Array.isArray(wt.workDays) && wt.workDays.length ? wt.workDays : DEFAULT_WORKING_DAYS;
  const hours = Number(wt.hoursPerDay);
  return { hoursPerDay: hours > 0 ? hours : DEFAULT_HOURS_PER_DAY, workingDays: days };
}

export function countWorkingDays(start, end, workingDays = DEFAULT_WORKING_DAYS) {
  let count = 0;
  const cur = new Date(start); cur.setHours(0, 0, 0, 0);
  const e   = new Date(end);   e.setHours(23, 59, 59, 999);
  while (cur <= e) {
    if (workingDays.includes(cur.getDay())) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return Math.max(1, count);
}

export function defaultHoursByDifficulty(difficulty) {
  return { Easy: 1, Medium: 3, Hard: 6, Critical: 10 }[difficulty] ?? 3;
}

// Hours this task adds to one working day: estimate ÷ working days in its window.
export function dailyHoursForTask(task, now = new Date(), workingDays = DEFAULT_WORKING_DAYS) {
  const total = task.estimatedHours ?? defaultHoursByDifficulty(task.difficulty ?? "Medium");
  if (!total || total <= 0) return 0;
  const start = task.startDate ? new Date(task.startDate) : now;
  const end   = task.deadline ?? task.endDate;
  if (!end) return total; // no window → counts as a single day
  return total / Math.max(1, countWorkingDays(start, new Date(end), workingDays));
}

export function utilisationPct(allocatedHours, dailyHours) {
  return dailyHours > 0 ? Math.round((allocatedHours / dailyHours) * 100) : 0;
}

export function workloadTier(utilisation) {
  if (utilisation <= WORKLOAD_TIERS.FREE.max)     return WORKLOAD_TIERS.FREE;
  if (utilisation <= WORKLOAD_TIERS.MODERATE.max) return WORKLOAD_TIERS.MODERATE;
  if (utilisation <= WORKLOAD_TIERS.HIGH.max)     return WORKLOAD_TIERS.HIGH;
  return WORKLOAD_TIERS.CRITICAL;
}

// Manager Availability labels from the same engine tiers. HP below the burnout line = not available.
export function availabilityFor({ workloadTier: tier, hp }) {
  if (tier === WORKLOAD_TIERS.CRITICAL.label || (hp ?? 100) < HP_BURNOUT) return "Overloaded";
  if (tier === WORKLOAD_TIERS.HIGH.label) return "Busy";
  return "Available";
}

// Capacity heatmap: real members × hours/day × working days per week.
export function teamWeeklyCapacity({ memberCount, hoursPerDay, workingDays }) {
  return Math.max(0, memberCount) * hoursPerDay * workingDays.length;
}
