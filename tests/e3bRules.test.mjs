// E-3b: review notice goes to the task's own Team Lead (D-182), design handoff to the linked developer task (Q10).
import test from "node:test";
import assert from "node:assert/strict";
import { reviewNoticeTargets, isDesignTask, handoffTargets, handoffEntry } from "../services/submitRules.js";

test("review notice: the module / project Team Leads, else the project's Manager; never another Team Lead of the org", () => {
  assert.deepEqual(reviewNoticeTargets({ leads: ["tl1"], managerId: "m1", seniors: [] }), ["tl1"]);
  assert.deepEqual(reviewNoticeTargets({ leads: [], managerId: "m1", seniors: [] }), ["m1"]);
  assert.deepEqual(reviewNoticeTargets({ leads: [], managerId: null, seniors: [] }), []);
  // A Senior on the same project still gets it (junior → senior review, S-1), with the Team Lead; no duplicates.
  assert.deepEqual(reviewNoticeTargets({ leads: ["tl1", "tl1"], managerId: "m1", seniors: ["s1", "tl1"] }), ["tl1", "s1"]);
  assert.deepEqual(reviewNoticeTargets({ leads: [], managerId: "m1", seniors: ["s1"] }), ["m1", "s1"]);
});

test("design task: type Design or done by a designer", () => {
  assert.equal(isDesignTask({ type: "Design" }, []), true);
  assert.equal(isDesignTask({ type: "Feature" }, ["designer"]), true);
  assert.equal(isDesignTask({ type: "Feature" }, ["developer"]), false);
  assert.equal(isDesignTask({ type: "Bug" }, []), false);
});

test("handoff targets: open tasks that wait for the design task and have a developer on them", () => {
  const dependents = [
    { _id: "d1", status: "To-Do", assignees: ["dev1"] },
    { _id: "d2", status: "Done", assignees: ["dev1"] },
    { _id: "d3", status: "In-Progress", assignees: ["tes1"] },
    { _id: "d4", status: "Backlog", assignees: [], assignee: "dev2" },
    { _id: "d5", status: "To-Do", assignees: ["des2", "dev2"] },
  ];
  const roleOf = new Map([["dev1", "developer"], ["dev2", "developer"], ["tes1", "tester"], ["des2", "designer"]]);
  assert.deepEqual(handoffTargets(dependents, roleOf).map((t) => t._id), ["d1", "d4", "d5"]);
  assert.deepEqual(handoffTargets([], roleOf), []);
});

test("handoff entry: links, files and the handoff note of the approved design; nothing when there is nothing to hand over", () => {
  const t = { _id: "x", title: "Login screens", submissionLinks: [{ label: "Design file or prototype", url: "https://figma.com/f/1" }, { label: "bad", url: "javascript:alert(1)" }],
    submissionFiles: [{ filename: "spec.pdf", url: "/uploads/submissions/1-2.pdf", size: 10 }], submissionHandoff: "  Use the 8px grid.  ", aiScore: 91, tlScore: 88 };
  const e = handoffEntry(t, "Dana", new Date(2026, 10, 6));
  assert.deepEqual(e, { fromTask: "x", fromTitle: "Login screens", by: "Dana", note: "Use the 8px grid.", links: [{ label: "Design file or prototype", url: "https://figma.com/f/1" }],
    files: [{ name: "spec.pdf", url: "/uploads/submissions/1-2.pdf" }], at: new Date(2026, 10, 6) });
  assert.doesNotMatch(JSON.stringify(e), /91|88|aiScore|tlScore/);
  assert.equal(handoffEntry({ _id: "y", title: "Empty", submissionLinks: [], submissionFiles: [], submissionHandoff: "" }, "Dana"), null);
  assert.equal(handoffEntry({ _id: "z", title: "Note only", submissionHandoff: "x".repeat(1200) }, "Dana").note.length, 1000);
});

test("signing a file: allowed when the person may open ANY task that holds it (own submission, attachment or a design handoff)", async () => {
  const { mayOpenAny } = await import("../services/accessRules.js");
  const dev = { id: "dev1", role: "Developer", roleCategory: "developer" };
  const designTask = { task: { assignees: ["des1"], projectId: "pA" }, project: { members: ["des1"] } };   // dev is not on it
  const devTask = { task: { assignees: ["dev1"], projectId: "pB" }, project: { members: ["dev1"] } };     // holds the handoff
  assert.equal(mayOpenAny(dev, [designTask]), false);
  assert.equal(mayOpenAny(dev, [designTask, devTask]), true);
  assert.equal(mayOpenAny(dev, []), false);
  assert.equal(mayOpenAny({ id: "x", role: "Developer", roleCategory: "developer" }, [designTask, devTask]), false);
});

test("the design handoff notification opens the developer's task", async () => {
  const { notifRedirectPath } = await import("../../client/src/utils/notifRoutes.js");
  assert.equal(notifRedirectPath({ type: "design_handoff", meta: { taskId: "d1", fromTaskId: "x" } }, "Senior Developer"), "/workspace/tasks/d1");
});
