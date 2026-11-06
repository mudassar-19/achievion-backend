// Manager Reports rules (V2 Phase 3 · M-6). Pure: no DB, no clock unless passed in.
// Speed / punctuality reuse the sprint-summary functions (D-092), so a sprint report and its
// summary always agree. AI quality counts only tasks the Team Lead also scored (D-075).
import { velocity, onTimePct, sprintSummary } from "./sprintRules.js";
import { hpTier } from "./resourceRules.js";

const DAY = 86_400_000;
const OID = /^[0-9a-f]{24}$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const RANGES = ["7d", "30d", "month", "custom"];
export const MAX_CUSTOM_DAYS = 366;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const utcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const oid = (v) => (OID.test(String(v ?? "")) ? String(v) : null);

// Filters from the URL. The previous period is the same length, right before `from`.
export function parseReportQuery(q = {}, now = new Date()) {
  const errors = {};
  const range = RANGES.includes(q.range) ? q.range : "30d";
  let from, to = now;
  if (range === "7d") from = new Date(+now - 7 * DAY);
  else if (range === "30d") from = new Date(+now - 30 * DAY);
  else if (range === "month") from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  else {
    const f = YMD.test(String(q.from ?? "")) ? new Date(`${q.from}T00:00:00.000Z`) : null;
    const t = q.to ? (YMD.test(String(q.to)) ? new Date(`${q.to}T23:59:59.999Z`) : null) : now;
    if (!f || Number.isNaN(+f)) errors.from = "Pick a start date.";
    if (!t || Number.isNaN(+t)) errors.to = "Pick an end date.";
    else if (f && t < f) errors.to = "The end date must be on or after the start date.";
    else if (f && (+t - +f) / DAY > MAX_CUSTOM_DAYS) errors.to = `Pick at most ${MAX_CUSTOM_DAYS} days.`;
    from = f ?? new Date(+now - 30 * DAY); to = t ?? now;
  }
  const project = oid(q.project);
  return {
    errors,
    value: {
      range, from, to, prevFrom: new Date(+from - (+to - +from)), prevTo: from,
      project, sprint: project ? oid(q.sprint) : null, member: oid(q.member),
      bucket: q.bucket === "month" ? "month" : "week",
    },
  };
}

const inRange = (at, { from, to }) => at && new Date(at) >= from && new Date(at) <= to;
export const doneIn = (tasks, r) => tasks.filter((t) => t.status === "Done" && inRange(t.completedAt, r));
const avg = (xs, digits = 0) => (xs.length ? +((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(digits)) : null);

// Speed, punctuality and quality of the tasks finished inside the range.
export function deliveryNumbers(tasks, r) {
  const done = doneIn(tasks, r);
  const scored = done.filter((t) => t.tlScore != null);
  const ai = scored.filter((t) => t.aiScore != null);
  return {
    tasksDone: done.length,
    velocity: velocity(done),
    onTimePct: onTimePct(done),
    avgTlScore: avg(scored.map((t) => t.tlScore)),
    avgStars: avg(done.filter((t) => t.qualityScore != null).map((t) => t.qualityScore), 1),
    scored: scored.length,
    avgAiScore: avg(ai.map((t) => t.aiScore)),
    aiCompared: ai.length,
    rework: done.reduce((a, t) => a + reworkCount(t), 0), // T-5: Team Lead Performance shows it
  };
}

export function compare(cur, prev) {
  return Object.fromEntries(Object.keys(cur).map((k) => [k, cur[k] == null || prev?.[k] == null ? null : +(cur[k] - prev[k]).toFixed(1)]));
}

// Days up to 31 days, else weeks starting Monday; unit "week" / "month" forces it.
export function timeBuckets(from, to, unit) {
  const u = unit ?? ((+to - +from) / DAY <= 31 ? "day" : "week");
  const out = [];
  let s = utcDay(from);
  if (u === "week") s = new Date(+s - ((s.getUTCDay() + 6) % 7) * DAY);
  if (u === "month") s = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (s <= to && out.length < 400) {
    const e = u === "month" ? new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1)) : new Date(+s + (u === "week" ? 7 : 1) * DAY);
    out.push({ start: s, end: e, label: u === "month" ? `${MONTHS[s.getUTCMonth()]} ${s.getUTCFullYear()}` : `${MONTHS[s.getUTCMonth()]} ${s.getUTCDate()}` });
    s = e;
  }
  return out;
}

export function series(items, dateOf, valueOf, buckets) {
  const out = buckets.map((b) => ({ label: b.label, start: b.start, value: 0 }));
  for (const it of items) {
    const at = +new Date(dateOf(it));
    const i = buckets.findIndex((b) => at >= +b.start && at < +b.end);
    if (i >= 0) out[i].value += valueOf(it);
  }
  return out;
}

// Times the work went back from review. Both review paths (/review, /tl-review) log In-Review → In-Progress.
export const reworkCount = (t) => (t.activity ?? []).filter((a) => a.kind === "status" && a.from === "In-Review" && a.to === "In-Progress").length;

