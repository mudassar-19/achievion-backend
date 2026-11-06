// E-2 (employee daily loop): Today numbers, next best action, XP trend, rank gap, daily insight, review result, task filters.
import test from "node:test";
import assert from "node:assert/strict";
import { nextBestAction, todayTasks, dueTodayCount, xpTrend, rankCard, dailyInsight, reviewView, latestFeedback } from "../services/employeeRules.js";
import { statusMoveBlocker } from "../services/teamLeadRules.js";
import { filterMyTasks } from "../../client/src/utils/employeePortal.js";
import { moveVerdict } from "../../client/src/utils/boardRules.js";

const NOW = new Date(2026, 10, 6, 10, 0); // 6 Nov 2026 10:00 local
const day = (d, h = 12) => new Date(2026, 10, d, h);
const T = (id, status, deadline, priority = "Medium", extra = {}) => ({ id, status, deadline, priority, blocked: false, ...extra });

test("next best action: open and not blocked, nearest deadline, then priority", () => {
  const tasks = [T("a", "To-Do", day(9), "Low"), T("b", "In-Progress", day(8), "Low"), T("c", "To-Do", day(8), "Critical"),
    T("d", "In-Review", day(7)), T("e", "Done", day(6)), T("f", "To-Do", day(6), "High", { blocked: true }), T("g", "To-Do", null, "Critical"), T("h", "Backlog", day(6))];
  assert.equal(nextBestAction(tasks).id, "c");
  assert.equal(nextBestAction([T("x", "To-Do", null, "Low"), T("y", "To-Do", null, "High")]).id, "y");
  assert.equal(nextBestAction([T("z", "In-Review", day(7))]), null);
});

test("my tasks today: not Done, nearest first, at most 5; due today counts the calendar day", () => {
  const tasks = Array.from({ length: 8 }, (_, i) => T(`t${i}`, i === 0 ? "Done" : "To-Do", day(7 + i)));
  const list = todayTasks(tasks);
  assert.equal(list.length, 5);
  assert.deepEqual(list.map((t) => t.id), ["t1", "t2", "t3", "t4", "t5"]);
  assert.equal(dueTodayCount([T("a", "To-Do", day(6, 23)), T("b", "Done", day(6, 9)), T("c", "To-Do", day(7, 0)), T("d", "In-Review", day(6, 1)), T("e", "To-Do", null)], NOW), 2);
});

test("XP trend: one point per day, net XP, week = 7 and month = 30 points", () => {
  const logs = [{ amount: 50, createdAt: day(6, 9) }, { amount: 20, createdAt: day(6, 8) }, { amount: -10, createdAt: day(5) }, { amount: 99, createdAt: day(1) }, { amount: 7, createdAt: new Date(2026, 9, 1) }];
  const w = xpTrend(logs, "week", NOW);
  assert.equal(w.length, 7);
  assert.deepEqual(w.at(-1), { date: "2026-11-06", xp: 70 });
  assert.deepEqual(w.at(-2), { date: "2026-11-05", xp: -10 });
  assert.equal(w[0].date, "2026-10-31");
  assert.equal(w.reduce((s, p) => s + p.xp, 0), 159);
  const m = xpTrend(logs, "month", NOW);
  assert.equal(m.length, 30);
  assert.equal(m.reduce((s, p) => s + p.xp, 0), 159); // 1 Oct is outside 30 days
});

test("rank card: rank, people, XP gap to the next rank (ties share), leader has no gap", () => {
  const rows = [{ userId: "a", name: "A", xp: 900, rank: 1 }, { userId: "b", name: "B", xp: 500, rank: 2 }, { userId: "c", name: "C", xp: 500, rank: 2 }, { userId: "me", name: "Me", xp: 420, rank: 4 }];
  assert.deepEqual(rankCard(rows, "me"), { rank: 4, total: 4, gap: 80, ahead: "B", nextRank: 2 });
  assert.deepEqual(rankCard(rows, "a"), { rank: 1, total: 4, gap: 0, ahead: null, nextRank: null });
  assert.equal(rankCard(rows, "zz"), null);
});

test("daily insight: one line from numbers, HP first, then due today, then XP to next level; Why lists the numbers", () => {
  const base = { hp: 80, dueToday: 0, xpToNext: 120, level: 5, streak: 3, openTasks: 4 };
  assert.equal(dailyInsight(base).text, "120 XP to reach level 6.");
  assert.match(dailyInsight({ ...base, dueToday: 2 }).text, /^2 tasks are due today/);
  assert.match(dailyInsight({ ...base, dueToday: 1 }).text, /^1 task is due today/);
  assert.match(dailyInsight({ ...base, hp: 25, dueToday: 2 }).text, /HP is 25/);
  const why = dailyInsight(base).why;
  assert.deepEqual(why.map((w) => w.label), ["HP", "Due today", "Open tasks", "XP to next level", "Streak"]);
  assert.equal(why.find((w) => w.label === "XP to next level").value, 120);
  assert.doesNotMatch(dailyInsight(base).text, /AI/);
});

