// Item 50: a start date (sprint, task, subtask) cannot be before today in the org's timezone. Pure: the clock is passed in.
// `unchangedFrom` = the date the record already has; when the date is the same day, an edit is not re-checked.
import { localDate } from "./streakService.js";

export const PAST_START_MSG = "Start date cannot be in the past.";

export function startInPast(value, now, timezone, { unchangedFrom = null } = {}) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(+d)) return null; // the format check reports it
  const day = d.toISOString().slice(0, 10); // dates arrive as YYYY-MM-DD (UTC midnight), like the form stores them
  if (unchangedFrom && new Date(unchangedFrom).toISOString().slice(0, 10) === day) return null;
  return day < localDate(now, timezone || "Asia/Karachi") ? PAST_START_MSG : null;
}
