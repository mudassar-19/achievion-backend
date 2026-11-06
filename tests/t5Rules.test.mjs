// T-5: resubmission limit decision, TL sprint writes, bulk add to sprint, performance (team scope, activity, sprint health), My stats, announcements.
import test from "node:test";
import assert from "node:assert/strict";
import { limitDecision, limitRequestFields, LIMIT_TYPE, limitState } from "../services/reviewRules.js";
import { canDeleteSprint, tlSprintBlock, startBlockers } from "../services/sprintRules.js";
import { validateBulk, bulkSprintPlan } from "../services/taskFormRules.js";
import { deliveryNumbers, peopleRows, activityFeed, ACTIVITY_KINDS, sprintHealth, exportDoc } from "../services/reportRules.js";
import { myStatsView, announcementView } from "../services/teamLeadRules.js";

test("resubmission limit: Allow gives one more try, once", () => {
  const open = { type: LIMIT_TYPE, status: "Pending" };
  const a = limitDecision(open, { decision: "allow" });
  assert.equal(a.status, "Resolved"); assert.equal(a.incLimit, 1);
  const d = limitDecision(open, { decision: "decline", note: "No" });
  assert.equal(d.status, "Rejected"); assert.equal(d.incLimit, 0);
  assert.equal(limitDecision({ type: LIMIT_TYPE, status: "Resolved" }, { decision: "allow" }).httpStatus, 409, "already decided");
  assert.equal(limitDecision({ type: "Other", status: "Pending" }, { decision: "allow" }).httpStatus, 400);
  assert.equal(limitDecision(open, { decision: "maybe" }).httpStatus, 400);
});

test("resubmission limit: request text names task, assignee, Team Lead, attempts", () => {
  const f = limitRequestFields({ taskTitle: "Login", assigneeName: "Sara", tlName: "Omar", attempts: 3, max: 3 });
  assert.equal(f.type, LIMIT_TYPE); assert.equal(f.priority, "High");
  for (const w of ["Login", "Sara", "Omar", "3"]) assert.ok(f.message.includes(w), w);
  assert.ok(f.title.length <= 200);
  assert.equal(limitState(null), null);
  assert.equal(limitState({ status: "Pending" }), "waiting");
  assert.equal(limitState({ status: "Resolved" }), "allowed");
  assert.equal(limitState({ status: "Rejected" }), "declined");
});

test("sprint delete: only a planned sprint", () => {
  assert.equal(canDeleteSprint("Planning"), true);
  for (const s of ["Active", "Under Review", "Delayed", "Completed"]) assert.equal(canDeleteSprint(s), false, s);
});

test("TL sprint write: never another Team Lead's sprint", () => {
  assert.equal(tlSprintBlock({ createdBy: "me", creatorRole: "Team Lead", userId: "me" }), false);
  assert.equal(tlSprintBlock({ createdBy: "mgr", creatorRole: "Manager", userId: "me" }), false, "the Manager's sprint on my project is fine (D-121)");
  assert.equal(tlSprintBlock({ createdBy: "other", creatorRole: "Team Lead", userId: "me" }), true);
  assert.equal(tlSprintBlock({ createdBy: null, creatorRole: null, userId: "me" }), false);
});

test("TL sprint start: the same rules as the Manager (D-089..D-092)", () => {
  assert.deepEqual(startBlockers({ status: "Planning", teamLeadCount: 1, taskCount: 1 }), []);
  assert.equal(startBlockers({ status: "Planning", teamLeadCount: 1, taskCount: 0 }).length, 1);
  assert.equal(startBlockers({ status: "Planning", teamLeadCount: 0, taskCount: 1 }).length, 1);
  assert.equal(startBlockers({ status: "Planning", teamLeadCount: 1, taskCount: 1, otherActive: "S1" }).length, 1);
});

test("bulk add to sprint: id check, same project only, skips with a reason", () => {
  assert.ok(validateBulk({ ids: ["a".repeat(24)], action: "sprint", value: "nope" }).error);
  assert.equal(validateBulk({ ids: ["a".repeat(24)], action: "sprint", value: "b".repeat(24) }).value, "b".repeat(24));
  const sprint = { projectId: "p1", tasks: ["in"] };
  const tasks = [{ _id: "ok", title: "OK", projectId: "p1", status: "To-Do" }, { _id: "in", title: "In", projectId: "p1", status: "To-Do" }, { _id: "x", title: "X", projectId: "p2", status: "To-Do" }, { _id: "d", title: "D", projectId: "p1", status: "Done" }, { _id: "e", title: "E", projectId: "p1", status: "To-Do" }];
  const plan = bulkSprintPlan(tasks, sprint, new Map([["e", "Other sprint"]]));
  assert.deepEqual(plan.add, ["ok"]);
  assert.deepEqual(plan.skipped.map((s) => s.id), ["in", "x", "d", "e"]);
  assert.ok(plan.skipped.find((s) => s.id === "e").reason.includes("Other sprint"));
});

test("performance: rows only for the team, and only their tasks count", () => {
  const r = { from: new Date("2026-11-01"), to: new Date("2026-11-30") };
  const t = (who, o = {}) => ({ status: "Done", completedAt: new Date("2026-11-10"), assignees: [who], tlScore: 80, ...o });
  const rows = peopleRows([t("mine"), t("mine"), t("stranger")], [{ _id: "mine", name: "Mine", role: "Developer" }], { mine: 40, stranger: 999 }, r);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tasksDone, 2); assert.equal(rows[0].xp, 40);
});

