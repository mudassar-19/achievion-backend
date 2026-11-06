// T-4: review, QA sign-off, handoff chain and comment rules (pure).
import test from "node:test";
import assert from "node:assert/strict";
import { isSelfReview, qaState, approvalBlock, validateApproval, validateRevision, aiStatus, rubberStampWarning, gapInfo, queueView, revisionUpdate, canTakeSignoff, validateSignoff } from "../services/reviewRules.js";
import { handoffChain } from "../services/handoffRules.js";
import { mentionedIds, REACTIONS, toggleReaction, canChangeComment } from "../services/commentRules.js";

const T0 = new Date("2026-11-05T10:00:00Z");
const task = (o = {}) => ({ status: "In-Review", assignee: "dev", assignees: ["dev"], qaRequired: false, qaSignoffs: [], submittedAt: T0, ...o });

test("self review: an assignee cannot approve their own task", () => {
  assert.equal(isSelfReview(task(), "dev"), true);
  assert.equal(isSelfReview(task({ assignee: null, assignees: ["a", "b"] }), "b"), true);
  assert.equal(isSelfReview(task(), "tl"), false);
  const b = approvalBlock({ task: task(), reviewerId: "dev" });
  assert.equal(b.status, 403); assert.equal(b.code, "self_review");
});

test("QA state: only a pass after the latest submission counts", () => {
  assert.equal(qaState(task()).state, "not_required");
  assert.equal(qaState(task({ qaRequired: true })).state, "waiting");
  const at = new Date(T0.getTime() + 60_000);
  assert.equal(qaState(task({ qaRequired: true, qaSignoffs: [{ by: "t", at, result: "pass" }] })).state, "passed");
  assert.equal(qaState(task({ qaRequired: true, qaSignoffs: [{ by: "t", at, result: "fail" }] })).state, "failed");
  // the newest record wins
  assert.equal(qaState(task({ qaRequired: true, qaSignoffs: [{ by: "t", at, result: "pass" }, { by: "t", at: new Date(at.getTime() + 1000), result: "fail" }] })).state, "failed");
  // resubmitted after a pass: it must be signed again
  assert.equal(qaState(task({ qaRequired: true, submittedAt: new Date(at.getTime() + 5000), qaSignoffs: [{ by: "t", at, result: "pass" }] })).state, "waiting");
  assert.equal(qaState(task({ qaRequired: true, status: "Done", qaConditional: { by: "tl", at, reason: "x" } })).state, "conditional");
});

test("QA gate: approve blocked until a pass; conditional only when the sign-off is missing", () => {
  const needs = task({ qaRequired: true });
  const b = approvalBlock({ task: needs, reviewerId: "tl" });
  assert.equal(b.status, 409); assert.equal(b.code, "qa_required");
  assert.equal(approvalBlock({ task: needs, reviewerId: "tl", conditional: true }), null);
  const failed = task({ qaRequired: true, qaSignoffs: [{ by: "t", at: new Date(T0.getTime() + 1000), result: "fail" }] });
  assert.equal(approvalBlock({ task: failed, reviewerId: "tl" }).code, "qa_failed");
  assert.equal(approvalBlock({ task: failed, reviewerId: "tl", conditional: true }).code, "qa_failed", "T-5: after a fail only Request revision is left");
  assert.equal(approvalBlock({ task: failed, reviewerId: "tl", conditional: true }).status, 409);
  const passed = task({ qaRequired: true, qaSignoffs: [{ by: "t", at: new Date(T0.getTime() + 1000), result: "pass" }] });
  assert.equal(approvalBlock({ task: passed, reviewerId: "tl" }), null);
  assert.equal(approvalBlock({ task: passed, reviewerId: "tl", conditional: true }).code, "qa_not_missing");
  assert.equal(approvalBlock({ task: task(), reviewerId: "tl", conditional: true }).code, "qa_not_missing");
  assert.equal(approvalBlock({ task: task(), reviewerId: "dev", conditional: true }).code, "self_review");
});

test("XP once: only an In-Review task can be approved", () => {
  const b = approvalBlock({ task: task({ status: "Done" }), reviewerId: "tl" });
  assert.equal(b.status, 409); assert.equal(b.code, "not_in_review");
});

