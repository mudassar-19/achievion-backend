// Manager AI rules (V2 Phase 3 · M-7): context scope, invented ids, limits, cache keys, wording.
import test from "node:test";
import assert from "node:assert/strict";
import {
  makeRefs, usageState, dailyLimit, cacheKey, dayKey, contextFromPath, resolveContext, sourcesFor, prune, proactiveCards,
  validateChat, validateInsight, validateScope, validateChallengeDraft, validateRebalance, validateExplain, validateNarrative, validateLessonsDraft, isNeutral, withNames,
} from "../services/managerAiRules.js";

const OWN_P = "6aeab4127422de422c4af81b", OWN_S = "6aeab4127422de422c4af81c", OTHER = "6aeab4127422de422c4af8ff";
const lists = { projects: [{ id: OWN_P, title: "Alpha" }], sprints: [{ id: OWN_S, name: "Sprint 1" }] };

test("context: own project / sprint resolve, another org's id falls back to the team", () => {
  assert.deepEqual(resolveContext({ kind: "project", id: OWN_P }, lists), { kind: "project", id: OWN_P, label: "Project: Alpha" });
  assert.deepEqual(resolveContext({ kind: "sprint", id: OWN_S }, lists), { kind: "sprint", id: OWN_S, label: "Sprint: Sprint 1" });
  assert.equal(resolveContext({ kind: "project", id: OTHER }, lists).kind, "team");
  assert.equal(resolveContext({ kind: "sprint", id: OTHER }, lists).kind, "team");
  assert.equal(resolveContext({ kind: "anything" }, lists).kind, "team");
});

test("context: report filters keep only own ids and known keys", () => {
  const r = resolveContext({ kind: "reports", query: `project=${OTHER}&range=7d&evil=1` }, lists);
  assert.equal(r.query, "range=7d");
  assert.equal(resolveContext({ kind: "reports", query: `project=${OWN_P}&sprint=${OWN_S}` }, lists).query, `project=${OWN_P}&sprint=${OWN_S}`);
});

test("context from the page path", () => {
  assert.deepEqual(contextFromPath(`/manager/projects/${OWN_P}`), { kind: "project", id: OWN_P });
  assert.deepEqual(contextFromPath(`/manager/sprints/${OWN_S}`), { kind: "sprint", id: OWN_S });
  assert.deepEqual(contextFromPath("/manager/reports", "?range=7d"), { kind: "reports", query: "range=7d" });
  assert.equal(contextFromPath("/manager/resources").kind, "team");
  assert.equal(contextFromPath("/manager").kind, "team");
});

test("prune drops ids, ObjectId-looking strings and long arrays", () => {
  const out = prune({ id: OWN_P, projectId: OWN_P, name: "A", ref: OWN_P, list: Array.from({ length: 30 }, (_, i) => i), nested: { userId: "x", n: 2 } });
  assert.deepEqual(out, { name: "A", list: Array.from({ length: 12 }, (_, i) => i), nested: { n: 2 } });
});

test("refs: same id same ref; only given refs resolve", () => {
  const r = makeRefs();
  assert.equal(r.add("m", OWN_P), "m1");
  assert.equal(r.add("m", OWN_P), "m1");
  assert.equal(r.add("p", OWN_S), "p1");
  assert.equal(r.id("m1"), OWN_P);
  assert.equal(r.id("m9"), null);
  assert.equal(r.has("p1", "m"), false);
});

test("validator rejects invented ids (insight, rebalance, scope)", () => {
  const r = makeRefs(); r.add("m", OWN_P); r.add("c", OWN_S); r.add("t", OWN_P); r.add("t", OWN_S);
  const ins = { kind: "overload", title: "One person is over capacity", body: "m1 is at 160 % of daily capacity.", why: ["Utilisation 160 %"] };
  assert.equal(validateInsight({ ...ins, target: "m1" }, r).ok, true);
  assert.equal(validateInsight({ ...ins, target: "m7" }, r).error, "invented id");
  assert.equal(validateInsight({ ...ins, target: OWN_P }, r).error, "invented id");
  assert.equal(validateInsight({ kind: "none" }, r).ok, true);
  assert.equal(validateRebalance({ candidate: "c1", reason: "Most free hours, same role." }, r).ok, true);
  assert.equal(validateRebalance({ candidate: "c2", reason: "Most free hours, same role." }, r).error, "invented id");
  const nums = { sprintHours: { t1: 10 }, backlogHours: { t2: 5 }, capacity: 20 };
  assert.equal(validateScope({ add: ["t2"], remove: [], why: "Fits the free hours." }, r, nums).ok, true);
  assert.equal(validateScope({ add: ["t9"], remove: [], why: "Fits the free hours." }, r, nums).error, "invented id");
  assert.equal(validateScope({ add: ["t1"], remove: [], why: "Already in the sprint." }, r, nums).error, "invented id");
  assert.equal(validateScope({ add: ["t2"], remove: [], why: "Too much." }, r, { ...nums, capacity: 12 }).error, "over capacity");
  assert.equal(validateScope({ add: [], remove: ["t1"], why: "Cut to fit." }, r, { ...nums, capacity: 5 }).ok, true);
});

