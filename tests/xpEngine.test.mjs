// XP engine unit tests — pure functions + schema shape only, no DB, no network.
// Run: cd server && node --test   (Node built-in runner, no extra dependency)
import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import XpLog from "../models/XpLog.js";

mongoose.set("bufferCommands", false); // a query that reached the driver would fail fast instead of hanging

// ── 1.2 double-award guard ────────────────────────────────────────────────────
test("XpLog has a unique {userId, taskId, source} index limited to task approvals", () => {
  const idx = XpLog.schema.indexes().find(([fields]) => fields.userId && fields.taskId && fields.source);
  assert.ok(idx, "index missing");
  const [, opts] = idx;
  assert.equal(opts.unique, true);
  assert.deepEqual(opts.partialFilterExpression, { source: "task_approved", taskId: { $type: "objectId" } });
});

// ── 1.3 XpLog immutable ───────────────────────────────────────────────────────
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete", "replaceOne"]) {
  test(`XpLog.${op} is blocked (append-only)`, async () => {
    await assert.rejects(() => XpLog[op]({}, op.startsWith("delete") || op === "findOneAndDelete" ? undefined : { amount: 1 }), /append-only/);
  });
}

// ── Pure XP engine (D-056, D-057, D-058, D-064, D-066, V1 1.11) ───────────────
import {
  calculateTaskXP, levelFromTotalXp, scoreToStars, lateAtSubmission, streakWindow, crossedBurnout,
  PRIORITY_BASE_XP, HP_BURNOUT,
} from "../services/xpEngine.js";

const DEADLINE = new Date("2026-11-10T12:00:00Z");
const hoursBefore = (h) => new Date(DEADLINE.getTime() - h * 3_600_000);
const base = (over = {}) => ({ submittedAt: hoursBefore(2), isLate: false, qualityStars: 3, streakDays: 0, orgRules: null,
  ...over, task: { priority: "Medium", type: "Feature", deadline: DEADLINE, ...over.task } });

test("D-066: xpValue is the base (TC-GX-01: 200 → 200 base)", () => {
  const r = calculateTaskXP(base({ task: { xpValue: 200 } }));
  assert.equal(r.base, 200);
  assert.equal(r.finalXP, 240); // 200 × 1.20 on time × 1.00 quality 3
});

test("D-066: missing xpValue falls back to priority table", () => {
  assert.deepEqual(PRIORITY_BASE_XP, { Critical: 100, High: 75, Medium: 50, Low: 25 });
  assert.equal(calculateTaskXP(base({ task: { priority: "High" } })).base, 75);
  assert.equal(calculateTaskXP(base({ task: { priority: "Nope" } })).base, 50);
});

test("early bonus: >= 24h before deadline adds +0.10", () => {
  const r = calculateTaskXP(base({ task: { xpValue: 100 }, submittedAt: hoursBefore(30) }));
  assert.equal(r.finalXP, 130);
});

test("D-056: late from the first late task = ×0.85 and −5 HP, no warning-only rule", () => {
  const r = calculateTaskXP(base({ task: { xpValue: 100 }, isLate: true, submittedAt: hoursBefore(-5) }));
  assert.equal(r.finalXP, 85);      // 100 × 1.00 (no on-time bonus) × 0.85
  assert.equal(r.hpDelta, -5);
  assert.equal(calculateTaskXP(base({ task: { xpValue: 100 } })).hpDelta, 0);
});

test("D-064: quality stars drive the existing multiplier table", () => {
  assert.equal(calculateTaskXP(base({ task: { xpValue: 100 }, qualityStars: 5 })).finalXP, 156); // 100×1.2×1.3
  assert.equal(calculateTaskXP(base({ task: { xpValue: 100 }, qualityStars: 1 })).finalXP, 84);  // 100×1.2×0.7
});

test("1.11a: streak bonus is the org multiplier (default 1.1), never ×5", () => {
  assert.equal(calculateTaskXP(base({ task: { xpValue: 100 }, streakDays: 3 })).finalXP, 132);
  assert.equal(calculateTaskXP(base({ task: { xpValue: 100 }, streakDays: 3, orgRules: { streakBonus: 1.5 } })).finalXP, 180);
});

test("floor 0: XP and gold never negative", () => {
  const r = calculateTaskXP(base({ task: { xpValue: 100 }, orgRules: { xpMultipliers: { Feature: -2 } } }));
  assert.equal(r.finalXP, 0);
  assert.equal(r.gold, 0);
});

test("1.11f: gold = floor(finalXP × 0.5)", () => {
  assert.equal(calculateTaskXP(base({ task: { xpValue: 75 } })).gold, 45); // 75×1.2=90 → 45
  assert.equal(calculateTaskXP(base({ task: { xpValue: 51 } })).gold, 30); // 61 → 30
});

