// E-3 (submit, my submissions, extension, one more try): pure rules. D-176 same-status no-op.
import test from "node:test";
import assert from "node:assert/strict";
import { validateSubmission, extensionAsk, limitAsk, employeeAiFeedback, submissionRow, projectLeadIds, employeeTaskView } from "../services/submitRules.js";
import { isNoOpStatus } from "../services/teamLeadRules.js";

const MB = 1024 * 1024;
const task = (x = {}) => ({ status: "In-Progress", type: "Feature", acceptanceCriteria: ["Has tests", "Docs updated"], qaRequired: false, resubmissionCount: 0, maxResubmissions: 3, ...x });

test("D-176: a move to the same status is a no-op", () => {
  assert.equal(isNoOpStatus("Done", "Done"), true);
  assert.equal(isNoOpStatus("In-Progress", "In-Progress"), true);
  assert.equal(isNoOpStatus("In-Review", "Done"), false);
});

test("submit: developer link + summary + criteria → note, links, AI text, checklist", () => {
  const r = validateSubmission({ kind: "developer", task: task(), files: [], fields: { link: "https://github.com/acme/app/pull/7", branch: "feat/login", summary: "Login form with tests.", tests: "Unit tests for the validator", criteria: [0, 1, 1] } });
  assert.equal(r.error, undefined);
  assert.equal(r.note, "Login form with tests.");
  assert.deepEqual(r.links, [{ label: "Pull request or repository", url: "https://github.com/acme/app/pull/7" }]);
  assert.deepEqual(r.checklist, ["ac:0", "ac:1"]);
  assert.match(r.content, /Branch: feat\/login/);
  assert.match(r.content, /Tests: Unit tests for the validator/);
});

test("submit: needs a link, a file or a summary; links must be http(s)", () => {
  assert.equal(validateSubmission({ kind: "developer", task: task(), files: [], fields: {} }).field, "summary");
  assert.equal(validateSubmission({ kind: "developer", task: task(), files: [], fields: { link: "javascript:alert(1)" } }).field, "link");
  assert.equal(validateSubmission({ kind: "developer", task: task(), files: [], fields: { link: "ftp://x.y/z" } }).field, "link");
  assert.equal(validateSubmission({ kind: "developer", task: task(), files: [{ name: "a.zip", size: 10 }], fields: {} }).error, undefined);
  assert.equal(validateSubmission({ kind: "designer", task: task(), files: [], fields: { rationale: "Simpler nav." } }).error, undefined);
});

test("submit: file rules D-164/D-165 (types, 10 MB, 5 files)", () => {
  const f = (name, size = 10) => ({ name, size });
  assert.equal(validateSubmission({ kind: "developer", task: task(), files: [f("x.html")], fields: { summary: "s" } }).field, "files");
  assert.equal(validateSubmission({ kind: "developer", task: task(), files: [f("x.svg")], fields: { summary: "s" } }).field, "files");
  assert.equal(validateSubmission({ kind: "developer", task: task(), files: [f("big.pdf", 10 * MB + 1)], fields: { summary: "s" } }).field, "files");
  assert.equal(validateSubmission({ kind: "developer", task: task(), files: Array.from({ length: 6 }, (_, i) => f(`${i}.png`)), fields: {} }).field, "files");
  assert.equal(validateSubmission({ kind: "developer", task: task(), files: ["a.jpg", "b.JPEG", "c.png", "d.pdf", "e.zip"].map((n) => f(n)), fields: {} }).error, undefined);
  assert.equal(validateSubmission({ kind: "developer", task: task(), files: ["a.docx", "b.xlsx", "c.txt", "d.md"].map((n) => f(n)), fields: {} }).error, undefined);
});

test("submit: text limits and bad criteria indexes", () => {
  assert.equal(validateSubmission({ kind: "developer", task: task(), files: [], fields: { summary: "x".repeat(2001) } }).field, "summary");
  assert.equal(validateSubmission({ kind: "developer", task: task(), files: [], fields: { summary: "ok", branch: "bad branch name" } }).field, "branch");
  assert.equal(validateSubmission({ kind: "designer", task: task(), files: [], fields: { rationale: "ok", handoff: "h".repeat(1001) } }).field, "handoff");
  assert.equal(validateSubmission({ kind: "designer", task: task(), files: [], fields: { rationale: "ok", version: "v".repeat(41) } }).field, "version");
  assert.deepEqual(validateSubmission({ kind: "developer", task: task(), files: [], fields: { summary: "ok", criteria: [5, -1, "x", 1] } }).checklist, ["ac:1"]);
});

