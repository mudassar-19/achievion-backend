// T-6: TL review XP, TL AI guardrails, sprint notifications.
import test from "node:test";
import assert from "node:assert/strict";
import { tlReviewAward, TL_REVIEW_XP } from "../services/xpEngine.js";
import { reversalPlan } from "../services/anomalyRules.js";
import { makeRefs } from "../services/managerAiRules.js";
import { tlContextFromPath, resolveTlContext, TL_PROMPTS_FOR, tlSourcesFor, tlProactiveCards, validateTlInsight, validateAssignHint, validateRealismExplain, tlTaskForAi, FEATURE_PREFIX } from "../services/tlAiRules.js";
import { sprintNotifyList } from "../services/sprintRules.js";
import { groupsFor, isMuted } from "../services/notificationPrefs.js";

const T0 = new Date("2026-11-05T10:00:00Z");
const after = (ms) => new Date(+T0 + ms);

test("TL review XP: +40 for a normal approval", () => {
  assert.equal(TL_REVIEW_XP, 40);
  assert.deepEqual(tlReviewAward({ stars: 4, submittedAt: T0, approvedAt: after(60_000) }), { xp: 40, reason: null });
  assert.deepEqual(tlReviewAward({ stars: 5, submittedAt: T0, approvedAt: after(3 * 60_000) }), { xp: 40, reason: null });
});
test("TL review XP: a rubber-stamp review earns nothing", () => {
  assert.deepEqual(tlReviewAward({ stars: 5, submittedAt: T0, approvedAt: after(60_000) }), { xp: 0, reason: "rubber_stamp" });
});
test("TL review XP: a conditional approval earns nothing", () => {
  assert.deepEqual(tlReviewAward({ stars: 4, submittedAt: T0, approvedAt: after(9e6), conditional: true }), { xp: 0, reason: "conditional" });
});
test("TL review XP reversal: one negative entry, never below zero", () => {
  const p = reversalPlan({ original: { amount: 40 }, profile: { totalXp: 100, monthlyXp: 20 } });
  assert.equal(p.amount, -40); assert.equal(p.totalXp, 60);
  assert.equal(reversalPlan({ original: { amount: 40 }, profile: { totalXp: 10 } }).totalXp, 0);
  assert.equal(reversalPlan({ original: { amount: 40 }, profile: { totalXp: 100 }, alreadyReversed: true }), null);
});

test("context from the page", () => {
  const id = "a".repeat(24), m = "b".repeat(24);
  assert.deepEqual(tlContextFromPath(`/teamlead/modules/${id}`, `?module=${m}&tab=handoff`), { kind: "module", id, moduleId: m });
  assert.deepEqual(tlContextFromPath(`/teamlead/modules/${id}`, ""), { kind: "module", id, moduleId: null });
  assert.deepEqual(tlContextFromPath(`/teamlead/modules/${id}/breakdown`, ""), { kind: "module", id, moduleId: null });
  assert.deepEqual(tlContextFromPath("/teamlead/tasks", `?task=${id}`), { kind: "task", id });
  assert.deepEqual(tlContextFromPath(`/teamlead/review/${id}`, ""), { kind: "task", id });
  assert.deepEqual(tlContextFromPath(`/teamlead/sprints/${id}`, ""), { kind: "sprint", id });
  assert.deepEqual(tlContextFromPath("/teamlead/team", "?member=x"), { kind: "team" });
  assert.deepEqual(tlContextFromPath("/teamlead", ""), { kind: "team" });
});
test("context: an id outside the TL's lists falls back to Team", () => {
  const lists = { projects: [{ id: "p1", title: "Alpha" }], sprints: [{ id: "s1", name: "S" }], tasks: [{ id: "t1", title: "Build" }] };
  assert.equal(resolveTlContext({ kind: "module", id: "p1" }, lists).label, "Module: Alpha");
  assert.deepEqual(resolveTlContext({ kind: "module", id: "other" }, lists), { kind: "team", label: "My team" });
  assert.deepEqual(resolveTlContext({ kind: "sprint", id: "other" }, lists), { kind: "team", label: "My team" });
  assert.deepEqual(resolveTlContext({ kind: "task", id: "other" }, lists), { kind: "team", label: "My team" });
  assert.equal(resolveTlContext({ kind: "task", id: "t1" }, lists).label, "Task: Build");
  for (const k of ["team", "module", "task", "sprint"]) assert.ok(TL_PROMPTS_FOR[k].length >= 2, k);
  assert.equal(FEATURE_PREFIX, "tl_");
});
test("sources are Team Lead deep links", () => {
  const s = tlSourcesFor({ kind: "task", id: "t1", label: "Task: Build" });
  assert.equal(s.task.to, "/teamlead/tasks?task=t1"); assert.equal(s.review.to, "/teamlead/review/t1");
  assert.ok(Object.values(s).every((x) => x.to.startsWith("/teamlead")));
  assert.equal(tlSourcesFor({ kind: "module", id: "p1", moduleId: "m1", label: "Module: A" }).module.to, "/teamlead/modules/p1?module=m1");
});
test("proactive cards come from numbers", () => {
  assert.deepEqual(tlProactiveCards({}), []);
  const c = tlProactiveCards({ overloaded: 1, blocked: 2, reviewQueue: 3 });
  assert.equal(c.length, 3); assert.ok(c.every((x) => x.to.startsWith("/teamlead")));
});

