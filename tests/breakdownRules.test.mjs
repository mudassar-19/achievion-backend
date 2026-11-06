// Team Lead T-3: realism check (D-012, D-017, D-072) and breakdown rules (AI reply validator, benchmark, Apply).
import test from "node:test";
import assert from "node:assert/strict";
import { realismCheck } from "../services/realismRules.js";
import { validateBreakdownReply, validateBenchmarkReply, validateApplyRows, MAX_APPLY_ROWS } from "../services/breakdownRules.js";

const wt = { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5] };
const today = new Date(2026, 10, 2); // Monday 2 Nov 2026
const fri = new Date(2026, 10, 6);   // 5 working days incl. today
const team = [
  { id: "a", name: "Ana", roleCategory: "developer", capacityPerDay: 8, allocatedPerDay: 2 },
  { id: "b", name: "Bo", roleCategory: "tester", capacityPerDay: 8, allocatedPerDay: 0 },
];
const row = (key, hours, extra = {}) => ({ key, title: `Task ${key}`, hours, type: "Feature", acceptanceCriteria: ["done"], ...extra });

test("realism: empty draft", () => {
  const r = realismCheck({ rows: [], team, workTime: wt, today, deadline: fri });
  assert.equal(r.verdict, "empty");
});

test("realism: fits — numbers from capacity, existing load and working days (weekends skipped)", () => {
  const r = realismCheck({ rows: [row("1", 10), row("2", 6, { type: "Testing" })], team, workTime: wt, today, deadline: fri });
  assert.equal(r.totals.days, 5);
  assert.equal(r.totals.capacityHours, 80);   // 2 people × 8 h × 5 days
  assert.equal(r.totals.existingHours, 10);   // Ana 2 h/day × 5
  assert.equal(r.totals.freeHours, 70);
  assert.equal(r.totals.taskHours, 16);
  assert.equal(r.verdict, "fits");
});

test("realism: over capacity → verdict over + suggestions", () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(String(i), 13, i === 0 ? { type: "Testing" } : {}));
  const r = realismCheck({ rows, team, workTime: wt, today, deadline: fri });
  assert.equal(r.verdict, "over");
  assert.deepEqual(r.suggestions, ["reduce_scope", "request_deadline", "add_person"]);
  assert.ok(r.issues.some((i) => i.code === "over_capacity"));
});

test("realism: deadline too tight (passed or tomorrow-ish) → over / tight", () => {
  assert.equal(realismCheck({ rows: [row("1", 8, { type: "Testing" })], team, workTime: wt, today, deadline: new Date(2026, 10, 1) }).verdict, "over");
  const tight = realismCheck({ rows: [row("1", 12), row("2", 12, { type: "Testing" })], team, workTime: wt, today, deadline: today });
  assert.equal(tight.totals.freeHours, 14); // 16 capacity − 2 Ana's load, one day
  assert.equal(tight.verdict, "over");
  const r = realismCheck({ rows: [row("1", 13, { type: "Testing" })], team, workTime: wt, today, deadline: today });
  assert.equal(r.verdict, "tight"); // 13 of 14 free hours (> 85 %)
});

test("realism: no deadline → cannot judge capacity", () => {
  const r = realismCheck({ rows: [row("1", 4, { type: "Testing" })], team, workTime: wt, today, deadline: null });
  assert.equal(r.verdict, "no_deadline");
});

test("realism: D-012 per row — over 14 h split, under 1 h merge, missing estimate", () => {
  const r = realismCheck({ rows: [row("big", 20), row("tiny", 0.5), row("none", null, { type: "Testing" })], team, workTime: wt, today, deadline: fri });
  const codes = Object.fromEntries(r.issues.filter((i) => i.rowKey).map((i) => [i.rowKey, i.code]));
  assert.equal(codes.big, "split");
  assert.equal(codes.tiny, "merge");
  assert.equal(codes.none, "missing_estimate");
  assert.ok(r.issues.find((i) => i.rowKey === "big").message.includes("Split suggested"));
  assert.equal(r.blocking, true); // Apply is refused while D-012 errors remain
});

test("realism: QA missing and missing acceptance criteria are warnings", () => {
  const r = realismCheck({ rows: [row("1", 4, { acceptanceCriteria: [] })], team, workTime: wt, today, deadline: fri });
  assert.ok(r.issues.some((i) => i.code === "qa_missing" && i.level === "warning"));
  assert.ok(r.issues.some((i) => i.code === "missing_criteria" && i.rowKey === "1"));
  assert.equal(r.blocking, false);
  const withQa = realismCheck({ rows: [row("1", 4, { qaRequired: true })], team, workTime: wt, today, deadline: fri });
  assert.ok(!withQa.issues.some((i) => i.code === "qa_missing"));
});

