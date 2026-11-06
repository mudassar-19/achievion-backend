// S-1: employee scope rules, signed file links, Team Lead assign rule, review result reader.
import test from "node:test";
import assert from "node:assert/strict";
import { employeeCanReadTask, reviewListAccess, seniorMayReview, canOpenFile, isTeamMember, tlAssignBlock, isSafeUploadPath, signFilePath, verifyFileLink, FILE_LINK_SECONDS } from "../services/accessRules.js";
import { reviewResult } from "../../client/src/utils/xpRules.js";

const dev = { id: "d1", role: "Developer", roleCategory: "developer" };
const task = (x = {}) => ({ assignees: [], assignee: null, createdBy: "tl", assignedBy: "tl", projectId: "p1", ...x });
const project = (x = {}) => ({ members: ["tl", "m1"], managerId: "mgr", ...x });

test("task read: assignee, creator or project member; anyone else no", () => {
  assert.equal(employeeCanReadTask(dev, task({ assignees: ["d1"] }), null), true);
  assert.equal(employeeCanReadTask(dev, task({ assignee: "d1" }), project()), true);
  assert.equal(employeeCanReadTask(dev, task({ assignees: ["x"] }), project({ members: ["d1"] })), true, "project member reads");
  assert.equal(employeeCanReadTask(dev, task({ assignees: ["x"] }), project()), false, "other project");
  assert.equal(employeeCanReadTask(dev, task({ assignees: ["x"], projectId: null }), null), false, "no project, not theirs");
  assert.equal(employeeCanReadTask({ ...dev, id: "s" }, task({ assignedBy: "s", projectId: null }), null), true, "the Senior who gave it");
});

test("review lists: plain employees and juniors never; Senior own scope; leads as before", () => {
  for (const role of ["Developer", "Designer", "Tester", "Junior Developer", "Junior Tester"]) assert.equal(reviewListAccess({ role, roleCategory: "developer" }), null, role);
  for (const role of ["Senior Developer", "Senior Designer", "Senior Tester"]) assert.equal(reviewListAccess({ role, roleCategory: "developer" }), "senior", role);
  assert.equal(reviewListAccess({ role: "Team Lead", roleCategory: "team_lead" }), "all");
  assert.equal(reviewListAccess({ role: "Manager", roleCategory: "manager" }), "all");
  assert.equal(reviewListAccess({ role: "Director", roleCategory: "director" }), "all");
});

test("Senior reviews only on a project they are a member of", () => {
  assert.equal(seniorMayReview("s1", project({ members: ["s1"] })), true);
  assert.equal(seniorMayReview("s1", project()), false);
  assert.equal(seniorMayReview("s1", null), false);
});

test("file access per role", () => {
  const onP = { task: task({ assignees: ["a"] }), project: project() };
  assert.equal(canOpenFile({ id: "dir", role: "Director", roleCategory: "director" }, onP), true);
  assert.equal(canOpenFile({ id: "mgr", role: "Manager", roleCategory: "manager" }, onP), true, "this project's Manager");
  assert.equal(canOpenFile({ id: "mgr2", role: "Manager", roleCategory: "manager" }, onP), false, "another Manager");
  assert.equal(canOpenFile({ id: "tl", role: "Team Lead", roleCategory: "team_lead" }, onP), true);
  assert.equal(canOpenFile({ id: "tl2", role: "Team Lead", roleCategory: "team_lead" }, onP), false);
  assert.equal(canOpenFile({ id: "a", role: "Developer", roleCategory: "developer" }, onP), true, "assignee");
  assert.equal(canOpenFile({ id: "m1", role: "Tester", roleCategory: "tester" }, onP), true, "project member");
  assert.equal(canOpenFile(dev, onP), false, "other project");
  assert.equal(canOpenFile({ id: "m1", role: "Developer", roleCategory: "developer" }, { task: null, project: project() }), true, "project attachment");
  assert.equal(canOpenFile(dev, { task: null, project: project() }), false);
  assert.equal(canOpenFile(dev, { task: null, project: null }), false);
});

test("team data: active members only", () => {
  const team = { members: [{ userId: "a", isActive: true }, { userId: { _id: "b" }, isActive: true }, { userId: "c", isActive: false }] };
  assert.equal(isTeamMember(team, "a"), true);
  assert.equal(isTeamMember(team, "b"), true, "populated");
  assert.equal(isTeamMember(team, "c"), false, "left the team");
  assert.equal(isTeamMember(team, "z"), false);
});

