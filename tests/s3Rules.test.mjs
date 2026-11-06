// S-3: last small security items (S8..S12).
import test from "node:test";
import assert from "node:assert/strict";
import { selfUpdateError, avatarLockError, coworkerFields, errorStatus, taskEventAudience } from "../services/accessRules.js";

test("S8: nobody changes their own department through /auth/me", () => {
  for (const role of ["Developer", "Team Lead", "Manager", "Director"]) assert.match(selfUpdateError({ department: "Design" }, role), /Director/, role);
  assert.equal(selfUpdateError({ name: "A" }, "Developer"), null);
  assert.equal(selfUpdateError({ name: "A", department: undefined }, "Developer"), null);
});

test("S9: avatar locks are checked on the server, same table as the Avatar page", () => {
  const lv = (level, x = {}) => ({ level, streak: 0, badges: [], ...x });
  assert.equal(avatarLockError({ style: "bottts" }, lv(1)), null);
  assert.match(avatarLockError({ style: "adventurer" }, lv(4)), /Level 5/);
  assert.equal(avatarLockError({ style: "adventurer" }, lv(5)), null);
  assert.match(avatarLockError({ style: "croodles" }, lv(25, { streak: 29 })), /30-day streak/);
  assert.equal(avatarLockError({ style: "croodles" }, lv(20, { streak: 30 })), null);
  assert.match(avatarLockError({ style: "open-peeps" }, lv(15)), /badge/);
  assert.equal(avatarLockError({ style: "open-peeps" }, lv(15, { badges: ["speed_demon"] })), null);
  assert.match(avatarLockError({ visualStyle: "neon" }, lv(9)), /Level 10/);
  assert.match(avatarLockError({ preset: "nova" }, lv(9)), /Level 10/);
  assert.match(avatarLockError({ effects: ["glow", "particle"] }, lv(14)), /Level 15/);
  assert.equal(avatarLockError({ effects: ["glow"], preset: null, visualStyle: "minimal", background: "solar" }, lv(3)), null);
});

test("S10: only leads see coworkers' emails", () => {
  for (const r of ["Director", "Manager", "Team Lead"]) assert.equal(coworkerFields(r).includes("email"), true, r);
  for (const r of ["Developer", "Senior Designer", "Tester"]) assert.equal(coworkerFields(r).includes("email"), false, r);
});

test("S11: a malformed id is a 404, not a 500", () => {
  assert.equal(errorStatus({ name: "CastError", kind: "ObjectId", path: "_id" }), 404);
  assert.equal(errorStatus({ name: "CastError", kind: "ObjectId", path: "projectId" }), 400);
  assert.equal(errorStatus({ name: "CastError", kind: "Number" }), 400);
  assert.equal(errorStatus({ status: 403 }), 403);
  assert.equal(errorStatus(new Error("x")), 500);
});

test("S12: task events go to the task's people only", () => {
  const ids = taskEventAudience({ assignees: ["a", "b"], assignee: "a", createdBy: "tl" }, { members: ["tl", "c"], managerId: "m" });
  assert.deepEqual(ids.sort(), ["a", "b", "c", "m", "tl"]);
  assert.deepEqual(taskEventAudience({ assignees: [{ _id: "a" }], createdBy: null }, null), ["a"]);
});
