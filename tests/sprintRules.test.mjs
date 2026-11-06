// Manager Sprints rules (V2 Phase 3 · M-3).
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSprintInput, overlappingSprints, startBlockers, membershipUpdate, teamCapacity,
  velocity, onTimePct, daysLeft, progressPct, sprintSummary, statusLabel, parseSprintListQuery,
} from "../services/sprintRules.js";

const d = (s) => new Date(`2026-11-${s}T00:00:00Z`);
const P = "6aeab4127422de422c4af81b", T = "6aeab42b7422de422c4af82e";

test("form: end must be after start, project required on create", () => {
  const { errors } = validateSprintInput({ name: "S1", startDate: "2026-11-10", endDate: "2026-11-10" });
  assert.match(errors.endDate, /after the start/);
  assert.match(errors.projectId, /project/);
  const ok = validateSprintInput({ name: " Sprint 1 ", startDate: "2026-11-10", endDate: "2026-11-24", projectId: P });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.value.name, "Sprint 1");
});

test("form: edit ignores the project and still checks dates", () => {
  const r = validateSprintInput({ name: "S", startDate: "x", endDate: "2026-11-24", projectId: P }, { mode: "edit" });
  assert.ok(r.errors.name && r.errors.startDate);
  assert.equal(r.errors.projectId, undefined);
  assert.equal("projectId" in r.value, false);
});

test("overlap: only open sprints whose dates touch, excluding itself", () => {
  const list = [
    { _id: "a", status: "Planning", startDate: d("01"), endDate: d("10") },
    { _id: "b", status: "Completed", startDate: d("05"), endDate: d("15") },
    { _id: "c", status: "Active", startDate: d("20"), endDate: d("30") },
  ];
  assert.deepEqual(overlappingSprints(list, { startDate: d("10"), endDate: d("19") }).map((x) => x._id), ["a"]);
  assert.deepEqual(overlappingSprints(list, { startDate: d("01"), endDate: d("30"), excludeId: "a" }).map((x) => x._id), ["c"]);
});

test("start: TL, >= 1 task and no other active sprint", () => {
  assert.deepEqual(startBlockers({ status: "Planning", teamLeadCount: 1, taskCount: 2 }), []);
  const r = startBlockers({ status: "Planning", teamLeadCount: 0, taskCount: 0, otherActive: "Sprint 1" });
  assert.equal(r.length, 3);
  assert.match(r.join(" "), /no Team Lead/); assert.match(r.join(" "), /at least one task/); assert.match(r.join(" "), /"Sprint 1" is already active/);
  assert.equal(startBlockers({ status: "Active", teamLeadCount: 1, taskCount: 1 }).length, 1);
});

test("planning writes only the sprint's task list, never task fields", () => {
  assert.deepEqual(membershipUpdate("add", T), { $addToSet: { tasks: T } });
  assert.deepEqual(membershipUpdate("remove", T), { $pull: { tasks: T } });
  for (const u of [membershipUpdate("add", T), membershipUpdate("remove", T)]) {
    assert.deepEqual(Object.values(u).flatMap(Object.keys), ["tasks"]);
  }
  assert.equal(membershipUpdate("add", "not-an-id"), null);
  assert.equal(membershipUpdate("set", T), null);
});

test("capacity: working days × hours × people", () => {
  // 2026-11-09 (Mon) .. 2026-11-22 (Sun) = 10 working days
  const c = teamCapacity({ memberCount: 3, hoursPerDay: 7, startDate: d("09"), endDate: d("22") });
  assert.equal(c.days, 10); assert.equal(c.hours, 210);
  assert.equal(teamCapacity({ memberCount: 0, startDate: d("09"), endDate: d("22") }).hours, 0);
});

test("velocity = XP of Done tasks", () => {
  assert.equal(velocity([{ status: "Done", xpValue: 50 }, { status: "Done", xpValue: null }, { status: "In-Progress", xpValue: 80 }]), 50);
  assert.equal(velocity([]), 0);
});

test("on-time %: judged at first submission, tasks without deadline skipped", () => {
  const tasks = [
    { status: "Done", deadline: d("10"), firstSubmittedAt: d("09"), completedAt: d("12") }, // on time (first submit)
    { status: "Done", deadline: d("10"), completedAt: d("11") },                             // late
    { status: "Done", deadline: null, completedAt: d("11") },                                // skipped
    { status: "To-Do", deadline: d("05") },                                                  // not done
  ];
  assert.equal(onTimePct(tasks), 50);
  assert.equal(onTimePct([{ status: "Done", completedAt: d("01") }]), null);
});

test("days left and progress", () => {
  assert.equal(daysLeft(d("20"), d("10")), 10);
  assert.equal(daysLeft(d("01"), d("10")), 0);
  assert.equal(progressPct([{ status: "Done" }, { status: "To-Do" }, { status: "Done" }]), 67);
  assert.equal(progressPct([]), 0);
});

test("summary: numbers, AI average only where the TL scored, contributors, delays", () => {
  const ana = { _id: "u1", name: "Ana" }, bo = { _id: "u2", name: "Bo" };
  const tasks = [
    { _id: "1", title: "A", status: "Done", xpValue: 100, assignees: [ana], deadline: d("10"), completedAt: d("09"), aiScore: 80, tlScore: 70 },
    { _id: "2", title: "B", status: "Done", xpValue: 50, assignees: [bo], assignee: bo, deadline: d("10"), completedAt: d("13"), aiScore: 60, tlScore: null },
    { _id: "3", title: "C", status: "In-Progress", xpValue: 30, assignees: [ana], deadline: d("12") },
    { _id: "4", title: "D", status: "To-Do", xpValue: 30, deadline: d("25") },
  ];
  const s = sprintSummary(tasks, { endDate: d("20") });
  assert.equal(s.planned, 4); assert.equal(s.done, 2); assert.equal(s.unfinished, 2);
  assert.equal(s.velocity, 150); assert.equal(s.onTimePct, 50);
  assert.equal(s.avgAiScore, 80);
  assert.deepEqual(s.topContributors.map((c) => [c.name, c.tasksDone, c.xp]), [["Ana", 1, 100], ["Bo", 1, 50]]);
  assert.deepEqual(s.delays.map((x) => [x.title, x.daysLate, x.done]), [["C", 8, false], ["B", 3, true]]);
  assert.equal(sprintSummary([]).avgAiScore, null);
});

test("labels and list query", () => {
  assert.deepEqual(["Planning", "Active", "Delayed", "Completed"].map(statusLabel), ["Planned", "Active", "Active", "Closed"]);
  const q = parseSprintListQuery({ status: "Planned,Bogus", project: `${P},x`, page: "2" });
  assert.deepEqual(q, { status: ["Planned"], project: [P], page: 2 });
});