const ids = (t) => [...new Set([...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].map((p) => String(p?._id ?? p)))];

// One row per member: delivery numbers only (no HP, no personal details).
export function peopleRows(tasks, users, xpByUser, r) {
  const done = doneIn(tasks, r);
  return users.map((u) => {
    const id = String(u._id);
    const mine = done.filter((t) => ids(t).includes(id));
    return {
      id, name: u.name, role: u.role,
      tasksDone: mine.length,
      onTimePct: onTimePct(mine),
      avgScore: avg(mine.filter((t) => t.tlScore != null).map((t) => t.tlScore)),
      rework: mine.reduce((a, t) => a + reworkCount(t), 0),
      xp: xpByUser[id] ?? 0,
    };
  });
}

// Empty values always sort last.
export function sortRows(rows, key, dir = "desc") {
  const m = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * m;
  });
}

export const netXp = (logs) => logs.reduce((a, l) => a + (l.amount ?? 0), 0);

// Team aggregate only. "Low" HP shows as "needs a lighter load".
export function wellbeing(profiles) {
  const tiers = { Healthy: 0, Tired: 0, Low: 0 };
  for (const p of profiles) tiers[hpTier(p.hp ?? 100)]++;
  const streaks = profiles.map((p) => p.streaks?.daily ?? 0);
  return {
    members: profiles.length, tiers, lighterLoad: tiers.Low,
    avgHp: avg(profiles.map((p) => p.hp ?? 100)),
    activeStreaks: streaks.filter((s) => s > 0).length,
    avgStreak: avg(streaks, 1),
  };
}

// Data-driven facts for Lessons learned (no AI). Late = the sprint-summary delay rule.
export function autoFacts({ tasks = [], flags = 0, overloadEvents = 0, extensions = 0, now = new Date() }) {
  return {
    tasks: tasks.length,
    done: tasks.filter((t) => t.status === "Done").length,
    lateTasks: sprintSummary(tasks, { now }).delays.length,
    rejectedInReview: tasks.reduce((a, t) => a + reworkCount(t), 0),
    overloadEvents, anomalies: flags, extensions,
  };
}

const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
export const factsText = (f) =>
  `Facts at close: ${f.done} of ${f.tasks} tasks done, ${n(f.lateTasks, "late task")}, ${f.rejectedInReview} sent back from review, `
  + `${n(f.overloadEvents, "overload alert")}, ${n(f.anomalies, "anomaly flag")}, ${n(f.extensions, "deadline extension")}.`;

export function validateLesson(body = {}) {
  const text = String(body.text ?? "").trim();
  if (text.length < 3) return { error: "Write at least a few words." };
  if (text.length > 2000) return { error: "Keep the note under 2000 characters." };
  return { value: { text } };
}

// ── Export (PDF and CSV are drawn from the same tables) ──────────────────────
const v = (x, suffix = "") => (x == null ? "—" : `${x}${suffix}`);
const signed = (x, suffix = "") => (x == null ? "—" : `${x > 0 ? "+" : ""}${x}${suffix}`);
const TITLES = { delivery: "Delivery report", people: "People report", xp: "XP trend report", wellbeing: "Well-being report", lessons: "Lessons learned", activity: "Team activity", sprints: "Sprint health" };
const MEASURES = [["tasksDone", "Tasks done", ""], ["velocity", "Velocity (XP of done tasks)", ""], ["onTimePct", "On time", "%"],
  ["avgTlScore", "Average Team Lead score", ""], ["avgStars", "Average stars", ""], ["avgAiScore", "Average AI score (where the Team Lead scored)", ""]];

// ── Team Lead Performance (T-5, D-144) ──────────────────────────────────────
export const ACTIVITY_KINDS = ["status", "submitted", "reviewed", "comment", "edited", "time", "extension", "escalated", "created"];
const FEED_MAX = 100;
const feedText = (a) => (a.from || a.to ? `${a.from ?? "New"} to ${a.to ?? "?"}${a.note ? `: ${a.note}` : ""}` : a.note ?? "");
// tasks: [{ _id, title, activity: [...] }] → newest first, inside the period.
export function activityFeed(tasks, { from, to, kind, names = {} }) {
  const only = ACTIVITY_KINDS.includes(kind) ? kind : null;
  const items = tasks.flatMap((t) => (t.activity ?? []).filter((a) => inRange(a.at, { from, to }) && (!only || a.kind === only))
    .map((a) => ({ taskId: t._id, task: t.title, kind: a.kind, at: a.at, who: names[String(a.by)] ?? "Someone", text: feedText(a) })))
    .sort((a, b) => +new Date(b.at) - +new Date(a.at));
  return { total: items.length, items: items.slice(0, FEED_MAX) };
}
// planned | closed | empty | on_track | behind | overdue. Behind = more than 15 points under the time used.
const BEHIND_POINTS = 15;
export function sprintHealth({ status, startDate, endDate, tasks = [], now = new Date(), summary = null }) {
  const total = summary?.planned ?? tasks.length, done = summary?.done ?? tasks.filter((t) => t.status === "Done").length;
  const progressPct = total ? Math.round((done / total) * 100) : 0;
  const s = +new Date(startDate), e = +new Date(endDate);
  const elapsedPct = e > s ? Math.round(Math.min(100, Math.max(0, ((+now - s) / (e - s)) * 100))) : 0;
  const v = summary?.velocity ?? velocity(tasks);
  const out = { total, done, progressPct, elapsedPct, velocity: v };
  if (status === "Completed") return { ...out, state: "closed" };
  if (status === "Planning") return { ...out, state: "planned" };
  if (!total) return { ...out, state: "empty" };
  if (+now > e && done < total) return { ...out, state: "overdue" };
  return { ...out, state: elapsedPct - progressPct > BEHIND_POINTS ? "behind" : "on_track" };
}
const HEALTH_LABEL = { planned: "Planned", closed: "Closed", empty: "No tasks", on_track: "On track", behind: "Behind", overdue: "Past its end date" };