test("Team Lead assigns any Developer, Designer or Tester on the project, department does not matter", () => {
  const p = project({ members: ["m1"] });
  for (const c of ["developer", "designer", "tester"]) assert.equal(tlAssignBlock({ id: "m1", roleCategory: c, department: "Other" }, p), null, c);
  assert.match(tlAssignBlock({ id: "x", roleCategory: "designer" }, p), /on this project/);
  assert.match(tlAssignBlock({ id: "m1", roleCategory: "manager" }, p), /Developers, Designers and Testers/);
  assert.match(tlAssignBlock({ id: "m1", roleCategory: "team_lead" }, p), /Developers, Designers and Testers/);
  assert.match(tlAssignBlock({ id: "m1", roleCategory: "developer" }, null), /project/);
});

test("upload paths: only one file in the two folders", () => {
  assert.equal(isSafeUploadPath("/uploads/submissions/1778-51.pdf"), true);
  assert.equal(isSafeUploadPath("/uploads/attachments/1778-51.docx"), true);
  for (const bad of ["/uploads/../.env", "/uploads/submissions/../../.env", "/uploads/submissions/%2e%2e%2f.env", "/uploads/submissions/..", "/uploads/other/a.pdf", "/uploads/submissions/.env", "/uploads/submissions/a/b.pdf", "uploads/submissions/a.pdf", "/uploads/submissions/a\\b.pdf", "", null, ["/uploads/submissions/a.pdf"]])
    assert.equal(isSafeUploadPath(bad), false, String(bad));
});

test("signed link: 5 minutes, bound to the path, tamper and expiry refused", () => {
  const P = "/uploads/submissions/a.pdf", now = 1_000_000, secret = "s3cret";
  assert.equal(FILE_LINK_SECONDS, 300);
  const { exp, sig } = signFilePath(P, { now, secret });
  assert.equal(exp, Math.floor(now / 1000) + 300);
  assert.equal(verifyFileLink(P, { exp, sig }, { now, secret }), "ok");
  assert.equal(verifyFileLink(P, { exp: String(exp), sig }, { now: now + 299_000, secret }), "ok", "query values are strings");
  assert.equal(verifyFileLink(P, { exp, sig }, { now: now + 301_000, secret }), "expired");
  assert.equal(verifyFileLink("/uploads/submissions/b.pdf", { exp, sig }, { now, secret }), "bad");
  assert.equal(verifyFileLink(P, { exp: exp + 1000, sig }, { now, secret }), "bad", "longer life");
  assert.equal(verifyFileLink(P, { exp, sig: sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0") }, { now, secret }), "bad");
  assert.equal(verifyFileLink(P, { exp, sig }, { now, secret: "other" }), "bad");
  for (const q of [{}, { exp }, { sig }, { exp: [exp], sig }, { exp, sig: [sig] }, { exp: "abc", sig }]) assert.equal(verifyFileLink(P, q, { now, secret }), "bad", JSON.stringify(q));
});

test("review result: new reviews, old data, approve feedback", () => {
  const hist = [{ type: "revision_requested", comment: "first" }, { type: "revision_requested", comment: "Fix the header", unmetCriteria: ["Mobile layout"] }];
  assert.deepEqual(reviewResult({ status: "In-Progress", reviewNote: "Fix the header", revisionHistory: hist, resubmissionCount: 2 }),
    { revisionReason: "Fix the header Not met: Mobile layout", feedback: null, revisionCount: 2 }, "T-4 review");
  assert.equal(reviewResult({ status: "In-Progress", rejectionFeedback: "old reason" }).revisionReason, "old reason", "old path");
  assert.equal(reviewResult({ status: "In-Progress", revisionNotes: "older" }).revisionReason, "older", "oldest field");
  assert.equal(reviewResult({ status: "In-Progress", reviewNote: "legacy review", resubmissionCount: 1 }).revisionReason, "legacy review", "POST /review path");
  assert.equal(reviewResult({ status: "In-Progress", reviewNote: null }).revisionReason, null);
  const done = reviewResult({ status: "Done", reviewNote: "Nice work", revisionHistory: hist, resubmissionCount: 2 });
  assert.equal(done.feedback, "Nice work");
  assert.equal(done.revisionReason, "Fix the header Not met: Mobile layout", "history stays");
  assert.deepEqual(reviewResult({ status: "In-Review", reviewNote: "x" }), { revisionReason: null, feedback: null, revisionCount: 0 }, "a note before any revision is not a reason");
  assert.equal(reviewResult({ status: "Done", reviewNote: "ok", revisionCount: 3 }).revisionCount, 3, "old count field");
});
