// Item 53: Plan suggestion from the estimate and the org's Working Time. Pure. A suggestion only: nothing is saved by the server.
// Tests: server/tests/planSuggestion.test.mjs.
import { workingDaysNeeded, dueDateAfter } from "./workloadRules.js";
import { localDate } from "./streakService.js";
import { MIN_HOURS, MAX_HOURS } from "./taskFormRules.js";

const OPEN = ["Planning", "Active", "Under Review", "Delayed"];
const day = (v) => new Date(v).toISOString().slice(0, 10);

// sprints: [{ id, name, status, startDate, endDate }] of the project. → { hours, start, deadline, workingDays, sprint: {id,name}|null }
export function planSuggestion({ hours, startDate = null, now = new Date(), wt, sprints = [] }) {
  const h = Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.round(Number(hours) || MIN_HOURS)));
  const today = localDate(now, wt.timezone);
  const wanted = startDate && day(startDate) >= today ? day(startDate) : today;
  const start = dueDateAfter(`${wanted}T12:00:00Z`, 1, wt.workingDays, wt.timezone, wt.holidays); // the first working day on or after it
  const workingDays = workingDaysNeeded(h, wt.hoursPerDay);
  const deadline = dueDateAfter(`${start}T12:00:00Z`, workingDays, wt.workingDays, wt.timezone, wt.holidays);
  const fits = sprints.filter((s) => OPEN.includes(s.status) && s.startDate && s.endDate && day(s.startDate) <= deadline && deadline <= day(s.endDate))
    .sort((a, b) => day(a.endDate).localeCompare(day(b.endDate)))[0];
  return { hours: h, start, deadline, workingDays, sprint: fits ? { id: String(fits.id), name: fits.name } : null };
}