test("review view: decision, TL score, stars, feedback, unmet criteria, revisions, XP breakdown; never the AI score", () => {
  const approved = { status: "Done", tlScore: 86, aiScore: 41, aiScores: { q: 41 }, reviewNote: "Clean work.", reviewedAt: day(5), resubmissionCount: 1,
    revisionHistory: [{ type: "revision_requested", comment: "Add tests.", unmetCriteria: ["Has tests"], requestedAt: day(3) }] };
  const logs = [{ userId: "me", taskId: "t", amount: 138, source: "task_approved", createdAt: day(5), breakdown: { base: 100, typeMult: 1, timeMult: 1.15, qualMult: 1.2, streakMult: 1, lateMult: 1, gold: 13 } },
    { userId: "me", taskId: "t", amount: -20, source: "flag_reversal", createdAt: day(6) }];
  const v = reviewView(approved, logs);
  assert.equal(v.decision, "approved");
  assert.equal(v.score, 86);
  assert.equal(v.stars, 4);
  assert.equal(v.feedback, "Clean work.");
  assert.equal(v.revisions, 1);
  assert.deepEqual(v.lastRevision, { reason: "Add tests.", unmet: ["Has tests"], at: day(3) });
  assert.deepEqual(v.xp.map((r) => r.label), ["Base for the task", "On time or early", "Quality (4 stars)", "XP from the review", "Taken back after a check"]);
  assert.equal(v.xp.find((r) => r.label === "XP from the review").value, 138);
  assert.equal(v.xpTotal, 118);
  const json = JSON.stringify(v);
  assert.doesNotMatch(json, /aiScore|aiScores|"41"|:41\b/);

  const revision = reviewView({ status: "In-Progress", tlScore: null, resubmissionCount: 2, revisionHistory: [{ type: "revision_requested", comment: "Fix the layout.", unmetCriteria: [] , requestedAt: day(4) }] }, []);
  assert.equal(revision.decision, "revision");
  assert.equal(revision.lastRevision.reason, "Fix the layout.");
  assert.equal(revision.score, null);
  assert.equal(reviewView({ status: "In-Review", revisionHistory: [] }, []).decision, "waiting");
  assert.equal(reviewView({ status: "To-Do", revisionHistory: [] }, []).decision, "none");
});

test("latest feedback: newest of approvals and revision requests", () => {
  const tasks = [
    { id: "a", title: "A", status: "Done", tlScore: 70, reviewedAt: day(3), revisionHistory: [] },
    { id: "b", title: "B", status: "In-Progress", revisionHistory: [{ type: "revision_requested", comment: "More contrast.", requestedAt: day(5) }] },
    { id: "c", title: "C", status: "To-Do", revisionHistory: [] },
  ];
  assert.deepEqual(latestFeedback(tasks), { kind: "revision", taskId: "b", title: "B", at: day(5), reason: "More contrast." });
  assert.deepEqual(latestFeedback(tasks.slice(0, 1)), { kind: "approved", taskId: "a", title: "A", at: day(3), score: 70, stars: 4 });
  assert.equal(latestFeedback([tasks[2]]), null);
});

test("Done is never a drag target or source for employees (client and server)", () => {
  const task = { status: "In-Review" };
  assert.equal(moveVerdict({ roleCategory: "developer", task, to: "Done", isAssignee: true }).ok, false);
  assert.equal(moveVerdict({ roleCategory: "tester", task: { status: "Done" }, to: "In-Progress", isAssignee: true }).ok, false);
  assert.ok(statusMoveBlocker({ role: "Developer", roleCategory: "developer", from: "In-Review", to: "Done", isAssignee: true }));
  assert.ok(statusMoveBlocker({ role: "Designer", roleCategory: "designer", from: "Done", to: "In-Progress", isAssignee: true }));
});

test("my tasks filters from the URL: status, type, priority, sprint, blocked", () => {
  const rows = [
    { id: 1, status: "To-Do", type: "Feature", priority: "High", sprint: { id: "s1" }, blocked: false },
    { id: 2, status: "In-Progress", type: "Bug", priority: "Low", sprint: null, blocked: true },
    { id: 3, status: "Done", type: "Feature", priority: "High", sprint: { id: "s2" }, blocked: false },
  ];
  const ids = (q) => filterMyTasks(rows, new URLSearchParams(q)).map((r) => r.id);
  assert.deepEqual(ids(""), [1, 2, 3]);
  assert.deepEqual(ids("status=To-Do"), [1]);
  assert.deepEqual(ids("type=Feature&priority=High"), [1, 3]);
  assert.deepEqual(ids("sprint=s2"), [3]);
  assert.deepEqual(ids("sprint=none"), [2]);
  assert.deepEqual(ids("blocked=1"), [2]);
  assert.deepEqual(ids("status=Nonsense"), []);
});

test("my tasks order: open first by nearest deadline (none last) then priority, Done at the end", async () => {
  const { sortRows } = await import("../services/employeeRules.js");
  const rows = [T("done", "Done", day(1)), T("none", "To-Do", null, "Critical"), T("late", "In-Progress", day(2)), T("soon", "To-Do", day(8), "Low"), T("soonHi", "To-Do", day(8), "High")];
  assert.deepEqual(sortRows(rows).map((r) => r.id), ["late", "soonHi", "soon", "none", "done"]);
});
