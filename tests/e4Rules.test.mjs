// E-4 (Tester Quality): bugs, bug board moves, Team Lead validity, bug XP + daily cap, visibility, QA sign-off, test cases, queue.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateBug, bugMove, bugValidity, bugXp, BUG_XP, BUG_DAILY_CAP, bugAccess, validateSignoffInput, alreadySigned,
  validateTestCase, validateRun, qaTab, weekRuns,
} from "../services/qualityRules.js";

const good = { title: "Login button does nothing", steps: "1. Open login\n2. Click Sign in", expected: "Dashboard opens", actual: "Nothing happens", severity: "High", environment: "Chrome 130, macOS" };

test("bug: required fields, limits and severity", () => {
  assert.deepEqual(validateBug(good).value, { ...good });
  assert.equal(validateBug({ ...good, title: "ab" }).errors.title !== undefined, true);
  assert.equal(validateBug({ ...good, title: "x".repeat(121) }).errors.title !== undefined, true);
  assert.equal(validateBug({ ...good, steps: "" }).errors.steps !== undefined, true);
  assert.equal(validateBug({ ...good, expected: "" }).errors.expected !== undefined, true);
  assert.equal(validateBug({ ...good, actual: "x".repeat(1001) }).errors.actual !== undefined, true);
  assert.equal(validateBug({ ...good, severity: "Urgent" }).errors.severity !== undefined, true);
  assert.equal(validateBug({ ...good, environment: "x".repeat(301) }).errors.environment !== undefined, true);
  assert.equal(validateBug({ ...good, environment: undefined }).value.environment, "");
  assert.equal(validateBug({ ...good, title: "  Trimmed  " }).value.title, "Trimmed");
});

const dev = { id: "dev1", kind: "developer", onTask: true, isLead: false };
const tes = { id: "tes1", kind: "tester", onTask: false, isLead: false };
const tl = { id: "tl1", kind: "lead", onTask: false, isLead: true };
const bug = (x = {}) => ({ status: "Open", validity: "valid", taskId: "t1", createdBy: "tes1", fixedBy: null, ...x });

test("bug moves: Open → Fixed by the task's assignee with a note, only after the Team Lead marked it valid", () => {
  assert.deepEqual(bugMove({ bug: bug(), to: "Fixed", actor: dev, note: "Null check added." }), { ok: true, status: "Fixed" });
  assert.equal(bugMove({ bug: bug(), to: "Fixed", actor: dev, note: "" }).field, "note");
  assert.equal(bugMove({ bug: bug({ validity: "pending" }), to: "Fixed", actor: dev, note: "done" }).status, 409);
  assert.equal(bugMove({ bug: bug(), to: "Fixed", actor: { ...dev, onTask: false }, note: "done" }).status, 403);
  assert.equal(bugMove({ bug: bug({ taskId: null }), to: "Fixed", actor: { ...dev, onTask: false }, note: "done" }).ok, true); // no task: any developer on the project
  assert.equal(bugMove({ bug: bug(), to: "Fixed", actor: { id: "des1", kind: "designer", onTask: true }, note: "Spacing fixed." }).ok, true); // designer on the linked task
  assert.equal(bugMove({ bug: bug(), to: "Fixed", actor: tes, note: "x" }).status, 403);
});

test("bug moves: Tester verifies or reopens a fix; Team Lead closes; nothing else", () => {
  const fixed = bug({ status: "Fixed", fixedBy: "dev1" });
  assert.equal(bugMove({ bug: fixed, to: "Verified", actor: tes }).ok, true);
  assert.equal(bugMove({ bug: fixed, to: "Open", actor: tes, note: "Still broken on Safari." }).ok, true);
  assert.equal(bugMove({ bug: fixed, to: "Open", actor: tes, note: "" }).field, "note");
  assert.equal(bugMove({ bug: fixed, to: "Verified", actor: { ...tes, id: "dev1" } }).status, 403); // the fixer cannot verify
  assert.equal(bugMove({ bug: fixed, to: "Verified", actor: dev }).status, 403);
  assert.equal(bugMove({ bug: bug({ status: "Verified" }), to: "Closed", actor: tl }).ok, true);
  assert.equal(bugMove({ bug: bug({ status: "Verified" }), to: "Closed", actor: tes }).status, 403);
  assert.equal(bugMove({ bug: bug({ validity: "invalid" }), to: "Closed", actor: tl }).ok, true);   // invalid → closed from Open
  assert.equal(bugMove({ bug: bug(), to: "Closed", actor: tl }).status, 409);                       // a valid open bug must be fixed first
  assert.equal(bugMove({ bug: bug(), to: "Verified", actor: tes }).status, 409);                    // skipping Fixed
  assert.equal(bugMove({ bug: bug({ status: "Closed" }), to: "Open", actor: tes, note: "again" }).status, 409);
  assert.equal(bugMove({ bug: bug(), to: "Open", actor: tes, note: "x" }).status, 409);             // same column
  assert.equal(bugMove({ bug: bug(), to: "Nonsense", actor: tl }).status, 400);
  assert.equal(bugMove({ bug: bug({ status: "Verified" }), to: "Closed", actor: { id: "m1", kind: "manager" } }).status, 403);
  assert.equal(bugMove({ bug: bug({ status: "Verified" }), to: "Closed", actor: { id: "d1", kind: "director" } }).status, 403);
});