test("submit: designer handoff note and design checklist; tester needs evidence when QA work applies", () => {
  const d = validateSubmission({ kind: "designer", task: task({ type: "Design" }), files: [], fields: { link: "https://figma.com/file/abc", version: "v3", rationale: "Bigger targets.", handoff: "Use the 8px grid.", design: ["brief", "nonsense"] } });
  assert.deepEqual(d.links, [{ label: "Design file or prototype", url: "https://figma.com/file/abc" }]);
  assert.match(d.content, /Handoff note: Use the 8px grid\./);
  assert.match(d.content, /Version: v3/);
  assert.deepEqual(d.checklist, ["brief"]);
  assert.equal(validateSubmission({ kind: "tester", task: task({ type: "Testing" }), files: [], fields: { summary: "All pass." } }).field, "files");
  assert.equal(validateSubmission({ kind: "tester", task: task({ qaRequired: true }), files: [], fields: { summary: "All pass." } }).field, "files");
  assert.equal(validateSubmission({ kind: "tester", task: task({ type: "Testing" }), files: [{ name: "report.pdf", size: 5 }], fields: { summary: "All pass." } }).error, undefined);
  assert.equal(validateSubmission({ kind: "tester", task: task({ type: "Bug" }), files: [], fields: { summary: "Verified." } }).error, undefined);
});

const NOW = new Date(2026, 10, 6, 10);
const days = (n) => new Date(NOW.getTime() + n * 86_400_000);
test("extension: reason 10-500, a later date within 60 days, one open request, at most 2 approved", () => {
  const t = task({ deadline: days(2), extensionRequests: [] });
  assert.equal(extensionAsk({ task: t, newDeadline: days(5), reason: "Need two more days to fix tests.", now: NOW }).ok, true);
  assert.equal(extensionAsk({ task: t, newDeadline: days(5), reason: "short", now: NOW }).field, "reason");
  assert.equal(extensionAsk({ task: t, newDeadline: days(1), reason: "Need two more days to fix tests.", now: NOW }).field, "newDeadline");
  assert.equal(extensionAsk({ task: t, newDeadline: days(63), reason: "Need two more days to fix tests.", now: NOW }).field, "newDeadline");
  assert.equal(extensionAsk({ task: t, newDeadline: "not a date", reason: "Need two more days to fix tests.", now: NOW }).field, "newDeadline");
  assert.equal(extensionAsk({ task: task({ deadline: days(2), extensionRequests: [{ status: "PENDING" }] }), newDeadline: days(5), reason: "Need two more days to fix tests.", now: NOW }).status, 409);
  assert.equal(extensionAsk({ task: task({ deadline: days(2), extensionRequests: [{ status: "APPROVED" }, { status: "APPROVED" }] }), newDeadline: days(5), reason: "Need two more days to fix tests.", now: NOW }).status, 409);
  assert.equal(extensionAsk({ task: task({ status: "Done", deadline: days(2) }), newDeadline: days(5), reason: "Need two more days to fix tests.", now: NOW }).status, 409);
  assert.equal(extensionAsk({ task: task({ deadline: days(-3) }), newDeadline: days(1), reason: "I was ill for three days.", now: NOW }).ok, true); // overdue: any date after today
  assert.equal(extensionAsk({ task: task({ deadline: null }), newDeadline: days(3), reason: "Need two more days to fix tests.", now: NOW }).status, 409); // nothing to extend
});

test("one more try: only at the limit after a send-back, reason needed, one open request, no second ask after a decline for the same attempt", () => {
  const at = task({ resubmissionCount: 3, maxResubmissions: 3 });
  assert.equal(limitAsk({ task: at, requests: [], reason: "I fixed every point now." }).ok, true);
  assert.equal(limitAsk({ task: task({ resubmissionCount: 1 }), requests: [], reason: "I fixed every point now." }).status, 409);
  assert.equal(limitAsk({ task: { ...at, status: "In-Review" }, requests: [], reason: "I fixed every point now." }).status, 409);
  assert.equal(limitAsk({ task: at, requests: [], reason: "pls" }).field, "reason");
  assert.equal(limitAsk({ task: at, requests: [{ status: "Pending", attempts: 3 }], reason: "I fixed every point now." }).status, 409);
  assert.equal(limitAsk({ task: at, requests: [{ status: "Rejected", attempts: 3 }], reason: "I fixed every point now." }).status, 409);
  assert.equal(limitAsk({ task: { ...at, resubmissionCount: 4, maxResubmissions: 4 }, requests: [{ status: "Resolved", attempts: 3 }], reason: "I fixed every point now." }).ok, true);
});

