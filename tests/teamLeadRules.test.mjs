// Team Lead portal (V2 Phase 4 · T-1): board/status rule (no Done by drag), team scope, list query, labels.
import test from "node:test";
import assert from "node:assert/strict";
import { statusMoveBlocker, teamOf, parseTaskQuery, moduleState, alertLabel } from "../services/teamLeadRules.js";

const tl = { role: "Team Lead", roleCategory: "team_lead" };
const dev = { role: "Developer", roleCategory: "developer" };

test("Team Lead cannot move a task to Done (only review approval does)", () => {
  for (const from of ["Backlog", "To-Do", "In-Progress", "In-Review"]) assert.equal(statusMoveBlocker({ ...tl, from, to: "Done" }).status, 403);
  assert.equal(statusMoveBlocker({ role: "Manager", from: "In-Progress", to: "Done" }).status, 403);
  assert.equal(statusMoveBlocker({ ...dev, from: "In-Review", to: "Done", isAssignee: true }).status, 403);
});

test("Team Lead: plans Backlog / To-Do / In-Progress; never moves In-Review or Done", () => {
  assert.equal(statusMoveBlocker({ ...tl, from: "Backlog", to: "To-Do" }), null);
  assert.equal(statusMoveBlocker({ ...tl, from: "In-Progress", to: "To-Do" }), null);
  assert.equal(statusMoveBlocker({ ...tl, from: "In-Review", to: "In-Progress" }).status, 403);
  assert.equal(statusMoveBlocker({ ...tl, from: "In-Progress", to: "In-Review" }).status, 403);
  assert.equal(statusMoveBlocker({ ...tl, from: "Done", to: "To-Do" }).status, 403);
});

test("employees: own tasks, forward only", () => {
  assert.equal(statusMoveBlocker({ ...dev, from: "To-Do", to: "In-Progress", isAssignee: true }), null);
  assert.equal(statusMoveBlocker({ ...dev, from: "In-Progress", to: "In-Review", isAssignee: true }), null);
  assert.equal(statusMoveBlocker({ ...dev, from: "To-Do", to: "In-Progress", isAssignee: false }).status, 403);
  assert.equal(statusMoveBlocker({ ...dev, from: "In-Progress", to: "To-Do", isAssignee: true }).status, 403);
  assert.equal(statusMoveBlocker({ ...dev, from: "To-Do", to: "Shipped", isAssignee: true }).status, 400);
});

test("team = project members minus leaders and the TL", () => {
  const t = teamOf([{ members: [{ _id: "tl", role: "Team Lead" }, { _id: "a", role: "Developer" }, { _id: "m", role: "Manager" }] },
    { members: [{ _id: "a", role: "Developer" }, { _id: "b", role: "Senior Tester" }, { _id: "t2", role: "Team Lead" }] }], "tl");
  assert.deepEqual([...t.keys()].sort(), ["a", "b"]);
});

test("task list query: safe defaults, ids only, page bounds", () => {
  assert.deepEqual(parseTaskQuery({}), { tab: "all", status: null, assignee: null, module: null, overdue: false, page: 1, search: "" });
  const q = parseTaskQuery({ tab: "review", status: "Done", assignee: "6aeab4127422de422c4af81b", module: "{$ne:1}", overdue: "1", page: "-3" });
  assert.equal(q.tab, "review"); assert.equal(q.status, "Done"); assert.equal(q.module, null); assert.equal(q.overdue, true); assert.equal(q.page, 1);
  assert.equal(parseTaskQuery({ tab: "drop", status: "Hacked" }).tab, "all");
  assert.equal(parseTaskQuery({ assignee: "none" }).assignee, "none");
});

test("module state and alert wording", () => {
  assert.equal(moduleState({ kind: "module", acceptedAt: null }), "New");
  assert.equal(moduleState({ kind: "module", acceptedAt: new Date(), progress: 100 }), "Completed");
  assert.equal(moduleState({ kind: "project", status: "Active", progress: 20 }), "In progress");
  assert.equal(alertLabel(1), "1 alert");
  assert.equal(alertLabel(3), "3 alerts");
});