test("D-058: level L→L+1 costs L×1000, no cap", () => {
  assert.deepEqual(levelFromTotalXp(0),     { level: 1, currentXp: 0,    maxXp: 1000 });
  assert.deepEqual(levelFromTotalXp(999),   { level: 1, currentXp: 999,  maxXp: 1000 });
  assert.deepEqual(levelFromTotalXp(1000),  { level: 2, currentXp: 0,    maxXp: 2000 });
  assert.deepEqual(levelFromTotalXp(3000),  { level: 3, currentXp: 0,    maxXp: 3000 });
  assert.deepEqual(levelFromTotalXp(5999),  { level: 3, currentXp: 2999, maxXp: 3000 });
  assert.equal(levelFromTotalXp(45000).level, 10);
  assert.equal(levelFromTotalXp(500 * 60 * 59).level, 60);
  assert.equal(levelFromTotalXp(-50).level, 1);
});

test("D-064: score 0-100 → stars", () => {
  assert.equal(scoreToStars(0), 1);
  assert.equal(scoreToStars(49), 2);
  assert.equal(scoreToStars(50), 3);  // 2.5 rounds up
  assert.equal(scoreToStars(89), 4);
  assert.equal(scoreToStars(100), 5);
  assert.equal(scoreToStars(null), null);
  assert.equal(scoreToStars("x"), null);
});

test("D-057: lateness is fixed at the first submission", () => {
  const now = new Date("2026-11-12T00:00:00Z"); // after deadline
  assert.deepEqual(lateAtSubmission({ deadline: DEADLINE }, hoursBefore(1)), { firstSubmittedAt: hoursBefore(1), isLate: false });
  assert.deepEqual(lateAtSubmission({ deadline: DEADLINE }, now), { firstSubmittedAt: now, isLate: true });
  // resubmission after deadline keeps the first verdict
  const first = { deadline: DEADLINE, firstSubmittedAt: hoursBefore(1), isLate: false };
  assert.deepEqual(lateAtSubmission(first, now), { firstSubmittedAt: hoursBefore(1), isLate: false });
  assert.deepEqual(lateAtSubmission({ deadline: null }, now), { firstSubmittedAt: now, isLate: false });
});

test("1.11b: streak cron checks the day that just ended", () => {
  const { start, end, isWorkingDay } = streakWindow(new Date(2026, 10, 3, 0, 0, 5)); // Tue 00:00:05 local
  assert.deepEqual([start.getDate(), start.getHours(), end.getDate(), end.getHours()], [2, 0, 3, 0]);
  assert.equal(isWorkingDay, true); // Monday
  assert.equal(streakWindow(new Date(2026, 10, 2, 0, 0, 5)).isWorkingDay, false); // window = Sunday
});

test("1.11e: burnout notice only when HP crosses below 30", () => {
  assert.equal(HP_BURNOUT, 30);
  assert.equal(crossedBurnout(32, 27), true);
  assert.equal(crossedBurnout(27, 22), false);
  assert.equal(crossedBurnout(40, 30), false);
});

// ── 1.5 deadline alert, 1.6 missed-deadline HP ────────────────────────────────
import { deadlineAlertDue, missedDeadlinePenalty, MISSED_DEADLINE_HP } from "../services/xpEngine.js";

test("1.5: alert once when an open task is due within 24 h", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  const due = (h, extra = {}) => ({ status: "In-Progress", deadline: new Date(now.getTime() + h * 3_600_000), ...extra });
  assert.equal(deadlineAlertDue(due(10), now), true);
  assert.equal(deadlineAlertDue(due(30), now), false);                         // too early
  assert.equal(deadlineAlertDue(due(-1), now), false);                         // already past
  assert.equal(deadlineAlertDue(due(10, { deadlineAlertSentAt: now }), now), false); // sent
  assert.equal(deadlineAlertDue(due(10, { status: "In-Review" }), now), false);
  assert.equal(deadlineAlertDue(due(10, { status: "Done" }), now), false);
  assert.equal(deadlineAlertDue({ status: "To-Do", deadline: null }, now), false);
});

test("1.6: missed deadline costs HP once, only while work is still open", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  const past = new Date(now.getTime() - 3_600_000);
  assert.equal(MISSED_DEADLINE_HP, 5);
  assert.equal(missedDeadlinePenalty({ status: "In-Progress", deadline: past }, now), true);
  assert.equal(missedDeadlinePenalty({ status: "To-Do", deadline: past }, now), true);
  assert.equal(missedDeadlinePenalty({ status: "In-Progress", deadline: past, overduePenaltyAt: now }, now), false);
  assert.equal(missedDeadlinePenalty({ status: "In-Review", deadline: past }, now), false); // submitted (late handled at approval)
  assert.equal(missedDeadlinePenalty({ status: "In-Progress", deadline: new Date(now.getTime() + 1) }, now), false);
});

test("1.6: late approval skips the HP hit when the miss was already charged", () => {
  const base = { task: { xpValue: 100, priority: "Low", type: "Feature" }, isLate: true, qualityStars: 3 };
  assert.equal(calculateTaskXP(base).hpDelta, -5);
  assert.equal(calculateTaskXP({ ...base, task: { ...base.task, overduePenaltyAt: new Date() } }).hpDelta, 0);
  assert.equal(calculateTaskXP({ ...base, task: { ...base.task, overduePenaltyAt: new Date() } }).finalXP, 85); // XP still −15 %
});
