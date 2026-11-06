// E-4c: one try per send-back cycle (a resubmit does not count), the limit = max send-backs; a stable order of TL alerts.
import test from "node:test";
import assert from "node:assert/strict";
import { attemptDelta, revisionUpdate, revisionPlan } from "../services/reviewRules.js";
import { sortAlerts } from "../services/teamLeadRules.js";

// Replays events on a task the way the server counts them.
function replay(events, max = 3) {
  let count = 0, reachedMax = false;
  for (const e of events) {
    if (e === "send_back") { const u = revisionUpdate({ resubmissionCount: count, maxResubmissions: max }); count = u.resubmissionCount; reachedMax = u.reachedMax; }
    else if (e === "qa_fail") count += revisionPlan("qa").countsAttempt ? 1 : 0;
    else count += attemptDelta(e);
  }
  return { count, triesLeft: Math.max(0, max - count), reachedMax };
}

test("a resubmit uses no try; a send-back uses one; a QA fail uses none", () => {
  assert.equal(attemptDelta("resubmit"), 0);
  assert.equal(attemptDelta("first_submit"), 0);
  assert.deepEqual(replay(["send_back", "resubmit"]), { count: 1, triesLeft: 2, reachedMax: false }); // one cycle = one try
  assert.deepEqual(replay(["qa_fail", "resubmit"]), { count: 0, triesLeft: 3, reachedMax: false });
});

test("the limit is reached on the third send-back, with resubmits in between", () => {
  const r2 = replay(["send_back", "resubmit", "send_back", "resubmit"]);
  assert.deepEqual(r2, { count: 2, triesLeft: 1, reachedMax: false });                   // before E-4c this was the limit already
  const r3 = replay(["send_back", "resubmit", "send_back", "resubmit", "send_back"]);
  assert.deepEqual(r3, { count: 3, triesLeft: 0, reachedMax: true });                   // the D-142 request opens here
  assert.equal(replay(["send_back", "resubmit", "qa_fail", "resubmit", "send_back"]).count, 2);
});

test("TL alerts: severity first, then the message (names), then the record id, whatever order they came in", () => {
  const a = [
    { type: "overloaded_member", severity: "High", message: "DEV-Tester has 27 active tasks (overloaded)", meta: { userId: "u3" } },
    { type: "overloaded_member", severity: "Critical", message: "DEV-Developer-1 has 127 active tasks (overloaded)", meta: { userId: "u1" } },
    { type: "burnout_risk", severity: "Critical", message: "DEV-Developer-1 is at burnout risk (HP: 0/100)", meta: { userId: "u1" } },
    { type: "overloaded_member", severity: "High", message: "DEV-Designer has 13 active tasks (overloaded)", meta: { userId: "u2" } },
    { type: "overdue_task", severity: "Medium", message: "Task \"A\" is overdue", meta: { taskId: "t2" } },
    { type: "overdue_task", severity: "Medium", message: "Task \"A\" is overdue", meta: { taskId: "t1" } },
  ];
  const want = ["DEV-Developer-1 has 127", "DEV-Developer-1 is at burnout", "DEV-Designer has 13", "DEV-Tester has 27", "t1", "t2"];
  for (let i = 0; i < 20; i++) {
    const shuffled = [...a].sort(() => Math.random() - 0.5);
    const out = sortAlerts(shuffled);
    assert.deepEqual(out.map((x) => (x.severity === "Medium" ? x.meta.taskId : x.message)).map((m, j) => (j < 4 ? m.slice(0, want[j].length) : m)), want);
  }
  assert.notEqual(sortAlerts(a), a); // a new array; the input is not reordered in place
});
