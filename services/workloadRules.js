// Workload rules (V1 4.2a) — pure, no DB. Tests: server/tests/workloadRules.test.mjs.
import { HP_BURNOUT } from "./xpEngine.js";
import { localDate } from "./streakService.js";

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
  return {
    hoursPerDay:  hours > 0 ? hours : DEFAULT_HOURS_PER_DAY,
    workingDays:  days,
    timezone:     wt.timezone ?? "Asia/Karachi", // RND-19/27
    holidays:     readHolidays(wt.holidays),     // F-001: org holidays ("YYYY-MM-DD"), days off like a weekend
  };
}

// F-001: only well-formed, unique "YYYY-MM-DD" dates; anything else is dropped (old or hand-edited data never breaks a calculation).
export function readHolidays(raw) {
  return Array.isArray(raw) ? [...new Set(raw.filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort() : [];
}

// A day (UTC-midnight ms of the org's calendar date) is a working day: its weekday is a working day and it is no holiday.
const isWorkMs = (c, workingDays, holidays) => workingDays.includes(new Date(c).getUTCDay()) && !(holidays.length && holidays.includes(new Date(c).toISOString().slice(0, 10)));

// RND-27: optional timezone param — when provided, day-of-week is computed in org timezone.
// Existing callers that omit timezone continue to use server local time (unchanged behaviour).
function _weekdayOf(dt, timezone) {
  if (!timezone) return dt.getDay();
  const s = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(dt);
  return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(s.slice(0,3));
}

export function countWorkingDays(start, end, workingDays = DEFAULT_WORKING_DAYS, timezone = null, holidays = []) {
  if (timezone) {
    // Count the org's calendar days from the start day to the end day inclusive (time of day does not matter).
    const toUtcDay = (dt) => Date.parse(`${localDate(new Date(dt), timezone)}T00:00:00Z`);
    let n = 0;
    for (let c = toUtcDay(start), e = toUtcDay(end); c <= e; c += 86_400_000) {
      if (isWorkMs(c, workingDays, holidays)) n++;
    }
    return Math.max(1, n);
  }
  let count = 0;
  const cur = new Date(start); if (!timezone) cur.setHours(0, 0, 0, 0);
  const e   = new Date(end);   if (!timezone) e.setHours(23, 59, 59, 999);
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  while (cur <= e) {
    if (workingDays.includes(_weekdayOf(cur, timezone)) && !holidays.includes(ymd(cur))) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return Math.max(1, count);
}

// Item 58: working days from today to a due date, both included, in the org's time zone and working days.
// null without a due date; 0 when the date is past or only days off remain (unlike countWorkingDays, never forced to 1).
export function workingDaysLeft(now, due, { workingDays = DEFAULT_WORKING_DAYS, timezone = "Asia/Karachi", holidays = [] } = {}) {
  if (!due) return null;
  const toDay = (dt) => Date.parse(`${localDate(new Date(dt), timezone)}T00:00:00Z`);
  let n = 0;
  for (let c = toDay(now), e = toDay(due); c <= e; c += 86_400_000) if (isWorkMs(c, workingDays, holidays)) n++;
  return n;
}

// RND-27: days = ceil(hours / hoursPerDay). Hours stay the stored estimate; nothing here rewrites dates.
export function workingDaysNeeded(hours, hoursPerDay) {
  return hours > 0 && hoursPerDay > 0 ? Math.ceil(hours / hoursPerDay) : 0;
}

// RND-27: the n-th working day counted from `start` (start counts as day 1 when it is a working day),
// as an org-calendar date "YYYY-MM-DD". Same day rules as countWorkingDays' timezone branch.
export function dueDateAfter(start, n, workingDays = DEFAULT_WORKING_DAYS, timezone = "Asia/Karachi", holidays = []) {
  if (!workingDays.length) workingDays = DEFAULT_WORKING_DAYS; // never loop forever on an empty week
  let c = Date.parse(`${localDate(new Date(start), timezone)}T00:00:00Z`);
  for (let left = Math.max(1, n); ; c += 86_400_000) {
    if (isWorkMs(c, workingDays, holidays) && --left === 0) break;
  }
  return new Date(c).toISOString().slice(0, 10);
}

export function defaultHoursByDifficulty(difficulty) {
  return { Easy: 1, Medium: 3, Hard: 6, Critical: 10 }[difficulty] ?? 3;
}

// Hours this task adds to one working day: estimate ÷ working days in its window.
export function dailyHoursForTask(task, now = new Date(), workingDays = DEFAULT_WORKING_DAYS, timezone = null, holidays = []) {
  const total = task.estimatedHours ?? defaultHoursByDifficulty(task.difficulty ?? "Medium");
  if (!total || total <= 0) return 0;
  const start = task.startDate ? new Date(task.startDate) : now;
  const end   = task.deadline ?? task.endDate;
  if (!end) return total; // no window → counts as a single day
  return total / Math.max(1, countWorkingDays(start, new Date(end), workingDays, timezone, holidays));
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