test("AI feedback for the employee: text only, only after the Team Lead scored; never a score", () => {
  const ai = { status: "done", strengths: ["Clear code"], improvements: ["More tests"], evidence: { a: "x" }, score: 77 };
  assert.equal(employeeAiFeedback({ tlScore: null, aiEval: ai, aiScore: 77 }), null);
  assert.deepEqual(employeeAiFeedback({ tlScore: 80, aiEval: ai, aiScore: 77 }), { strengths: ["Clear code"], improvements: ["More tests"] });
  assert.equal(employeeAiFeedback({ tlScore: 80, aiEval: { status: "failed" } }), null);
  const view = employeeTaskView({ _id: "t", title: "T", tlScore: null, aiEval: ai, aiScore: 77, aiScores: { a: 1 } });
  assert.equal(view.aiEval, undefined); assert.equal(view.aiScore, undefined); assert.equal(view.aiScores, undefined);
  const after = employeeTaskView({ _id: "t", tlScore: 80, aiEval: ai, aiScore: 77 });
  assert.deepEqual(after.aiEval, { status: "done", strengths: ["Clear code"], improvements: ["More tests"] });
  assert.doesNotMatch(JSON.stringify(after), /77/);
});

test("my submissions row: tab, revision number, decision; score and feedback only after review", () => {
  const base = { _id: "t1", title: "Login", status: "In-Review", submittedAt: NOW, resubmissionCount: 1, tlScore: null, reviewNote: "draft", revisionHistory: [{ type: "revision_requested", comment: "Add tests", unmetCriteria: ["Has tests"], requestedAt: days(-1) }] };
  const w = submissionRow(base);
  assert.equal(w.tab, "waiting"); assert.equal(w.revision, 1); assert.equal(w.score, null); assert.equal(w.feedback, null); assert.equal(w.stars, null);
  const r = submissionRow({ ...base, status: "In-Progress" });
  assert.equal(r.tab, "revision"); assert.equal(r.reason, "Add tests"); assert.deepEqual(r.unmet, ["Has tests"]);
  const a = submissionRow({ ...base, status: "Done", tlScore: 84, reviewNote: "Nice.", reviewedAt: NOW });
  assert.equal(a.tab, "approved"); assert.equal(a.score, 84); assert.equal(a.stars, 4); assert.equal(a.feedback, "Nice.");
  assert.equal(submissionRow({ ...base, status: "To-Do", submittedAt: null, firstSubmittedAt: null }), null);
});

test("project leads: the module's Team Lead first, else Team Leads among the project members", () => {
  assert.deepEqual(projectLeadIds({ milestone: { teamLeadId: "tl1" }, members: [{ _id: "tl2", role: "Team Lead" }] }), ["tl1"]);
  assert.deepEqual(projectLeadIds({ milestone: null, members: [{ _id: "tl2", role: "Team Lead" }, { _id: "d1", role: "Developer" }, { _id: "tl3", role: "Team Lead" }] }), ["tl2", "tl3"]);
  assert.deepEqual(projectLeadIds({ milestone: null, members: [] }), []);
});

test("notification links for E-3 requests: TL inbox, Manager inbox, the employee's task", async () => {
  const { notifRedirectPath } = await import("../../client/src/utils/notifRoutes.js");
  const n = (type, meta = { taskId: "t1", projectId: "p1" }) => ({ type, meta });
  assert.equal(notifRedirectPath(n("extension_requested"), "Team Lead"), "/teamlead/requests");
  assert.equal(notifRedirectPath(n("more_tries_requested"), "Team Lead"), "/teamlead/requests");
  assert.equal(notifRedirectPath(n("more_tries_requested"), "Manager"), "/manager/inbox");
  assert.equal(notifRedirectPath(n("extension_requested_fyi"), "Manager"), "/manager/tasks/t1");
  assert.equal(notifRedirectPath(n("extension_approved"), "Developer"), "/workspace/tasks/t1");
  assert.equal(notifRedirectPath(n("extension_rejected"), "Senior Tester"), "/workspace/tasks/t1");
  assert.equal(notifRedirectPath(n("resubmission_decided"), "Designer"), "/workspace/tasks/t1");
});

test("upload errors become a clear 400 on the files field (size, count, type)", async () => {
  const { uploadError } = await import("../services/submitRules.js");
  assert.deepEqual(uploadError({ code: "LIMIT_FILE_SIZE" }), { status: 400, field: "files", error: "Each file can be at most 10 MB." });
  assert.equal(uploadError({ code: "LIMIT_FILE_COUNT" }).error, "Attach at most 5 files.");
  assert.equal(uploadError({ code: "LIMIT_UNEXPECTED_FILE" }).error, "Attach at most 5 files.");
  assert.equal(uploadError({ status: 400, message: "This file type is not allowed. Use JPG, PNG, PDF, ZIP, DOCX, XLSX, TXT or MD." }).status, 400);
  assert.deepEqual(uploadError({ http_code: 400, message: "Raw file format png not allowed" }), { status: 400, field: "files", error: "A file does not match its type (for example a .png that is not a picture). Check the files and try again." });
  assert.equal(uploadError({ message: "boom" }).status, 500);
});
