// RND-19: Pure helpers for working-day streak logic.

// Get the UTC offset in ms for a given timezone at a specific instant.
// Positive for UTC+ (e.g., Karachi UTC+5 → 18_000_000ms).
function tzOffsetMs(dt, timezone) {
  const fmt = (tz) => new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hour12: false,
  }).formatToParts(dt);
  const toMs = (parts) => {
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  };
  return toMs(fmt(timezone)) - toMs(fmt("UTC"));
}

// Local calendar date as "YYYY-MM-DD" for a UTC Date in the given timezone.
export function localDate(dt, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(dt);
}

// UTC instant at which local calendar date "YYYY-MM-DD" starts in the given timezone.
function dayStartUTC(dateStr, timezone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const midnightUtc = Date.UTC(y, m - 1, d);
  // Midnight in the org timezone = UTC midnight minus the UTC+ offset. The offset is read at noon UTC to get
  // a first guess, then again at the guess, so the DST-change day itself is not an hour off.
  const guess = midnightUtc - tzOffsetMs(new Date(midnightUtc + 12 * 3_600_000), timezone);
  return new Date(midnightUtc - tzOffsetMs(new Date(guess), timezone));
}

// UTC start/end of a local calendar date "YYYY-MM-DD" in the given timezone (a DST day is 23 or 25 h).
export function localDayBoundsUTC(dateStr, timezone) {
  return { start: dayStartUTC(dateStr, timezone), end: dayStartUTC(addDays(dateStr, 1), timezone) };
}

// F-007: a deadline stored as date-only (exactly UTC midnight) means "end of that day" in the org timezone.
export function effectiveDeadline(deadline, timezone) {
  const d = new Date(deadline);
  return d.getTime() % 86_400_000 === 0 ? localDayBoundsUTC(d.toISOString().slice(0, 10), timezone).end : d;
}

// "YYYY-MM-DD" plus n calendar days (pure date arithmetic, no timezone involved).
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// 0 (Sun) – 6 (Sat) of a calendar date string; the weekday of a date does not depend on the timezone.
const weekdayOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay();

// The org's calendar day that `now` falls on: its date, whether it is a working day, and when it started (UTC).
export function streakDayInfo(now, { workingDays, timezone }) {
  const dateStr = localDate(now, timezone);
  return { dateStr, isWorkingDay: workingDays.includes(weekdayOf(dateStr)), dayStart: localDayBoundsUTC(dateStr, timezone).start };
}

// RND-19: the last day that may be judged. The org's local clock must be past 00:05; before that, the
// previous day is still "just ended" and was already judged. Calendar arithmetic, so a 23 h DST day is not skipped.
export function lastJudgeableDate(now, timezone) {
  return addDays(localDate(new Date(now.getTime() - 5 * 60_000), timezone), -1);
}

// Working days (local "YYYY-MM-DD") strictly after fromStr, up to and including toStr.
function workingDaysAfter(fromStr, toStr, workingDays) {
  const result = [];
  for (let day = addDays(fromStr, 1); day <= toStr; day = addDays(day, 1)) {
    if (workingDays.includes(weekdayOf(day))) result.push(day);
  }
  return result;
}

/**
 * Working calendar days (as "YYYY-MM-DD" local strings) strictly after `from`
 * and up to and including `to` in the given timezone.
 * Returns an empty array if from >= to on the same local date.
 */
export function getWorkingDaysInRange(from, to, { workingDays, timezone }) {
  return workingDaysAfter(localDate(from, timezone), localDate(to, timezone), workingDays);
}

/**
 * Pure streak judge for a single working day.
 * profile: { streaks: { daily }, freezeCount, previousDaily, longestDaily }
 * opts:    { hadTask: boolean, useFreeze: boolean }
 * Returns: { newStreak, previousDaily, longestDaily, freezeUsed }
 */
export function judgeStreakDay(profile, { hadTask, useFreeze }) {
  const current = profile.streaks?.daily ?? 0;
  const prevLongest = profile.longestDaily ?? current;
  const prevDaily = profile.previousDaily ?? 0;

  if (hadTask) {
    const newStreak = current + 1;
    return { newStreak, previousDaily: prevDaily, longestDaily: Math.max(prevLongest, newStreak), freezeUsed: false };
  }

  if (useFreeze && (profile.freezeCount ?? 0) > 0) {
    return { newStreak: current, previousDaily: prevDaily, longestDaily: prevLongest, freezeUsed: true };
  }

  // Miss — reset streak, save previousDaily
  return { newStreak: 0, previousDaily: current, longestDaily: prevLongest, freezeUsed: false };
}

/**
 * RND-19: judge every working day after the profile's lastJudgedDate, up to throughDate (the org's local
 * "YYYY-MM-DD"). hadTask(dayStr) answers "approved task that day?". Idempotent: returns null when there is
 * nothing new to write; a cron that missed days catches all of them up in order. No HP is touched.
 */
export async function judgeProfileStreak(profile, { workingDays, timezone, throughDate, hadTask }) {
  const fromStr = profile.lastJudgedDate ? localDate(new Date(profile.lastJudgedDate), timezone) : addDays(throughDate, -1);
  const days = workingDaysAfter(fromStr, throughDate, workingDays);
  if (!days.length && profile.lastJudgedDate) return null;

  let streak = profile.streaks?.daily ?? 0;
  let previousDaily = profile.previousDaily ?? 0;
  let longestDaily = profile.longestDaily ?? streak;
  let freezeCount = profile.freezeCount ?? 0;
  let usedFreeze = false;

  for (const day of days) {
    if (await hadTask(day)) { longestDaily = Math.max(longestDaily, streak); continue; } // the approval already counted inline
    if (streak === 0) continue;
    const r = judgeStreakDay(
      { streaks: { daily: streak }, freezeCount, previousDaily, longestDaily },
      { hadTask: false, useFreeze: freezeCount > 0 }
    );
    streak = r.newStreak; previousDaily = r.previousDaily; longestDaily = r.longestDaily;
    if (r.freezeUsed) { freezeCount--; usedFreeze = true; }
  }
  // local noon of the judged day: an instant whose local date is throughDate in any timezone
  return { streak, previousDaily, longestDaily, freezeCount, usedFreeze, lastJudgedDate: new Date(dayStartUTC(throughDate, timezone).getTime() + 12 * 3_600_000) };
}