test("Team Lead validity: once, on an open bug; invalid / duplicate need a note; duplicate needs the other bug", () => {
  const pending = bug({ validity: "pending" });
  assert.deepEqual(bugValidity({ bug: pending, validity: "valid", actor: tl }), { ok: true, validity: "valid", note: "" });
  assert.equal(bugValidity({ bug: pending, validity: "invalid", actor: tl, note: "" }).field, "note");
  assert.equal(bugValidity({ bug: pending, validity: "invalid", actor: tl, note: "Works as designed." }).ok, true);
  assert.equal(bugValidity({ bug: pending, validity: "duplicate", actor: tl, note: "Same as the other." }).field, "duplicateOf");
  assert.equal(bugValidity({ bug: pending, validity: "duplicate", actor: tl, note: "Same as the other.", duplicateOf: "b2" }).ok, true);
  assert.equal(bugValidity({ bug: bug(), validity: "valid", actor: tl }).status, 409);               // already decided
  assert.equal(bugValidity({ bug: pending, validity: "valid", actor: tes }).status, 403);
  assert.equal(bugValidity({ bug: pending, validity: "maybe", actor: tl }).status, 400);
  assert.equal(bugValidity({ bug: bug({ validity: "pending", status: "Closed" }), validity: "valid", actor: tl }).status, 409);
});

test("bug XP (Q2): +15 only for a valid bug, once per bug, at most 5 per reporter per day", () => {
  assert.equal(BUG_XP, 15); assert.equal(BUG_DAILY_CAP, 5);
  assert.deepEqual(bugXp({ validity: "valid", awarded: false, countToday: 0 }), { xp: 15, reason: null });
  assert.deepEqual(bugXp({ validity: "valid", awarded: false, countToday: 4 }), { xp: 15, reason: null });
  assert.deepEqual(bugXp({ validity: "valid", awarded: false, countToday: 5 }), { xp: 0, reason: "daily_cap" });
  assert.deepEqual(bugXp({ validity: "valid", awarded: true, countToday: 0 }), { xp: 0, reason: "already_awarded" });
  for (const v of ["invalid", "duplicate", "pending"]) assert.deepEqual(bugXp({ validity: v, awarded: false, countToday: 0 }), { xp: 0, reason: "not_valid" });
});

test("visibility (Q3): project members and its Team Lead write, the project's Manager and any Director read, others nothing", () => {
  const project = { members: ["dev1", "des1", "tes1", "tl1"], managerId: "m1" };
  assert.equal(bugAccess({ id: "dev1", role: "Developer" }, project), "write");
  assert.equal(bugAccess({ id: "des1", role: "Senior Designer" }, project), "write");
  assert.equal(bugAccess({ id: "tes1", role: "Tester" }, project), "write");
  assert.equal(bugAccess({ id: "tl1", role: "Team Lead" }, project), "write");
  assert.equal(bugAccess({ id: "m1", role: "Manager" }, project), "read");
  assert.equal(bugAccess({ id: "m2", role: "Manager" }, project), null);
  assert.equal(bugAccess({ id: "x", role: "Director" }, project), "read");
  assert.equal(bugAccess({ id: "dev9", role: "Developer" }, project), null);
  assert.equal(bugAccess({ id: "tl9", role: "Team Lead" }, project), null);
  assert.equal(bugAccess({ id: "dev1", role: "Developer" }, null), null);
});

test("QA sign-off: pass, pass with notes, fail; notes needed for the last two; once per submission", () => {
  assert.deepEqual(validateSignoffInput({ result: "pass" }).value, { result: "pass", withNotes: false, note: "" });
  assert.deepEqual(validateSignoffInput({ result: "pass_notes", note: "Minor spacing issue." }).value, { result: "pass", withNotes: true, note: "Minor spacing issue." });
  assert.equal(validateSignoffInput({ result: "pass_notes", note: " " }).field, "note");
  assert.equal(validateSignoffInput({ result: "fail" }).field, "note");
  assert.deepEqual(validateSignoffInput({ result: "fail", note: "Crashes on submit." }).value, { result: "fail", withNotes: false, note: "Crashes on submit." });
  assert.equal(validateSignoffInput({ result: "maybe" }).field, "result");
  assert.equal(validateSignoffInput({ result: "fail", note: "x".repeat(2001) }).field, "note");
  const sub = new Date(2026, 10, 6, 10);
  assert.equal(alreadySigned({ submittedAt: sub, qaSignoffs: [] }), false);
  assert.equal(alreadySigned({ submittedAt: sub, qaSignoffs: [{ at: new Date(2026, 10, 6, 9), result: "fail" }] }), false); // an older submission
  assert.equal(alreadySigned({ submittedAt: sub, qaSignoffs: [{ at: new Date(2026, 10, 6, 11), result: "pass" }] }), true);
});

