// Workload rules (V1 4.2a) — pure, no DB. Run: cd server && node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countWorkingDays, dailyHoursForTask, workloadTier, utilisationPct, teamWeeklyCapacity, availabilityFor, orgWorkTime,
} from "../services/workloadRules.js";

const MON = new Date(2026, 10, 2), FRI = new Date(2026, 10, 6), SUN = new Date(2026, 10, 8);

test("working days follow the org's workingDays (not hard-coded Mon-Fri)", () => {
  assert.equal(countWorkingDays(MON, FRI), 5);
  assert.equal(countWorkingDays(MON, SUN), 5);
  assert.equal(countWorkingDays(MON, SUN, [1, 2, 3, 4, 5, 6]), 6);   // Saturday working
  assert.equal(countWorkingDays(MON, SUN, [0, 1, 2, 3, 4]), 5);      // Sun-Thu week
  assert.equal(countWorkingDays(SUN, SUN), 1);                       // never 0 (avoid ÷0)
});

test("org work time falls back to 7 h × Mon-Fri, and reads the legacy workDays name", () => {
  assert.deepEqual(orgWorkTime(null), { hoursPerDay: 7, workingDays: [1, 2, 3, 4, 5] });
  assert.deepEqual(orgWorkTime({ workingTime: { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5, 6] } }), { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5, 6] });
  assert.deepEqual(orgWorkTime({ workingTime: { hoursPerDay: 6, workDays: [0, 1, 2, 3, 4] } }), { hoursPerDay: 6, workingDays: [0, 1, 2, 3, 4] });
});

test("a multi-day task spreads its hours over the org's working days", () => {
  const task = { estimatedHours: 10, startDate: MON, deadline: FRI };
  assert.equal(dailyHoursForTask(task, MON), 2);
  assert.equal(dailyHoursForTask({ estimatedHours: 6, startDate: MON, deadline: SUN }, MON, [1, 2, 3, 4, 5, 6]), 1);
  assert.equal(dailyHoursForTask({ difficulty: "Hard" }, MON), 6);    // no dates, no estimate → difficulty default, one day
});

test("one tier formula: Free ≤40, Moderate ≤80, Busy ≤100, Critical above", () => {
  assert.equal(workloadTier(40).label, "Free");
  assert.equal(workloadTier(41).label, "Moderate Load");
  assert.equal(workloadTier(100).label, "Busy");
  assert.equal(workloadTier(101).label, "Critical Overload");
  assert.equal(utilisationPct(3.5, 7), 50);
  assert.equal(utilisationPct(3, 0), 0);
});

test("Manager availability uses the engine tier (+ HP burnout)", () => {
  assert.equal(availabilityFor({ workloadTier: "Free", hp: 90 }), "Available");
  assert.equal(availabilityFor({ workloadTier: "Moderate Load", hp: 90 }), "Available");
  assert.equal(availabilityFor({ workloadTier: "Busy", hp: 90 }), "Busy");
  assert.equal(availabilityFor({ workloadTier: "Critical Overload", hp: 90 }), "Overloaded");
  assert.equal(availabilityFor({ workloadTier: "Free", hp: 25 }), "Overloaded"); // below HP_BURNOUT
});

test("heatmap capacity = real member count × hours/day × working days per week", () => {
  assert.equal(teamWeeklyCapacity({ memberCount: 3, hoursPerDay: 7, workingDays: [1, 2, 3, 4, 5] }), 105);
  assert.equal(teamWeeklyCapacity({ memberCount: 0, hoursPerDay: 7, workingDays: [1, 2, 3, 4, 5] }), 0);
  assert.equal(teamWeeklyCapacity({ memberCount: 2, hoursPerDay: 8, workingDays: [0, 1, 2, 3, 4, 5] }), 96);
});
