// Challenges (Quest) + anomaly reversal rules (V2 Phase 3 · M-5).
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateQuestInput, publishBlockers, progressValue, reached, progressPct, nextStatus, dueRewards, editable,
  duplicateOf, rewardCap, periodFor, nextPeriod, MIN_QUALITY_TASKS, countFrom,
} from "../services/questRules.js";
import { flagReason, flagsForAward, reversalPlan } from "../services/anomalyRules.js";

const d = (s) => new Date(`2026-11-${s}Z`);
const ID = "6aeab4127422de422c4af81b";
const base = { title: "Ship on time", type: "custom", metric: "on_time_tasks", target: 5, scope: "organisation", rewardXp: 200, rewardGold: 100, startDate: "2026-11-05", deadline: "2026-11-20" };

test("form: clear errors, team needs a project or team, individual needs a person", () => {
  const { errors } = validateQuestInput({ title: "x", metric: "fun", target: 0, scope: "team", rewardXp: 0, startDate: "2026-11-10", type: "custom", deadline: "2026-11-09" });
  assert.deepEqual(Object.keys(errors).sort(), ["deadline", "metric", "rewardXp", "scopeRef", "target", "title"]);
  assert.match(validateQuestInput({ ...base, scope: "individual" }).errors.scopeRef, /person/);
  const ok = validateQuestInput({ ...base, scope: "team", scopeRef: { kind: "project", id: ID } });
  assert.deepEqual(ok.errors, {}); assert.deepEqual(ok.value.scopeRef, { kind: "project", id: ID });
});

test("reward cap: Director limit (default 500 XP / 250 gold), Manager cannot go above", () => {
  assert.deepEqual(rewardCap(null), { xp: 500, gold: 250 });
  assert.deepEqual(rewardCap({ questRewardCap: { xp: 300, gold: 100 } }), { xp: 300, gold: 100 });
  assert.match(validateQuestInput({ ...base, rewardXp: 501 }).errors.rewardXp, /1 to 500/);
  assert.match(validateQuestInput({ ...base, rewardGold: 300 }, { cap: { xp: 500, gold: 250 } }).errors.rewardGold, /0 to 250/);
  assert.ok(validateQuestInput({ ...base, rewardXp: 300 }, { cap: { xp: 300, gold: 100 } }).errors.rewardXp === undefined);
});

test("active quest: metric/target/scope/rewards are not read (locked)", () => {
  const r = validateQuestInput({ title: "Renamed", type: "custom", startDate: "2026-11-05", deadline: "2026-11-25", metric: "streak_days", target: 99, rewardXp: 9999 }, { locked: true });
  assert.deepEqual(r.errors, {});
  assert.equal("metric" in r.value || "target" in r.value || "rewardXp" in r.value, false);
  assert.deepEqual([editable("draft"), editable("active"), editable("completed")], ["all", "title", "none"]);
});

test("types: daily resets at midnight, weekly on Monday, sprint ends with the sprint, custom keeps its dates", () => {
  assert.deepEqual(periodFor("daily", d("05T15:30:00")), { start: d("05T00:00:00"), end: d("05T23:59:59.999") });
  // 2026-11-05 is a Thursday → week Mon 02 .. Sun 08
  assert.deepEqual(periodFor("weekly", d("05T10:00:00")), { start: d("02T00:00:00"), end: d("08T23:59:59.999") });
  assert.deepEqual(periodFor("weekly", d("02T00:00:00")).start, d("02T00:00:00"));
  assert.deepEqual(periodFor("sprint", d("05T00:00:00"), { sprintEnd: d("18T00:00:00") }), { start: d("05T00:00:00"), end: d("18T23:59:59.999") });
  assert.deepEqual(periodFor("custom", d("05T00:00:00"), { deadline: d("20T00:00:00") }).end, d("20T00:00:00"));
  assert.equal(periodFor("sprint", d("05T00:00:00")), null);
  const daily = validateQuestInput({ ...base, type: "daily", repeat: true, startDate: "2026-11-05", deadline: undefined });
  assert.deepEqual(daily.errors, {}); assert.equal(daily.value.repeat, true);
  assert.deepEqual(daily.value.deadline, d("05T23:59:59.999"));
  assert.equal(validateQuestInput({ ...base, repeat: true }).value.repeat, false, "custom never repeats");
  assert.match(validateQuestInput({ ...base, type: "sprint" }).errors.sprintId, /sprint/);
});

test("repeat: next window after the old one; missed periods jump to today; no repeat → null", () => {
  const q = { type: "daily", repeat: true, deadline: d("05T23:59:59.999") };
  assert.deepEqual(nextPeriod(q, d("06T00:00:01")), { start: d("06T00:00:00"), end: d("06T23:59:59.999") });
  assert.deepEqual(nextPeriod(q, d("09T12:00:00")).start, d("09T00:00:00"));
  assert.deepEqual(nextPeriod({ type: "weekly", repeat: true, deadline: d("08T23:59:59.999") }, d("09T08:00:00")).start, d("09T00:00:00"));
  assert.equal(nextPeriod({ ...q, repeat: false }), null);
  assert.equal(nextPeriod({ type: "custom", repeat: true, deadline: d("05T00:00:00") }), null);
});