test("test case and run input", () => {
  const tc = { title: "Login with a wrong password", steps: "1. Open login\n2. Wrong password", expected: "An error shows", priority: "High" };
  assert.deepEqual(validateTestCase(tc).value, tc);
  assert.equal(validateTestCase({ ...tc, priority: "Urgent" }).errors.priority !== undefined, true);
  assert.equal(validateTestCase({ ...tc, title: "" }).errors.title !== undefined, true);
  assert.equal(validateTestCase({ ...tc, steps: "x".repeat(2001) }).errors.steps !== undefined, true);
  assert.deepEqual(validateRun({ result: "Pass" }).value, { result: "Pass", note: "" });
  assert.equal(validateRun({ result: "Fail", note: "" }).field, "note");
  assert.equal(validateRun({ result: "Blocked", note: "Server down." }).value.result, "Blocked");
  assert.equal(validateRun({ result: "Skipped" }).field, "result");
});

test("QA queue tab from the task: waiting, signed off, failed", () => {
  const sub = new Date(2026, 10, 6, 10);
  const t = (x) => ({ qaRequired: true, status: "In-Review", submittedAt: sub, qaSignoffs: [], ...x });
  assert.equal(qaTab(t({})), "waiting");
  assert.equal(qaTab(t({ qaSignoffs: [{ at: new Date(2026, 10, 6, 11), result: "pass" }] })), "signed");
  assert.equal(qaTab(t({ status: "Done", qaSignoffs: [{ at: new Date(2026, 10, 6, 11), result: "pass" }] })), "signed");
  assert.equal(qaTab(t({ status: "In-Progress", qaSignoffs: [{ at: new Date(2026, 10, 6, 11), result: "fail" }] })), "failed");
  assert.equal(qaTab(t({ status: "In-Progress" })), null);   // not submitted for this round yet
  assert.equal(qaTab(t({ qaRequired: false })), null);
});

test("this week's runs: pass / fail / blocked counted over the last 7 days", () => {
  const now = new Date(2026, 10, 6, 12);
  const runs = [{ result: "Pass", at: new Date(2026, 10, 6) }, { result: "Fail", at: new Date(2026, 10, 3) }, { result: "Pass", at: new Date(2026, 9, 25) }, { result: "Blocked", at: new Date(2026, 10, 1) }];
  assert.deepEqual(weekRuns(runs, now), { Pass: 1, Fail: 1, Blocked: 1 });
});

test("notification links: bugs open the board (employees) or the Team Lead bug page; QA result opens the task", async () => {
  const { notifRedirectPath } = await import("../../client/src/utils/notifRoutes.js");
  const n = (type, meta) => ({ type, meta });
  assert.equal(notifRedirectPath(n("bug_reported", { bugId: "b1", taskId: "t1" }), "Developer"), "/workspace/bugs?bug=b1");
  assert.equal(notifRedirectPath(n("bug_fixed", { bugId: "b1" }), "Tester"), "/workspace/bugs?bug=b1");
  assert.equal(notifRedirectPath(n("bug_reported", { bugId: "b1" }), "Team Lead"), "/teamlead/bugs?bug=b1");
  assert.equal(notifRedirectPath(n("bug_verified", { bugId: "b1" }), "Team Lead"), "/teamlead/bugs?bug=b1");
  assert.equal(notifRedirectPath(n("qa_signoff_done", { taskId: "t1" }), "Developer"), "/workspace/tasks/t1");
});

test("bug and QA evidence files: opened by people who may see the project (same rule as project files)", async () => {
  const { mayOpenAny } = await import("../services/accessRules.js");
  const place = { task: null, project: { members: ["tes1", "dev1", "tl1"], managerId: "m1" } };
  assert.equal(mayOpenAny({ id: "dev1", role: "Developer", roleCategory: "developer" }, [place]), true);
  assert.equal(mayOpenAny({ id: "tl1", role: "Team Lead" }, [place]), true);
  assert.equal(mayOpenAny({ id: "m1", role: "Manager" }, [place]), true);
  assert.equal(mayOpenAny({ id: "x", role: "Director" }, [place]), true);
  assert.equal(mayOpenAny({ id: "dev9", role: "Developer", roleCategory: "developer" }, [place]), false);
  assert.equal(mayOpenAny({ id: "m9", role: "Manager" }, [place]), false);
});
