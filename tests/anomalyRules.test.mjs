// Anomaly rules for Manager Flags (ACHIEVION_AI_EVAL_SPEC.md §5, D-076).
import test from "node:test";
import assert from "node:assert/strict";
import * as N from "../services/anomalyRules.js";

const MIN = 60_000, HOUR = 60 * MIN;

test("z-score: flags XP more than 3 SD from the user's own history", () => {
  const hist = [50, 52, 48, 51, 49, 50, 53, 47];
  assert.equal(N.isXpOutlier(hist, 51), false);
  assert.equal(N.isXpOutlier(hist, 120), true);
  assert.equal(N.isXpOutlier(hist, 10), true);
});

test("z-score: no flag with too little history or no spread", () => {
  assert.equal(N.isXpOutlier([50, 60], 500), false);          // < 5 past tasks
  assert.equal(N.isXpOutlier([50, 50, 50, 50, 50], 90), false); // SD 0 → z undefined
  assert.equal(N.xpZScore([50, 50, 50, 50, 50], 90), null);
});

test("rubber-stamp: 5★ approval within 2 minutes of submission", () => {
  const t0 = new Date("2026-11-04T10:00:00Z");
  assert.equal(N.isRubberStamp({ stars: 5, submittedAt: t0, approvedAt: new Date(+t0 + 90_000) }), true);
  assert.equal(N.isRubberStamp({ stars: 5, submittedAt: t0, approvedAt: new Date(+t0 + 2 * MIN) }), false);
  assert.equal(N.isRubberStamp({ stars: 4, submittedAt: t0, approvedAt: new Date(+t0 + 30_000) }), false);
  assert.equal(N.isRubberStamp({ stars: 5, submittedAt: null, approvedAt: t0 }), false);
});

test("burst: one TL gives one user 3+ approvals inside one hour", () => {
  const at = (m) => new Date(Date.UTC(2026, 10, 4, 9, m));
  const approvals = [
    { approverId: "tl1", userId: "u1", at: at(0) },
    { approverId: "tl1", userId: "u1", at: at(20) },
    { approverId: "tl1", userId: "u1", at: at(59) },
    { approverId: "tl1", userId: "u2", at: at(1) },
    { approverId: "tl1", userId: "u2", at: at(2) },
    { approverId: "tl2", userId: "u1", at: at(3) },
  ];
  assert.deepEqual(N.findBursts(approvals), [{ approverId: "tl1", userId: "u1", count: 3 }]);
  const spread = [0, 40, 80].map((m) => ({ approverId: "tl1", userId: "u1", at: new Date(+at(0) + m * MIN) }));
  assert.deepEqual(N.findBursts(spread), []);
  assert.equal(HOUR, N.BURST_WINDOW_MS);
});

test("disagreement rule is the same one used at review time", () => {
  assert.equal(N.isAiTlDisagreement(90, 60), true);
  assert.equal(N.isAiTlDisagreement(70, 60), false);
});