test("progress from the ledger: window, on-time, average quality, streak", () => {
  const logs = [
    { createdAt: d("04T10:00:00"), isLate: false, qualityScore: 5 },   // before start
    { createdAt: d("06T10:00:00"), isLate: false, qualityScore: 4 },
    { createdAt: d("07T10:00:00"), isLate: true,  qualityScore: 3 },
    { createdAt: d("08T10:00:00"), isLate: false, qualityScore: 5 },
    { createdAt: d("21T10:00:00"), isLate: false, qualityScore: 5 },   // after deadline
  ];
  const w = { start: d("05T00:00:00"), end: d("20T23:59:59"), streakDays: 6 };
  assert.equal(progressValue("tasks_completed", logs, w), 3);
  assert.equal(progressValue("on_time_tasks", logs, w), 2);
  assert.equal(progressValue("avg_quality", logs, w), 4);
  assert.equal(progressValue("streak_days", logs, w), 6);
  assert.equal(reached("avg_quality", 5, 4.5, 1), false, `needs ${MIN_QUALITY_TASKS} tasks`);
  assert.equal(reached("avg_quality", 4.6, 4.5, 3), true);
  assert.equal(progressPct(7, 5), 100);
});

test("progress counts from publishing, not from earlier in the window", () => {
  assert.deepEqual(countFrom({ startDate: d("02T00:00:00"), publishedAt: d("04T10:00:00") }), d("04T10:00:00"));
  assert.deepEqual(countFrom({ startDate: d("06T00:00:00"), publishedAt: d("04T10:00:00") }), d("06T00:00:00"));
  assert.deepEqual(countFrom({ startDate: d("06T00:00:00") }), d("06T00:00:00"));
});

test("complete: reward once per member; expire takes nothing back", () => {
  const rows = [{ userId: "a", reached: true }, { userId: "b", reached: true }, { userId: "c", reached: false }];
  assert.deepEqual(dueRewards(rows, new Set(["a"])), ["b"]);
  assert.deepEqual(dueRewards(rows, new Set(["a", "b"])), []);
  const q = { status: "active", deadline: d("10T00:00:00") };
  assert.equal(nextStatus(q, { now: d("09T00:00:00") }), "active");
  assert.equal(nextStatus(q, { now: d("11T00:00:00") }), "expired");
  assert.equal(nextStatus(q, { now: d("09T00:00:00"), everyoneDone: true }), "completed");
  assert.equal(nextStatus({ status: "draft" }, { now: d("11T00:00:00") }), "draft");
});

test("publish and duplicate", () => {
  assert.deepEqual(publishBlockers({ status: "draft", deadline: d("20T00:00:00") }, { participants: 3, now: d("05T00:00:00") }), []);
  assert.equal(publishBlockers({ status: "active", deadline: d("02T00:00:00") }, { participants: 0, now: d("05T00:00:00") }).length, 3);
  const copy = duplicateOf({ ...base, type: "weekly", repeat: true, startDate: d("01T00:00:00"), deadline: d("02T00:00:00"), status: "expired" }, d("05T00:00:00"));
  assert.equal(copy.status, "draft"); assert.equal(copy.deadline, null); assert.equal(copy.repeat, true); assert.match(copy.title, /\(copy\)$/);
});

test("anomaly checks on award + neutral wording", () => {
  const f = flagsForAward({ xp: 400, history: [50, 55, 45, 50, 52, 48], stars: 5, submittedAt: d("05T10:00:00"), approvedAt: d("05T10:01:00"),
    recentApprovals: [1, 2, 3].map((i) => ({ approverId: "tl", userId: "u", at: d(`05T10:0${i}:00`) })), userId: "u" });
  assert.deepEqual(f.map((x) => x.kind), ["xp_outlier", "rubber_stamp", "burst"]);
  for (const x of f) { const t = flagReason(x.kind, x.evidence); assert.match(t, /needs review/); assert.doesNotMatch(t, /cheat|fraud|fake/i); }
  assert.deepEqual(flagsForAward({ xp: 50, history: [50, 55], stars: 4 }), []);
  assert.match(flagReason("rubber_stamp", { stars: 5, minutes: 0 }), /within a minute of being submitted/);
});

test("reversal: one negative entry, floors at 0, idempotent", () => {
  const original = { amount: 120, breakdown: { gold: 60 } };
  assert.deepEqual(reversalPlan({ original, profile: { totalXp: 1000, monthlyXp: 80, gold: 30 } }),
    { amount: -120, goldDelta: -30, totalXp: 880, monthlyXp: 0, gold: 0 });
  assert.equal(reversalPlan({ original, profile: { totalXp: 1000 }, alreadyReversed: true }), null);
  assert.equal(reversalPlan({ original: { amount: -10 }, profile: {} }), null, "never reverse a reversal");
  assert.equal(reversalPlan({ original, profile: { totalXp: 50 } }).totalXp, 0);
});