test("realism: per-assignee overload uses 'Over capacity ×N'", () => {
  const r = realismCheck({ rows: [row("1", 12, { assigneeId: "a" }), row("2", 12, { assigneeId: "a" }), row("3", 12, { assigneeId: "a", type: "Testing" })], team, workTime: wt, today, deadline: new Date(2026, 10, 3) });
  const ana = r.people.find((p) => p.id === "a");
  assert.equal(ana.addedHours, 36);
  assert.equal(ana.afterPct, 250); // (2×2 + 36) / (8×2)
  assert.equal(ana.label, "Over capacity ×2.5");
  assert.ok(r.issues.some((i) => i.code === "person_over" && i.message.includes("Over capacity ×2.5")));
});

// ── AI reply validator ───────────────────────────────────────────────────────
const existing = new Map([["e1", "6aeab4127422de422c4af81b"]]);
const reply = { tasks: [
  { title: "Design login screen", type: "Design", hours: 6, difficulty: "Medium", dependsOn: [], acceptanceCriteria: ["Mobile and desktop"], benchmark: "Matches the style guide" },
  { title: "Build login API", type: "Feature", hours: 30, difficulty: "Hard", dependsOn: ["r1", "e1"], acceptanceCriteria: [], benchmark: "" },
] };

test("AI reply: hours clamped to 1-14 (D-012), refs resolved to rows / existing tasks", () => {
  const v = validateBreakdownReply(reply, { existing, maxRows: 15 });
  assert.equal(v.ok, true);
  assert.equal(v.value[1].hours, 14);
  assert.equal(v.value[1].clamped, true);
  assert.deepEqual(v.value[1].dependsOn, [{ row: 0 }, { taskId: "6aeab4127422de422c4af81b" }]);
});

test("AI reply: invented ids, self reference, bad type, too many rows → rejected", () => {
  assert.equal(validateBreakdownReply({ tasks: [{ ...reply.tasks[0], dependsOn: ["e9"] }] }, { existing }).error, "invented id");
  assert.equal(validateBreakdownReply({ tasks: [{ ...reply.tasks[0], dependsOn: ["6aeab4127422de422c4af81b"] }] }, { existing }).error, "invented id");
  assert.equal(validateBreakdownReply({ tasks: [{ ...reply.tasks[0], dependsOn: ["r1"] }] }, { existing }).error, "self");
  assert.ok(validateBreakdownReply({ tasks: [{ ...reply.tasks[0], type: "Spaceship" }] }, { existing }).error);
  assert.ok(validateBreakdownReply({ tasks: Array(16).fill(reply.tasks[0]) }, { existing, maxRows: 15 }).error);
  assert.ok(validateBreakdownReply({ tasks: [] }, { existing }).error);
});

test("benchmark reply: 10-600 characters, neutral", () => {
  assert.equal(validateBenchmarkReply({ benchmark: "Page loads in under 2 s on 4G; no console errors." }).ok, true);
  assert.equal(validateBenchmarkReply({ benchmark: "ok" }).ok, false);
  assert.equal(validateBenchmarkReply({ benchmark: "x".repeat(601) }).ok, false);
});

// ── Apply ────────────────────────────────────────────────────────────────────
const teamIds = new Set(["6aeab4127422de422c4af8a1"]);
const good = (key, extra = {}) => ({ key, title: `Apply ${key}`, type: "Feature", priority: "Medium", difficulty: "Medium", hours: 4, ...extra });

test("Apply: 1 to 60 rows; every row valid (D-012 included) or nothing", () => {
  assert.ok(validateApplyRows([], { teamIds }).error);
  assert.ok(validateApplyRows(Array.from({ length: MAX_APPLY_ROWS + 1 }, (_, i) => good(String(i))), { teamIds }).error);
  const bad = validateApplyRows([good("1"), good("2", { hours: 20 })], { teamIds });
  assert.equal(bad.ok, false);
  assert.equal(bad.rowErrors["2"].estimatedHours, "Estimate 1 to 14 hours. Bigger work: split it into smaller tasks.");
  assert.equal(validateApplyRows([good("1", { assigneeId: "6aeab4127422de422c4af8ff" })], { teamIds }).rowErrors["1"].assignee, "This person is not in your team on this project.");
});

test("Apply: dependencies between rows resolve; unknown row / cycle rejected", () => {
  const ok = validateApplyRows([good("a"), good("b", { dependsOn: ["row:a"] })], { teamIds });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value[1].dependsOnRows, ["a"]);
  assert.equal(validateApplyRows([good("a", { dependsOn: ["row:zz"] })], { teamIds }).rowErrors.a.dependsOn, "Depends on a row that is not in the draft.");
  assert.ok(validateApplyRows([good("a", { dependsOn: ["row:b"] }), good("b", { dependsOn: ["row:a"] })], { teamIds }).error.includes("loop"));
  const ex = validateApplyRows([good("a", { dependsOn: ["task:6aeab4127422de422c4af81b"] })], { teamIds, existingIds: new Set(["6aeab4127422de422c4af81b"]) });
  assert.deepEqual(ex.value[0].dependsOnTasks, ["6aeab4127422de422c4af81b"]);
  assert.ok(validateApplyRows([good("a", { dependsOn: ["task:6aeab4127422de422c4af8ff"] })], { teamIds, existingIds: new Set() }).rowErrors.a.dependsOn);
});