export function exportDoc(tab, data) {
  if (!TITLES[tab]) throw new Error(`Unknown report tab "${tab}".`);
  const sections = [];
  if (tab === "delivery") {
    const delta = compare(data.current, data.previous);
    sections.push({ heading: "Summary", headers: ["Measure", "This period", "Previous period", "Change"],
      rows: MEASURES.map(([k, label, s]) => [label, v(data.current[k], s), v(data.previous[k], s), signed(delta[k], s)]) });
    sections.push({ heading: "Done tasks over time", headers: ["Period", "Tasks done"], rows: (data.done ?? []).map((p) => [p.label, String(p.value)]) });
    sections.push({ heading: "Velocity per sprint", headers: ["Sprint", "Velocity (XP)"], rows: (data.sprints ?? []).map((s) => [s.name, String(s.velocity)]) });
  } else if (tab === "people") {
    sections.push({ heading: "Team", headers: ["Member", "Role", "Tasks done", "On time %", "Avg score", "Rework", "XP earned"],
      rows: data.rows.map((r) => [r.name, r.role, String(r.tasksDone), v(r.onTimePct), v(r.avgScore), String(r.rework), String(r.xp)]) });
  } else if (tab === "xp") {
    sections.push({ heading: data.memberName ? `XP for ${data.memberName}` : "Team XP", headers: ["Period", "XP (net)"], rows: (data.points ?? []).map((p) => [p.label, String(p.value)]) });
    sections.push({ heading: "Total", headers: ["Measure", "Value"], rows: [["XP this period (net)", String(data.total ?? 0)], ["Previous period", String(data.previousTotal ?? 0)]] });
  } else if (tab === "activity") {
    sections.push({ heading: "Activity", headers: ["When", "Who", "Task", "What"], rows: data.items.map((x) => [new Date(x.at).toISOString().slice(0, 16).replace("T", " "), x.who, x.task, x.text || x.kind]) });
  } else if (tab === "sprints") {
    sections.push({ heading: "Sprint health", headers: ["Sprint", "Project", "State", "Done", "Progress", "Time used", "Velocity"],
      rows: data.rows.map((r) => [r.name, r.project, HEALTH_LABEL[r.state] ?? r.state, `${r.done} / ${r.total}`, `${r.progressPct}%`, `${r.elapsedPct}%`, `${r.velocity} XP`]) });
  } else if (tab === "wellbeing") {
    const c = data.current;
    sections.push({ heading: "Team today", headers: ["Group", "People"], rows: [["Doing fine", String(c.tiers.Healthy)], ["Getting tired", String(c.tiers.Tired)], ["Needs a lighter load", String(c.tiers.Low)]] });
    sections.push({ heading: "Averages", headers: ["Measure", "Value"], rows: [["People", String(c.members)], ["Average HP", v(c.avgHp)], ["Active streaks", String(c.activeStreaks)], ["Average streak (days)", v(c.avgStreak)]] });
    sections.push({ heading: "Trend", headers: ["Day", "Doing fine", "Getting tired", "Needs a lighter load"], rows: (data.trend ?? []).map((t) => [t.label, String(t.Healthy), String(t.Tired), String(t.Low)]) });
  } else {
    const f = data.facts;
    sections.push({ heading: "Auto facts", headers: ["Fact", "Count"], rows: [["Tasks done", `${f.done} of ${f.tasks}`], ["Late tasks", String(f.lateTasks)], ["Sent back from review", String(f.rejectedInReview)],
      ["Overload alerts", String(f.overloadEvents)], ["Anomaly flags", String(f.anomalies)], ["Deadline extensions", String(f.extensions)]] });
    sections.push({ heading: "Notes", headers: ["Date", "Note"], rows: (data.notes ?? []).map((x) => [x.date, x.text]) });
  }
  return { title: TITLES[tab], filters: data.filters, sections };
}
