// Project health computed on read (D-077). health = clamp(100 - behind - 50*overdueRatio, 0, 100).
import test from "node:test";
import assert from "node:assert/strict";
import { projectHealth, healthBand } from "../services/projectHealth.js";

const d = (s) => new Date(`2026-11-${s}T00:00:00Z`);
const base = { startDate: d("01"), deadline: d("11"), now: d("06") }; // half the time gone → expected 50 %

test("on schedule, nothing overdue → 100", () => {
  assert.equal(projectHealth({ ...base, progressPct: 50, openTasks: 4, overdueTasks: 0 }).score, 100);
  assert.equal(projectHealth({ ...base, progressPct: 80, openTasks: 4, overdueTasks: 0 }).score, 100); // ahead is not a bonus
});

test("behind schedule subtracts the gap", () => {
  const h = projectHealth({ ...base, progressPct: 20, openTasks: 4, overdueTasks: 0 });
  assert.equal(h.expectedPct, 50);
  assert.equal(h.behind, 30);
  assert.equal(h.score, 70);
});

test("overdue share of open tasks costs up to 50", () => {
  assert.equal(projectHealth({ ...base, progressPct: 50, openTasks: 4, overdueTasks: 2 }).score, 75);
  assert.equal(projectHealth({ ...base, progressPct: 50, openTasks: 4, overdueTasks: 4 }).score, 50);
});

test("past the deadline expected is 100 %; result is clamped to 0", () => {
  const h = projectHealth({ startDate: d("01"), deadline: d("05"), now: d("11"), progressPct: 0, openTasks: 2, overdueTasks: 2 });
  assert.equal(h.expectedPct, 100);
  assert.equal(h.score, 0);
});

test("before the start nothing is expected", () => {
  assert.equal(projectHealth({ startDate: d("10"), deadline: d("20"), now: d("05"), progressPct: 0, openTasks: 3, overdueTasks: 0 }).score, 100);
});

test("missing dates → no schedule penalty; no open tasks → no overdue penalty", () => {
  assert.equal(projectHealth({ progressPct: 0, openTasks: 0, overdueTasks: 0, now: d("06") }).score, 100);
  assert.equal(projectHealth({ startDate: null, deadline: d("11"), now: d("06"), progressPct: 10, openTasks: 0, overdueTasks: 0 }).score, 100);
});

test("bands: >=70 On track, 40-69 At risk, <40 Off track", () => {
  assert.deepEqual([100, 70, 69, 40, 39, 0].map(healthBand), ["On track", "On track", "At risk", "At risk", "Off track", "Off track"]);
});
