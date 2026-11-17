// QA4 M-30 / M-31 / M-4: rules behind the Manager's Alerts. Pure. Tests: tests/qa4ManagerAlerts.test.mjs.
import { dayText } from "./onTimeRule.js";

const DAY = 86_400_000;
const ymd = (d, tz) => new Date(d).toLocaleDateString("en-CA", { timeZone: tz });
// Whole CALENDAR days between the due day and today in the org zone (a date-only due value keeps its own calendar date). 0 when not yet overdue.
export function calendarDaysOver(due, now = new Date(), tz = "Asia/Karachi") {
  if (!due) return 0;
  const d = new Date(due), dueDay = d.getTime() % DAY === 0 ? d.toISOString().slice(0, 10) : ymd(d, tz);
  return Math.max(0, Math.round((Date.parse(ymd(now, tz)) - Date.parse(dueDay)) / DAY));
}
// A module whose tasks are all done (or that is marked Completed), or any module of a Completed / Archived / Deleted project, can never be overdue (QA3 C-1).
export const alertableModule = (m, projectStatus) => !["Completed", "Archived", "Deleted"].includes(projectStatus) && m.status !== "Completed" && !(m.total > 0 && m.done === m.total);
export const SEVERITY_RULE = "Critical = overdue by more than 7 calendar days, High = 1 to 7 days.";
export const severityForDays = (days) => (days > 7 ? "Critical" : "High");
export const REVIEW_QUEUE_MIN = 10; // "Review queue backed up" starts at 10 tasks waiting (or any task waiting 3+ days)
export const REVIEW_QUEUE_DAYS = 3;
// People over their limit: only ABOVE the limit (1.0x is full, not over), highest load first. rows: [{ id, utilisation }] in percent.
export const overloadedList = (rows, limitPct) => rows.filter((r) => r.utilisation > limitPct).sort((a, b) => b.utilisation - a.utilisation);
export { dayText };