test("activity feed: filters by kind and period, newest first, names, capped", () => {
  const from = new Date("2026-11-01"), to = new Date("2026-11-30");
  const tasks = [{ _id: "t1", title: "A", activity: [{ kind: "status", by: "u1", at: new Date("2026-11-02"), from: "To-Do", to: "In-Progress" }, { kind: "comment", by: "u2", at: new Date("2026-11-05"), note: "hi" }, { kind: "status", by: "u1", at: new Date("2026-10-01") }] }];
  const all = activityFeed(tasks, { from, to, names: { u1: "One" } });
  assert.deepEqual(all.items.map((x) => x.kind), ["comment", "status"]);
  assert.equal(all.items[1].who, "One"); assert.equal(all.items[0].who, "Someone");
  assert.deepEqual(activityFeed(tasks, { from, to, kind: "comment" }).items.map((x) => x.kind), ["comment"]);
  assert.equal(activityFeed(tasks, { from, to, kind: "nonsense" }).items.length, 2, "an unknown filter shows all");
  assert.ok(ACTIVITY_KINDS.includes("status"));
  const many = [{ _id: "m", title: "M", activity: Array.from({ length: 300 }, (_, i) => ({ kind: "time", at: new Date(+from + i * 1000) })) }];
  assert.equal(activityFeed(many, { from, to }).items.length, 100);
});

test("sprint health: progress against elapsed time", () => {
  const start = new Date("2026-11-01"), end = new Date("2026-11-11"), now = new Date("2026-11-06");
  const tasks = (d, n) => [...Array(d).fill({ status: "Done" }), ...Array(n).fill({ status: "To-Do" })];
  assert.equal(sprintHealth({ status: "Active", startDate: start, endDate: end, tasks: tasks(5, 5), now }).state, "on_track");
  assert.equal(sprintHealth({ status: "Active", startDate: start, endDate: end, tasks: tasks(1, 9), now }).state, "behind");
  assert.equal(sprintHealth({ status: "Active", startDate: start, endDate: end, tasks: tasks(1, 9), now: new Date("2026-11-20") }).state, "overdue");
  assert.equal(sprintHealth({ status: "Active", startDate: start, endDate: end, tasks: [], now }).state, "empty");
  assert.equal(sprintHealth({ status: "Planning", startDate: start, endDate: end, tasks: tasks(0, 2), now }).state, "planned");
  const c = sprintHealth({ status: "Completed", startDate: start, endDate: end, tasks: tasks(2, 0), now, summary: { planned: 4, done: 3, velocity: 90 } });
  assert.equal(c.state, "closed"); assert.equal(c.total, 4); assert.equal(c.done, 3); assert.equal(c.velocity, 90);
});

test("export: activity and sprint health have a document", () => {
  const a = exportDoc("activity", { filters: "x", items: [{ at: "2026-11-02T00:00:00Z", who: "One", kind: "status", task: "A", text: "To-Do to In-Progress" }] });
  assert.equal(a.sections[0].rows.length, 1);
  const s = exportDoc("sprints", { filters: "x", rows: [{ name: "S", project: "P", state: "on_track", done: 1, total: 2, progressPct: 50, elapsedPct: 40, velocity: 10 }] });
  assert.equal(s.sections[0].rows[0][0], "S");
});

test("My stats: level progress, week XP, no badges", () => {
  const v = myStatsView({ profile: { level: 3, totalXp: 3400, currentXp: 400, streaks: { daily: 4 }, stats: { reviewsGiven: 12 }, badges: [{}] }, logs: [{ amount: 40, source: "tl_review_efficiency", createdAt: new Date("2026-11-05") }, { amount: 40, source: "tl_review_efficiency", createdAt: new Date("2026-10-01") }], now: new Date("2026-11-06") });
  assert.equal(v.level, 3); assert.equal(v.totalXp, 3400); assert.equal(v.streak, 4); assert.equal(v.reviewsGiven, 12); assert.equal(v.xpThisWeek, 40);
  assert.equal(v.recent.length, 2); assert.ok(v.recent[0].label);
  assert.ok(v.levelPct >= 0 && v.levelPct <= 100); assert.ok(v.xpToNext > 0);
  assert.equal("badges" in v, false);
  assert.equal(myStatsView({ profile: null, logs: [] }).level, 1);
});

test("announcement: unread from readBy; deleted sender safe", () => {
  const a = announcementView({ _id: "m", content: "Hello", createdAt: new Date(), readBy: ["x"], sender: { name: "Mgr", role: "Manager" } }, { name: "ann" }, "me");
  assert.equal(a.unread, true); assert.equal(a.from, "Mgr"); assert.equal(a.channel, "ann");
  assert.equal(announcementView({ _id: "m", content: "", readBy: ["me"], sender: null }, {}, "me").unread, false);
  assert.equal(announcementView({ _id: "m", content: "", readBy: [], sender: null }, {}, "me").from, "Someone");
});

test("delivery: rework counts times done work was sent back", () => {
  const r = { from: new Date("2026-11-01"), to: new Date("2026-11-30") };
  const back = { kind: "status", from: "In-Review", to: "In-Progress" };
  const n = deliveryNumbers([{ status: "Done", completedAt: new Date("2026-11-10"), activity: [back, back] }, { status: "Done", completedAt: new Date("2026-11-11"), activity: [] }], r);
  assert.equal(n.rework, 2);
});