test("approval input: whole score 0-100 required; conditional needs a reason", () => {
  assert.equal(validateApproval({ score: 80 }).value.stars, 4);
  assert.equal(validateApproval({ score: 0 }).value.stars, 1);
  assert.ok(validateApproval({}).error);
  assert.ok(validateApproval({ score: 101 }).error);
  assert.ok(validateApproval({ score: 80, conditional: true }).error);
  assert.ok(validateApproval({ score: 80, conditional: true, reason: "   " }).error);
  assert.equal(validateApproval({ score: 80, conditional: true, reason: "Tester on leave" }).value.reason, "Tester on leave");
  assert.ok(validateApproval({ score: 80, feedback: "x".repeat(2001) }).error);
});

test("revision: reason required, unmet criteria must be on the task, goes back to In-Progress", () => {
  const criteria = ["Works on mobile", "Has tests"];
  assert.ok(validateRevision({ reason: "" }, criteria).error);
  assert.deepEqual(validateRevision({ reason: "Fix it", unmet: ["Has tests", "invented"] }, criteria).value, { reason: "Fix it", unmet: ["Has tests"] });
  const u = revisionUpdate({ resubmissionCount: 1, maxResubmissions: 3 });
  assert.equal(u.status, "In-Progress"); assert.equal(u.resubmissionCount, 2); assert.equal(u.reachedMax, false);
  const m = revisionUpdate({ resubmissionCount: 2, maxResubmissions: 3 });
  assert.equal(m.status, "In-Progress", "never stuck in review"); assert.equal(m.reachedMax, true);
});

test("rubber stamp: 5 stars inside 2 minutes warns; gap above 20 flags", () => {
  assert.equal(rubberStampWarning({ score: 100, submittedAt: T0, now: new Date(T0.getTime() + 60_000) }), true);
  assert.equal(rubberStampWarning({ score: 100, submittedAt: T0, now: new Date(T0.getTime() + 180_000) }), false);
  assert.equal(rubberStampWarning({ score: 80, submittedAt: T0, now: new Date(T0.getTime() + 60_000) }), false);
  assert.deepEqual(gapInfo(90, 69), { gap: 21, flagged: true });
  assert.deepEqual(gapInfo(90, 70), { gap: 20, flagged: false });
  assert.deepEqual(gapInfo(null, 70), { gap: null, flagged: false });
});

test("AI status for the queue", () => {
  assert.equal(aiStatus({ status: "done" }), "ready");
  assert.equal(aiStatus({ status: "done", partial: true }), "partial");
  assert.equal(aiStatus({ status: "pending" }), "pending");
  for (const s of ["off", "failed", "limit", "skipped"]) assert.equal(aiStatus({ status: s }), "not_available");
  assert.equal(aiStatus(null), "not_available");
});

test("queue: counters, filters, oldest first, 25 per page", () => {
  const now = new Date("2026-11-05T12:00:00Z"), day = 86_400_000;
  const it = (id, o) => ({ id, submittedAt: new Date(now - 3600_000), priority: "Medium", deadline: null, assigneeIds: ["dev"], assigneeRoles: ["Developer"], moduleId: "m1", ...o });
  const items = [it("a", { submittedAt: new Date(now - 3 * day), priority: "High" }), it("b", { deadline: new Date(now - day), assigneeRoles: ["Tester"], assigneeIds: ["tes"] }), it("c", { moduleId: "m2", priority: "Critical" })];
  const v = queueView(items, {}, now);
  assert.deepEqual(v.counts, { all: 3, today: 2, high: 2, overdue: 1, stale: 1 });
  assert.deepEqual(v.items.map((x) => x.id), ["a", "b", "c"]);
  assert.deepEqual(queueView(items, { view: "stale" }, now).items.map((x) => x.id), ["a"]);
  assert.deepEqual(queueView(items, { role: "Tester" }, now).items.map((x) => x.id), ["b"]);
  assert.deepEqual(queueView(items, { module: "m2" }, now).items.map((x) => x.id), ["c"]);
  assert.deepEqual(queueView(items, { assignee: "tes" }, now).items.map((x) => x.id), ["b"]);
  assert.equal(queueView(items, { role: "Tester" }, now).counts.all, 1, "counters follow the filters");
  const many = Array.from({ length: 30 }, (_, i) => it(`x${i}`, { submittedAt: new Date(now - i * 1000) }));
  const p2 = queueView(many, { page: 2 }, now);
  assert.equal(p2.items.length, 5); assert.equal(p2.total, 30); assert.equal(p2.pageSize, 25);
});

