// G-1/G-2: ONE capacity function. Heatmap, Team Workload and Org Health all call it, and it reads work the way the
// Manager's Resources screen does (open tasks assigned to the people, spread over the days of their window).
// Pure core (weekHours, weekWindows) is tested in tests/qa3Capacity.test.mjs.
import Team from "../models/Team.js";
import Task from "../models/Task.js";
import { orgWorkTime, teamWeeklyCapacity, defaultHoursByDifficulty } from "./workloadRules.js";
import { weekLabel, cellTier } from "./heatmapRules.js";

export const ACTIVE = ["To-Do", "In-Progress", "In-Review"]; // the same statuses the Manager's workload counts
const DAY = 86_400_000;
const ymd = (d, tz) => new Date(d).toLocaleDateString("en-CA", { timeZone: tz });
const isWork = (day, wt) => wt.workingDays.includes(new Date(`${day}T00:00:00Z`).getUTCDay()) && !wt.holidays.includes(day);

/** Working days (org calendar) between two instants, both days included; 0 when the range is empty. */
export function workDaysBetween(from, to, wt) {
  if (+to < +from) return 0;
  let n = 0;
  for (let c = Date.parse(`${ymd(from, wt.timezone)}T00:00:00Z`), e = Date.parse(`${ymd(to, wt.timezone)}T00:00:00Z`); c <= e; c += DAY) if (isWork(new Date(c).toISOString().slice(0, 10), wt)) n++;
  return n;
}

/** Hours of one open task that fall into [weekStart, weekEnd]: the estimate spread evenly over the working days of its window. */
export function taskHoursInWeek(task, week, wt, now = new Date()) {
  const total = task.estimatedHours ?? defaultHoursByDifficulty(task.difficulty ?? "Medium");
  if (!(total > 0)) return 0;
  const start = new Date(Math.max(+(task.startDate ? new Date(task.startDate) : now), +now));
  const end = task.deadline && +new Date(task.deadline) >= +start ? new Date(task.deadline) : start; // no date or already late: it is today's work
  const windowDays = Math.max(1, workDaysBetween(start, end, wt));
  const lo = new Date(Math.max(+start, +week.start)), hi = new Date(Math.min(+end, +week.end));
  return (total * workDaysBetween(lo, hi, wt)) / windowDays;
}

/** Monday-based week windows starting with the current week. */
export function weekWindows(now, weeks) {
  const s = new Date(now); s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - (s.getDay() === 0 ? 6 : s.getDay() - 1));
  return Array.from({ length: weeks }, (_, w) => {
    const start = new Date(s); start.setDate(s.getDate() + w * 7);
    const end = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
    return { start, end, label: weekLabel(start, end) };
  });
}

// Team.members holds { userId, isActive } objects (the old heatmap passed the objects to the query: that is why it read 0%).
export const memberIds = (team) => (team.members ?? []).filter((m) => m.isActive !== false && m.userId).map((m) => String(m.userId));

/** Rows per team with one cell per week: planned hours, available hours (members x hours x working days), pct and tier. */
export async function teamCapacity(org, { weeks = 4, now = new Date() } = {}) {
  const wt = orgWorkTime(org);
  const teams = await Team.find({ orgId: String(org._id), status: { $ne: "archived" } }).select("name members").lean();
  const ids = [...new Set(teams.flatMap(memberIds))];
  const tasks = ids.length ? await Task.find({ $or: [{ assignee: { $in: ids } }, { assignees: { $in: ids } }], status: { $in: ACTIVE } }, "assignee assignees estimatedHours difficulty startDate deadline").lean() : [];
  const windows = weekWindows(now, weeks);
  const rows = teams.map((team) => {
    const mine = new Set(memberIds(team));
    const mineTasks = tasks.filter((t) => [t.assignee, ...(t.assignees ?? [])].filter(Boolean).some((a) => mine.has(String(a))));
    const cells = windows.map((w) => {
      let planned = 0;
      for (const t of mineTasks) { // each member who owns the task carries it, as on the Manager's Resources screen
        const owners = new Set([t.assignee, ...(t.assignees ?? [])].filter(Boolean).map(String));
        const n = [...owners].filter((o) => mine.has(o)).length;
        planned += n * taskHoursInWeek(t, w, wt, now);
      }
      planned = Math.round(planned * 10) / 10;
      const availableHours = teamWeeklyCapacity({ memberCount: mine.size, hoursPerDay: wt.hoursPerDay, workingDays: wt.workingDays.filter((d, i, a) => a.indexOf(d) === i) });
      const pct = availableHours > 0 ? Math.round((planned / availableHours) * 100) : null;
      return { week: w.label, plannedHours: planned, availableHours, pct, tier: cellTier(pct), noMembers: availableHours === 0, noWork: availableHours > 0 && planned === 0 };
    });
    return { teamId: team._id, teamName: team.name, memberCount: mine.size, cells };
  });
  return { weeks: windows.map((w) => w.label), rows, hoursPerDay: wt.hoursPerDay };
}

/** Org-wide load of the current week (Org Health capacity input). null when no team has members. */
export async function orgWeekLoadPct(org, now = new Date()) {
  const { rows } = await teamCapacity(org, { weeks: 1, now });
  const planned = rows.reduce((s, r) => s + r.cells[0].plannedHours, 0), avail = rows.reduce((s, r) => s + r.cells[0].availableHours, 0);
  return { planned, avail, pct: avail > 0 ? Math.round((planned / avail) * 100) : null, teamsWithMembers: rows.filter((r) => r.memberCount).length };
}
