// QA3 decision 7 (G-20): ONE on-time rule for the report, dashboard, org health, recaps and the leaderboard.
// A deadline is the END of that day in the org time zone; a task finished on or before that moment is on time. Pure.
// A date-only deadline is stored as midnight UTC of the chosen date: that calendar date is the deadline day in every zone.
const DAY = 86_400_000;
const ymd = (d, tz) => new Date(d).toLocaleDateString("en-CA", { timeZone: tz }); // yyyy-mm-dd

function offsetMs(instant, tz) { // zone time minus UTC at that instant
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

// "yyyy-mm-dd" of the deadline day.
function deadlineDay(deadline, tz) {
  const d = new Date(deadline);
  return d.getTime() % DAY === 0 ? d.toISOString().slice(0, 10) : ymd(d, tz);
}

// The instant the deadline day ends in the org zone (the next local midnight).
export function deadlineEnd(deadline, tz = "Asia/Karachi") {
  const [y, m, d] = deadlineDay(deadline, tz).split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d + 1);
  return new Date(guess - offsetMs(guess - offsetMs(guess, tz), tz));
}

// true / false, or null when there is nothing to judge (no deadline or no finish date).
export function isOnTime(deadline, finishedAt, tz = "Asia/Karachi") {
  if (!deadline || !finishedAt) return null;
  return new Date(finishedAt) < deadlineEnd(deadline, tz);
}

// Whole calendar days late in the org zone (0 when on time).
export function lateDays(deadline, finishedAt, tz = "Asia/Karachi") {
  if (isOnTime(deadline, finishedAt, tz) !== false) return 0;
  return Math.round((Date.parse(ymd(finishedAt, tz)) - Date.parse(deadlineDay(deadline, tz))) / DAY);
}

// The same rule as a MongoDB $expr, so counts done in the database agree with isOnTime(). `field` is the finish date field.
export function onTimeExpr(tz = "Asia/Karachi", field = "$completedAt") {
  const dateOnly = { $eq: [{ $mod: [{ $toLong: "$deadline" }, DAY] }, 0] };
  const part = (op) => ({ $cond: [dateOnly, { [op]: "$deadline" }, { [op]: { date: "$deadline", timezone: tz } }] });
  const dayStart = { $dateFromParts: { year: part("$year"), month: part("$month"), day: part("$dayOfMonth"), timezone: tz } };
  return { $lt: [field, { $dateAdd: { startDate: dayStart, unit: "day", amount: 1, timezone: tz } }] };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "21 Oct 2026" in the org zone: the one date text for reports and PDFs (X-1).
export function dayText(d, tz = "Asia/Karachi") {
  if (!d) return "";
  const [y, m, day] = ymd(d, tz).split("-");
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// G-20: delivery rows grouped by project (A to Z), late tasks first inside a project (latest first), then by completion date.
// tasks: [{ title, project, assignee, deadline, completedAt }] → [{ project, title, assignee, completed, onTime, late }]
export function deliveryRows(tasks, tz = "Asia/Karachi") {
  return tasks.map((t) => ({ project: t.project ?? "No project", title: t.title, assignee: t.assignee ?? "—", completedAt: t.completedAt,
      completed: dayText(t.completedAt, tz), onTime: isOnTime(t.deadline, t.completedAt, tz), late: lateDays(t.deadline, t.completedAt, tz) }))
    .sort((a, b) => a.project.localeCompare(b.project) || b.late - a.late || new Date(a.completedAt) - new Date(b.completedAt));
}
