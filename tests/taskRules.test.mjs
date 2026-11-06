// Task dependency rules (V1 1.9) — pure, no DB. Run: cd server && node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { unfinishedPrereqs, findDependencyCycle, linkErrors, MAX_DEPENDENCIES } from "../services/taskRules.js";

test("start is blocked until every prerequisite is Done", () => {
  assert.deepEqual(unfinishedPrereqs([]), []);
  assert.deepEqual(unfinishedPrereqs([{ _id: "a", title: "A", status: "Done" }]), []);
  assert.deepEqual(
    unfinishedPrereqs([{ _id: "a", title: "A", status: "Done" }, { _id: "b", title: "B", status: "In-Review" }]).map((t) => t.title),
    ["B"],
  );
});

test("cycle detection: A→B, B→C, adding C→A is a cycle", () => {
  const graph = { A: ["B"], B: ["C"], C: [] };
  assert.deepEqual(findDependencyCycle("C", ["A"], graph), ["C", "A", "B", "C"]);
  assert.equal(findDependencyCycle("C", ["X"], graph), null);
  assert.equal(findDependencyCycle("D", ["A", "B"], graph), null);
});

test("link validation: self, duplicates, too many, subtask nesting", () => {
  assert.equal(linkErrors({ selfId: "A", dependsOn: ["A"] }), "A task cannot depend on itself.");
  assert.equal(linkErrors({ selfId: "A", parentId: "A" }), "A task cannot be its own parent.");
  assert.equal(linkErrors({ selfId: "A", dependsOn: Array.from({ length: MAX_DEPENDENCIES + 1 }, (_, i) => `t${i}`) }), `At most ${MAX_DEPENDENCIES} prerequisites per task.`);
  assert.equal(linkErrors({ parent: { parentId: "P0" } }), "Subtasks cannot have their own subtasks (one level only).");
  assert.equal(linkErrors({ selfId: "A", dependsOn: ["B", "C"], parent: { parentId: null } }), null);
});