test("chat: only the context's sources", () => {
  const src = sourcesFor({ kind: "project", id: OWN_P, label: "Project: Alpha" });
  assert.equal(src.project.to, `/manager/projects/${OWN_P}`);
  assert.equal(validateChat({ answer: "Two people are over capacity.", sources: ["resources"] }, src).ok, true);
  assert.equal(validateChat({ answer: "x", sources: ["sprint"] }, src).ok, false);
  assert.equal(validateChat({ answer: "x", sources: ["https://evil"] }, src).ok, false);
  assert.equal(validateChat({ answer: "" }, src).ok, false);
});

test("challenge draft: metric, target and reward inside the Director cap", () => {
  const opts = { metrics: ["tasks_completed", "on_time_tasks", "avg_quality"], cap: { xp: 300, gold: 100 } };
  const ok = { title: "Finish on time", description: "Hit deadlines this week.", type: "weekly", metric: "on_time_tasks", target: 5, rewardXp: 150, why: "On time is 40 %." };
  assert.equal(validateChallengeDraft(ok, opts).ok, true);
  assert.equal(validateChallengeDraft({ ...ok, rewardXp: 900 }, opts).error, "reward");
  assert.equal(validateChallengeDraft({ ...ok, metric: "lines_of_code" }, opts).error, "type/metric");
  assert.equal(validateChallengeDraft({ ...ok, metric: "avg_quality", target: 7 }, opts).error, "target");
  assert.equal(validateChallengeDraft({ ...ok, type: "sprint" }, opts).error, "type/metric");
});

test("neutral wording: explanations and narratives never blame", () => {
  assert.equal(isNeutral("The XP is much higher than this person's usual tasks."), true);
  assert.equal(validateExplain({ explanation: "This looks like cheating by the reviewer, check it." }).ok, false);
  assert.equal(validateExplain({ explanation: "The approval came two minutes after the submission, faster than usual." }).ok, true);
  assert.equal(validateNarrative({ narrative: "short" }).ok, false);
  assert.equal(validateLessonsDraft({ lessons: ["Estimate review time in the plan."] }).ok, true);
  assert.equal(validateLessonsDraft({ lessons: [] }).ok, false);
});

test("daily limit: default 30, org setting, remaining and reset at midnight", () => {
  assert.equal(dailyLimit(null), 30);
  assert.equal(dailyLimit({ aiSettings: { managerDailyLimit: 5 } }), 5);
  assert.equal(dailyLimit({ aiSettings: { managerDailyLimit: -1 } }), 30);
  const now = new Date(2026, 10, 4, 15, 30);
  const u = usageState(31, 30, now);
  assert.equal(u.remaining, 0);
  assert.equal(+u.resetsAt, +new Date(2026, 10, 5));
  assert.equal(usageState(4, 30, now).remaining, 26);
});

test("cache key: stable across query order, changes with the day and the parts", () => {
  assert.equal(cacheKey("report", { org: "o", query: "range=7d&project=p" }), cacheKey("report", { query: "project=p&range=7d", org: "o" }));
  assert.notEqual(cacheKey("insight", { user: "u", day: "2026-11-04" }), cacheKey("insight", { user: "u", day: "2026-11-05" }));
  assert.notEqual(cacheKey("insight", { user: "u", day: "d" }), cacheKey("insight", { user: "v", day: "d" }));
  assert.equal(dayKey(new Date(2026, 10, 4, 23, 59)), "2026-11-04");
});

test("proactive cards come from numbers, at most 4", () => {
  const c = proactiveCards({ overloaded: 2, overdue: 1, openAnomalies: 3, sprintsEndingSoon: [{ id: "s", name: "S1", days: 1, left: 4 }, { id: "t", name: "S2", days: 2, left: 1 }] });
  assert.equal(c.length, 4);
  assert.equal(c[0].text, "2 people are over capacity.");
  assert.deepEqual(proactiveCards({}), []);
});

test("answers show names, not references", () => {
  const names = { m1: "Ana", p2: "Alpha" };
  assert.equal(withNames("- m1 (Ana): over capacity on p2.", names), "- Ana: over capacity on Alpha.");
  assert.equal(withNames("Ana (m1) is over.", names), "Ana is over.");
  assert.equal(withNames("m9 is unknown", names), "m9 is unknown");
  assert.equal(withNames("version 2 of p2", names), "version 2 of Alpha");
});
