// Team Lead T-2 task rules (D-118, D-012): form validation, group assign, delete, dependencies, saved filters, bulk.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateTaskInput, groupTasks, canDeleteTask, unblockedTasks, isBlocked, validateSavedFilter, validateBulk, MAX_SAVED_FILTERS,
} from "../services/taskFormRules.js";

const ok = { title: "Login form", type: "Feature", priority: "High", estimatedHours: 6, difficulty: "Medium" };

test("D-012: estimate must be 1 to 14 hours", () => {
  assert.equal(validateTaskInput({ ...ok, estimatedHours: 0.5 }).errors.estimatedHours, "Estimate 1 to 14 hours. Smaller work: merge it into another task.");
  assert.equal(validateTaskInput({ ...ok, estimatedHours: 15 }).errors.estimatedHours, "Estimate 1 to 14 hours. Bigger work: split it into smaller tasks.");
  assert.equal(validateTaskInput({ ...ok, estimatedHours: "" }).errors.estimatedHours, "Give an estimate in hours (1 to 14).");
  assert.equal(validateTaskInput({ ...ok, estimatedHours: 14 }).errors.estimatedHours, undefined);
});

test("title, type, priority, difficulty, dates, xp", () => {
  const e = validateTaskInput({ title: "x", type: "Spaceship", priority: "Urgent", estimatedHours: 2, difficulty: "Insane", startDate: "2026-12-10", deadline: "2026-12-01", xpValue: 5 }).errors;
  assert.ok(e.title && e.type && e.priority && e.difficulty && e.deadline && e.xpValue);
  assert.deepEqual(validateTaskInput(ok).errors, {});
});

test("quality fields: up to 10 criteria of 200 chars, benchmark up to 1000, QA flag boolean", () => {
  const v = validateTaskInput({ ...ok, acceptanceCriteria: [" Shows errors inline ", "", "Works on mobile"], benchmark: "Lighthouse ≥ 90", qaRequired: "true" }).value;
  assert.deepEqual(v.acceptanceCriteria, ["Shows errors inline", "Works on mobile"]);
  assert.equal(v.benchmark, "Lighthouse ≥ 90");
  assert.equal(v.qaRequired, true);
  assert.ok(validateTaskInput({ ...ok, acceptanceCriteria: Array(11).fill("a b c") }).errors.acceptanceCriteria);
  assert.ok(validateTaskInput({ ...ok, benchmark: "x".repeat(1001) }).errors.benchmark);
});

test("tags: lowercase, unique, max 5 of 24 chars", () => {
  assert.deepEqual(validateTaskInput({ ...ok, tags: ["UI", "ui", " Login ", "a".repeat(30)] }).value.tags, ["ui", "login"]);
  assert.ok(validateTaskInput({ ...ok, tags: ["a", "b", "c", "d", "e", "f"] }).errors.tags);
});

test("edit mode: only sent fields are checked and returned", () => {
  const r = validateTaskInput({ priority: "Low" }, { mode: "edit" });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.value, { priority: "Low" });
  assert.ok(validateTaskInput({ estimatedHours: 20 }, { mode: "edit" }).errors.estimatedHours);
});

test("D-118 group assign: one independent task per member, same group tag, duplicates removed", () => {
  const out = groupTasks({ title: "Write tests", estimatedHours: 3 }, ["a", "b", "a"], "grp-1");
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((t) => t.assigneeId), ["a", "b"]);
  assert.ok(out.every((t) => t.groupTag === "grp-1" && t.title === "Write tests" && t.estimatedHours === 3));
  assert.notEqual(out[0], out[1]); // separate objects
});

test("delete only Backlog / To-Do", () => {
  assert.equal(canDeleteTask("Backlog"), true);
  assert.equal(canDeleteTask("To-Do"), true);
  for (const s of ["In-Progress", "In-Review", "Done"]) assert.equal(canDeleteTask(s), false);
});

test("dependencies: blocked until every prerequisite is Done; Done unblocks only fully free tasks", () => {
  const status = new Map([["p1", "Done"], ["p2", "In-Progress"]]);
  assert.equal(isBlocked({ dependsOn: ["p1"] }, status), false);
  assert.equal(isBlocked({ dependsOn: ["p1", "p2"] }, status), true);
  const deps = [{ id: "t1", status: "To-Do", dependsOn: ["p1"] }, { id: "t2", status: "To-Do", dependsOn: ["p1", "p2"] }, { id: "t3", status: "Done", dependsOn: ["p1"] }];
  assert.deepEqual(unblockedTasks("p1", deps, status), ["t1"]);
});

test("saved filters: name 1-40, query only known keys, at most 10", () => {
  const r = validateSavedFilter({ name: " Overdue mine ", query: "overdue=1&evil=$where&tab=created&status=To-Do" }, 3);
  assert.deepEqual(r.value, { name: "Overdue mine", query: "overdue=1&tab=created&status=To-Do" });
  assert.ok(validateSavedFilter({ name: "", query: "tab=all" }, 0).error);
  assert.equal(validateSavedFilter({ name: "x", query: "tab=all" }, MAX_SAVED_FILTERS).error, "You can keep 10 saved filters. Delete one first.");
});

test("bulk: known action, 1-100 ids, value checked per action", () => {
  const id = "6aeab4127422de422c4af81b";
  assert.equal(validateBulk({ ids: [id], action: "priority", value: "High" }).ok, true);
  assert.ok(validateBulk({ ids: [], action: "priority", value: "High" }).error);
  assert.ok(validateBulk({ ids: ["x"], action: "priority", value: "High" }).error);
  assert.ok(validateBulk({ ids: [id], action: "priority", value: "Mega" }).error);
  assert.ok(validateBulk({ ids: [id], action: "drop", value: 1 }).error);
  assert.equal(validateBulk({ ids: [id], action: "tag", value: " Urgent " }).value, "urgent");
  assert.ok(validateBulk({ ids: [id], action: "deadline", value: "not a date" }).error);
  assert.equal(validateBulk({ ids: [id], action: "assign", value: id }).ok, true);
});
