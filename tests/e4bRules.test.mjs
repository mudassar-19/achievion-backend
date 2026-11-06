// E-4b: a QA fail is a revision without the Team Lead's penalty or attempt; awardXp counts toward the month; race-free bug cap.
import test from "node:test";
import assert from "node:assert/strict";
import { revisionPlan, revisionEntry } from "../services/reviewRules.js";
import { xpIncrement } from "../services/xpEngine.js";
import { capSlotKeys, xpDay } from "../services/qualityRules.js";

test("revision plan: the Team Lead's send-back costs a try and applies the rejection rule; a QA fail does neither", () => {
  assert.deepEqual(revisionPlan("review"), { countsAttempt: true, penalty: true, limitRequest: true });
  assert.deepEqual(revisionPlan("qa"), { countsAttempt: false, penalty: false, limitRequest: false });
  assert.deepEqual(revisionPlan(undefined), revisionPlan("review")); // default = today's Team Lead behaviour
});

test("revision history entry records who, when, why and where it came from", () => {
  const at = new Date(2026, 10, 6, 12);
  assert.deepEqual(revisionEntry({ by: "tes1", reason: "QA failed: crashes on save.", unmet: [], at, source: "qa" }),
    { type: "revision_requested", comment: "QA failed: crashes on save.", unmetCriteria: [], requestedBy: "tes1", requestedAt: at, source: "qa" });
  assert.equal(revisionEntry({ by: "tl1", reason: "Add tests.", unmet: ["Has tests"], at }).source, "review");
});

test("awardXp increment: total, month and gold move together (the month was missing before E-4b)", () => {
  assert.deepEqual(xpIncrement(15, 7), { totalXp: 15, monthlyXp: 15, gold: 7 });
  assert.deepEqual(xpIncrement(-10, 5), { totalXp: -10, monthlyXp: -10, gold: 0 }); // no gold for a negative amount
  assert.deepEqual(xpIncrement(0, 0), { totalXp: 0, monthlyXp: 0, gold: 0 });
});

test("daily bug cap slots: 5 per reporter per day; slots already used today are skipped", () => {
  const d = new Date(2026, 10, 6, 23, 59);
  assert.equal(xpDay(d), "2026-11-06");
  assert.deepEqual(capSlotKeys("u1", d, 0), ["u1:2026-11-06:1", "u1:2026-11-06:2", "u1:2026-11-06:3", "u1:2026-11-06:4", "u1:2026-11-06:5"]);
  assert.deepEqual(capSlotKeys("u1", d, 3), ["u1:2026-11-06:4", "u1:2026-11-06:5"]);
  assert.deepEqual(capSlotKeys("u1", d, 5), []);
  assert.deepEqual(capSlotKeys("u1", d, 9), []);
  assert.notDeepEqual(capSlotKeys("u2", d, 0), capSlotKeys("u1", d, 0));
});