test("no AI score reaches the AI: not before the TL scores, not after", () => {
  const raw = { _id: "x", title: "Build", status: "In-Review", aiScore: 88, aiScores: { logic: 91 }, tlScore: null, aiEval: { status: "done", partial: true, score: 77, scores: { a: 66 }, strengths: ["Clear"], evidence: "scored 55" }, assignee: { name: "Ana" }, deadline: T0, estimatedHours: 3, priority: "High" };
  const row = tlTaskForAi(raw), text = JSON.stringify(row);
  for (const bad of ["88", "91", "77", "66", "55", "aiScore", "aiScores", "score\"", "evidence", "strengths"]) assert.equal(text.includes(bad), false, bad);
  assert.equal(row.aiReview, "partial");
  assert.equal(row.assignee, "Ana");
  assert.equal(JSON.stringify(tlTaskForAi({ ...raw, tlScore: 70 })).includes("88"), false);
  assert.equal(tlTaskForAi({ ...raw, tlScore: 70 }).teamLeadScore, 70);
  assert.equal(tlTaskForAi({ ...raw, tlScore: null }).teamLeadScore, undefined);
});

test("tl-insight validator rejects invented ids, wrong kinds, blaming words", () => {
  const refs = makeRefs(); refs.add("m", "u1"); refs.add("t", "t1"); refs.add("k", "mod1"); refs.add("s", "s1");
  const ok = { kind: "blocked", title: "Two tasks wait", body: "Two tasks wait for Login design to finish.", why: ["2 blocked"], target: "t1" };
  assert.equal(validateTlInsight(ok, refs).ok, true);
  for (const tg of ["m1", "t1", "k1", "s1", null]) assert.equal(validateTlInsight({ ...ok, target: tg }, refs).ok, true, String(tg));
  assert.equal(validateTlInsight({ ...ok, target: "t99" }, refs).error, "invented id");
  assert.equal(validateTlInsight({ ...ok, target: "p1" }, refs).error, "invented id");
  assert.equal(validateTlInsight({ ...ok, kind: "gossip" }, refs).ok, false);
  assert.equal(validateTlInsight({ ...ok, body: "Ana is lazy and that blocks the two tasks." }, refs).ok, false);
  assert.deepEqual(validateTlInsight({ kind: "none" }, refs).value, { kind: "none" });
});
test("tl-assign-hint validator picks only from the engine's candidates", () => {
  const refs = makeRefs(); refs.add("c", "u1");
  assert.equal(validateAssignHint({ candidate: "c1", reason: "Has 3 free hours a day." }, refs).ok, true);
  assert.equal(validateAssignHint({ candidate: "c9", reason: "Has 3 free hours a day." }, refs).ok, false);
  assert.equal(validateAssignHint({ candidate: "u1", reason: "Has 3 free hours a day." }, refs).ok, false);
});
test("tl-realism-explain may not invent numbers", () => {
  const realism = { verdict: "over", totals: { taskHours: 42, capacityHours: 30, freeHours: 12, usedPct: 140, days: 5 }, issues: [{ message: "Sara is over" }], people: [{ name: "Sara", hours: 20 }] };
  assert.equal(validateRealismExplain({ explanation: "The draft needs 42 hours but the team has 30 in 5 days, 140% of what fits." }, realism).ok, true);
  assert.equal(validateRealismExplain({ explanation: "The draft needs 42 hours but you would really need 55 hours for this." }, realism).error, "new number");
  assert.equal(validateRealismExplain({ explanation: "ok" }, realism).ok, false);
  assert.equal(validateRealismExplain({ explanation: "The draft fits the time you have and nobody is over." }, realism).ok, true);
});

test("sprint notifications: members and Manager, once, not the person who did it", () => {
  const list = sprintNotifyList({ members: [{ _id: "tl" }, { _id: "dev" }, "dev", { _id: "mgr" }], managerId: "mgr", actorId: "tl" });
  assert.deepEqual(list.sort(), ["dev", "mgr"]);
});
test("sprint notifications have a real toggle for every role", () => {
  for (const r of ["Manager", "Director", "Team Lead", "Developer", "Senior Tester"]) {
    assert.ok(groupsFor(r).some((g) => g.key === "sprint_events" && g.types.includes("sprint_started") && g.types.includes("sprint_closed") && !g.locked), r);
    assert.equal(isMuted({ role: r, prefs: { sprint_events: false }, type: "sprint_started" }), true, r);
    assert.equal(isMuted({ role: r, prefs: {}, type: "sprint_closed" }), false, r);
  }
});

// D-155 (FR03-07): who hears about a deadline.
test("deadline alert: assignees and the Team Lead, once each; an unassigned task still reaches the lead", async () => {
  const { deadlineAudience } = await import("../services/xpEngine.js");
  assert.deepEqual(deadlineAudience({ assignees: ["a", "b"], assignee: "a" }, ["tl"]), { assignees: ["a", "b"], leads: ["tl"] });
  assert.deepEqual(deadlineAudience({ assignees: ["tl"], assignee: null }, ["tl"]), { assignees: ["tl"], leads: [] }, "the lead's own task: one notice");
  assert.deepEqual(deadlineAudience({ assignees: [], assignee: null }, ["tl"]), { assignees: [], leads: ["tl"] });
  assert.deepEqual(deadlineAudience({ assignees: ["a"], assignee: null }, []), { assignees: ["a"], leads: [] });
});