test("QA sign-off: tester role, not their own task, only while In-Review", () => {
  assert.equal(canTakeSignoff(task({ qaRequired: true }), "tes"), null);
  assert.equal(canTakeSignoff(task({ qaRequired: false }), "tes").code, "qa_not_required");
  assert.equal(canTakeSignoff(task({ qaRequired: true, status: "In-Progress" }), "tes").code, "not_in_review");
  assert.equal(canTakeSignoff(task({ qaRequired: true }), "dev").code, "self_signoff");
  assert.ok(validateSignoff({ result: "maybe" }).error);
  assert.ok(validateSignoff({ result: "fail" }).error, "a fail needs a note");
  assert.deepEqual(validateSignoff({ result: "pass" }).value, { result: "pass", note: "" });
  assert.deepEqual(validateSignoff({ result: "fail", note: " broken " }).value, { result: "fail", note: "broken" });
});

test("handoff: Design → Dev → Test, waiting for, blocked, unblocked, QA step", () => {
  const ts = [
    { id: "t", title: "Test login", type: "Testing", status: "To-Do", dependsOn: ["d"], qaRequired: true },
    { id: "d", title: "Build login", type: "Feature", status: "To-Do", dependsOn: ["x"] },
    { id: "x", title: "Login design", type: "Design", status: "Done", dependsOn: [] },
    { id: "o", title: "Docs", type: "Documentation", status: "To-Do", dependsOn: [] },
  ];
  const c = handoffChain(ts);
  assert.deepEqual(c.stages.map((s) => [s.key, s.tasks.map((t) => t.id)]), [["design", ["x"]], ["dev", ["d", "o"]], ["test", ["t"]]]);
  const by = Object.fromEntries(c.stages.flatMap((s) => s.tasks).map((t) => [t.id, t]));
  assert.deepEqual(by.t.waitingFor.map((w) => w.title), ["Build login"]);
  assert.equal(by.t.blocked, true);
  assert.equal(by.d.blocked, false); assert.equal(by.d.unblocked, true, "had a prerequisite and all are done");
  assert.equal(by.o.unblocked, false, "never had a prerequisite");
  assert.equal(c.qaStep.required, 1); assert.equal(c.qaStep.signed, 0);
  assert.deepEqual(handoffChain([]).stages.map((s) => s.tasks.length), [0, 0, 0]);
});

test("handoff: a loop or a missing prerequisite never hangs or breaks", () => {
  const c = handoffChain([{ id: "a", title: "A", type: "Feature", status: "To-Do", dependsOn: ["b"] }, { id: "b", title: "B", type: "Feature", status: "To-Do", dependsOn: ["a"] }, { id: "m", title: "M", type: "Feature", status: "To-Do", dependsOn: ["gone"] }]);
  assert.equal(c.stages[1].tasks.length, 3);
  assert.equal(c.stages[1].tasks.find((t) => t.id === "m").blocked, false);
});

test("mentions: only project members named in the text", () => {
  const members = [{ id: "1", name: "Sara Khan" }, { id: "2", name: "Ali" }, { id: "3", name: "Alina" }];
  assert.deepEqual(mentionedIds("hi @Sara Khan and @Alina", members, "9"), ["1", "3"]);
  assert.deepEqual(mentionedIds("mail ali@x.com please", members, "9"), [], "an email is not a mention");
  assert.deepEqual(mentionedIds("@Ali and @ali again", members, "9"), ["2"]);
  assert.deepEqual(mentionedIds("@Ali", members, "2"), [], "no self notification");
  assert.deepEqual(mentionedIds("@Stranger", members, "9"), []);
});

test("reactions: fixed set, toggle, one per user per emoji", () => {
  assert.ok(REACTIONS.length >= 4 && REACTIONS.length <= 8);
  let r = toggleReaction([], REACTIONS[0], "u");
  assert.deepEqual(r, [{ emoji: REACTIONS[0], user: "u" }]);
  r = toggleReaction(r, REACTIONS[1], "u"); assert.equal(r.length, 2);
  r = toggleReaction(r, REACTIONS[0], "v"); assert.equal(r.length, 3);
  r = toggleReaction(r, REACTIONS[0], "u");
  assert.deepEqual(r.filter((x) => x.user === "u").map((x) => x.emoji), [REACTIONS[1]]);
  assert.equal(toggleReaction([], "💩", "u"), null, "not in the set");
});

test("comments: only the author edits or deletes", () => {
  assert.equal(canChangeComment({ author: "a" }, "a"), true);
  assert.equal(canChangeComment({ author: "a" }, "b"), false);
});
