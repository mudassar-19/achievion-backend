// Manager Reports rules (V2 Phase 3 · M-6). Same functions as the sprint summary (D-092) where numbers overlap.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseReportQuery, deliveryNumbers, compare, timeBuckets, series, reworkCount, peopleRows, sortRows,
  netXp, wellbeing, autoFacts, factsText, validateLesson, exportDoc,
} from "../services/reportRules.js";
import { sprintSummary } from "../services/sprintRules.js";

const P = "6aeab4127422de422c4af81b", S = "6aeab42b7422de422c4af82e", U1 = "6aeab6397422de422c4af831", U2 = "6aeab6397422de422c4af832";
const d = (s) => new Date(`2026-11-${s}Z`);
const NOW = d("15T12:00:00");

test("query: ranges, previous period of the same length, custom limits, sprint needs a project", () => {
  const w = parseReportQuery({}, NOW).value;
  assert.equal(w.range, "30d");
  assert.equal(+w.to - +w.from, 30 * 86_400_000);
  assert.equal(+w.prevTo, +w.from);
  assert.equal(+w.from - +w.prevFrom, +w.to - +w.from);
  const m = parseReportQuery({ range: "month" }, NOW).value;
  assert.equal(m.from.toISOString(), "2026-11-01T00:00:00.000Z");
  const c = parseReportQuery({ range: "custom", from: "2026-11-02", to: "2026-11-04" }, NOW).value;
  assert.equal(c.from.toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(c.to.toISOString(), "2026-11-04T23:59:59.999Z");
  assert.ok(parseReportQuery({ range: "custom", from: "2026-11-05", to: "2026-11-04" }, NOW).errors.to);
  assert.ok(parseReportQuery({ range: "custom", from: "2024-01-01", to: "2026-11-04" }, NOW).errors.to);
  assert.ok(parseReportQuery({ range: "custom", from: "nope" }, NOW).errors.from);
  assert.equal(parseReportQuery({ range: "bogus", project: "x" }, NOW).value.range, "30d");
  assert.equal(parseReportQuery({ project: "x" }, NOW).value.project, null);
  assert.equal(parseReportQuery({ sprint: S }, NOW).value.sprint, null);
  const ps = parseReportQuery({ project: P, sprint: S, member: U1 }, NOW).value;
  assert.deepEqual([ps.project, ps.sprint, ps.member], [P, S, U1]);
});

const tasks = [
  { _id: "t1", status: "Done", xpValue: 100, deadline: d("10T00:00:00"), firstSubmittedAt: d("09T00:00:00"), completedAt: d("11T00:00:00"), tlScore: 80, qualityScore: 4, aiScore: 70, assignees: [U1] },
  { _id: "t2", status: "Done", xpValue: 50, deadline: d("10T00:00:00"), firstSubmittedAt: d("12T00:00:00"), completedAt: d("12T00:00:00"), tlScore: 60, qualityScore: 3, aiScore: null, assignees: [U2],
    activity: [{ kind: "status", from: "In-Review", to: "In-Progress" }, { kind: "status", from: "To-Do", to: "In-Progress" }, { kind: "status", from: "In-Review", to: "In-Progress" }] },
  { _id: "t3", status: "Done", xpValue: 30, completedAt: d("12T00:00:00"), tlScore: null, aiScore: 90, assignees: [U1] }, // no TL score → no AI average
  { _id: "t4", status: "Done", xpValue: 999, completedAt: new Date("2026-09-01Z"), assignees: [U1] }, // outside the range
  { _id: "t5", status: "In-Progress", xpValue: 40, deadline: d("05T00:00:00"), assignees: [U2] },
];
const range = { from: d("01T00:00:00"), to: NOW };

test("delivery: speed, punctuality (D-057 first submission) and quality (AI only where the TL scored, D-075)", () => {
  const n = deliveryNumbers(tasks, range);
  assert.equal(n.tasksDone, 3);
  assert.equal(n.velocity, 180);
  assert.equal(n.onTimePct, 50); // t1 on time by first submission although completed late; t2 late
  assert.equal(n.avgTlScore, 70);
  assert.equal(n.avgStars, 3.5);
  assert.equal(n.avgAiScore, 70);
  assert.equal(n.aiCompared, 1);
  const inRange = tasks.filter((t) => ["t1", "t2", "t3"].includes(t._id));
  const s = sprintSummary(inRange);
  assert.deepEqual([n.velocity, n.onTimePct], [s.velocity, s.onTimePct]); // same functions as the sprint summary
  const empty = deliveryNumbers([], range);
  assert.deepEqual([empty.tasksDone, empty.velocity, empty.onTimePct, empty.avgTlScore, empty.avgAiScore], [0, 0, null, null, null]);
});

test("compare: difference to the previous period, null when either side has no number", () => {
  assert.deepEqual(compare({ a: 5, b: null, c: 3 }, { a: 2, b: 4, c: null }), { a: 3, b: null, c: null });
});

test("buckets: days up to 31 days, weeks (Monday) beyond, or months when asked; series sums into them", () => {
  assert.equal(timeBuckets(d("01T00:00:00"), d("07T23:00:00")).length, 7);
  const wk = timeBuckets(d("01T00:00:00"), new Date("2026-12-31T00:00:00Z"));
  assert.equal(wk[0].start.getUTCDay(), 1);
  assert.equal(timeBuckets(new Date("2026-09-15Z"), NOW, "month").length, 3);
  const b = timeBuckets(d("10T00:00:00"), d("12T23:00:00"));
  const s = series([{ at: d("10T05:00:00"), v: 2 }, { at: d("12T05:00:00"), v: -1 }, { at: d("12T06:00:00"), v: 4 }], (x) => x.at, (x) => x.v, b);
  assert.deepEqual(s.map((x) => x.value), [2, 0, 3]);
});

test("rework = times the work went back from review (both review paths log In-Review → In-Progress)", () => {
  assert.equal(reworkCount(tasks[1]), 2);
  assert.equal(reworkCount({}), 0);
});

test("people table: delivery numbers only, XP net of reversals, sortable", () => {
  const users = [{ _id: U1, name: "Ana", role: "Developer" }, { _id: U2, name: "Bo", role: "Designer" }];
  const rows = peopleRows(tasks, users, { [U1]: 120, [U2]: -10 }, range);
  const ana = rows.find((r) => r.id === U1), bo = rows.find((r) => r.id === U2);
  assert.deepEqual([ana.tasksDone, ana.onTimePct, ana.avgScore, ana.rework, ana.xp], [2, 100, 80, 0, 120]);
  assert.deepEqual([bo.tasksDone, bo.onTimePct, bo.avgScore, bo.rework, bo.xp], [1, 0, 60, 2, -10]);
  assert.deepEqual(Object.keys(ana).sort(), ["avgScore", "id", "name", "onTimePct", "rework", "role", "tasksDone", "xp"]);
  assert.deepEqual(sortRows(rows, "xp", "asc").map((r) => r.id), [U2, U1]);
  assert.deepEqual(sortRows(rows, "name", "desc").map((r) => r.id), [U2, U1]);
  assert.deepEqual(sortRows([{ id: 1, avgScore: null }, { id: 2, avgScore: 5 }], "avgScore", "desc").map((r) => r.id), [2, 1]); // empty last
});

test("net XP adds reversal entries (negative) to awards", () => {
  assert.equal(netXp([{ amount: 100 }, { amount: -40 }, { amount: 25 }]), 85);
});

test("well-being: tier counts only, no names; lighter-load wording", () => {
  const w = wellbeing([{ hp: 90, streaks: { daily: 3 } }, { hp: 45, streaks: { daily: 0 } }, { hp: 10, streaks: { daily: 1 } }, { hp: 20 }]);
  assert.deepEqual(w.tiers, { Healthy: 1, Tired: 1, Low: 2 });
  assert.equal(w.members, 4);
  assert.equal(w.lighterLoad, 2);
  assert.equal(w.avgHp, 41);
  assert.equal(w.activeStreaks, 2);
  assert.equal(w.avgStreak, 1);
  assert.ok(!JSON.stringify(w).match(/name|userId/));
  assert.deepEqual(wellbeing([]), { members: 0, tiers: { Healthy: 0, Tired: 0, Low: 0 }, lighterLoad: 0, avgHp: null, activeStreaks: 0, avgStreak: null });
});

test("auto facts: late (sprint-summary rule), rejected in review, overloads, anomalies, extensions; text for pre-fill", () => {
  const f = autoFacts({ tasks, flags: 2, overloadEvents: 1, extensions: 3, now: NOW });
  assert.equal(f.lateTasks, sprintSummary(tasks, { now: NOW }).delays.length);
  assert.equal(f.lateTasks, 2);
  assert.equal(f.rejectedInReview, 2);
  assert.deepEqual([f.overloadEvents, f.anomalies, f.extensions, f.tasks, f.done], [1, 2, 3, 5, 4]);
  assert.equal(factsText(f), "Facts at close: 4 of 5 tasks done, 2 late tasks, 2 sent back from review, 1 overload alert, 2 anomaly flags, 3 deadline extensions.");
  assert.match(factsText(autoFacts({ tasks: [], now: NOW })), /0 of 0 tasks done, 0 late tasks/);
});

test("lesson note: 3–2000 characters, trimmed", () => {
  assert.deepEqual(validateLesson({ text: "  Ship smaller tasks.  " }), { value: { text: "Ship smaller tasks." } });
  assert.ok(validateLesson({ text: "ok" }).error);
  assert.ok(validateLesson({ text: "x".repeat(2001) }).error);
  assert.ok(validateLesson({}).error);
});

test("export doc: title, filter line, sections; CSV-safe rows from the same data", () => {
  const doc = exportDoc("delivery", { filters: "All projects · Last 30 days", current: deliveryNumbers(tasks, range), previous: deliveryNumbers([], range), done: [{ label: "Nov 1", value: 2 }], sprints: [{ name: "S1", velocity: 40 }] });
  assert.equal(doc.title, "Delivery report");
  assert.equal(doc.filters, "All projects · Last 30 days");
  assert.ok(doc.sections.length >= 2);
  assert.ok(doc.sections.every((s) => Array.isArray(s.headers) && s.rows.every((r) => r.length === s.headers.length)));
  const people = exportDoc("people", { filters: "x", rows: [{ name: "Ana", role: "Developer", tasksDone: 2, onTimePct: null, avgScore: 80, rework: 0, xp: 120 }] });
  assert.deepEqual(people.sections[0].rows[0], ["Ana", "Developer", "2", "—", "80", "0", "120"]);
  assert.throws(() => exportDoc("nope", {}));
});
