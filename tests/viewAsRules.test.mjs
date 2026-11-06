// View as (AUTH-11, M-8): scope, nesting, read-only guard, token claims, database write block.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { viewAsBlocker, guardDecision, viewAsClaims, baseRole, VIEW_AS_MINUTES } from "../services/viewAsRules.js";
import { runReadOnly, isReadOnly } from "../middleware/viewAs.js";

const ORG = "o1";
const mgr = { id: "m", role: "Manager", orgId: ORG }, dir = { id: "d", role: "Director", orgId: ORG };
const dev = { id: "u1", role: "Senior Developer", orgId: ORG, status: "active" };
const tl = { id: "u2", role: "Team Lead", orgId: ORG, status: "active" };
const otherMgr = { id: "m2", role: "Manager", orgId: ORG, status: "active" };
const team = new Set(["u1"]);

test("Manager: only people on their own projects, staff roles only", () => {
  assert.equal(viewAsBlocker({ viewer: mgr, target: dev, teamIds: team }), null);
  assert.equal(viewAsBlocker({ viewer: mgr, target: tl, teamIds: team }).status, 403); // not on my projects
  assert.equal(viewAsBlocker({ viewer: mgr, target: otherMgr, teamIds: new Set(["m2"]) }).status, 403); // Managers cannot view Managers
  assert.equal(viewAsBlocker({ viewer: mgr, target: dir, teamIds: new Set(["d"]) }).status, 403);
});

test("Director: whole org, Manager included; never another org, self, inactive", () => {
  assert.equal(viewAsBlocker({ viewer: dir, target: otherMgr }), null);
  assert.equal(viewAsBlocker({ viewer: dir, target: tl }), null);
  assert.equal(viewAsBlocker({ viewer: dir, target: { ...dev, orgId: "o2" } }).status, 404);
  assert.equal(viewAsBlocker({ viewer: dir, target: null }).status, 404);
  assert.equal(viewAsBlocker({ viewer: dir, target: { ...dir, status: "active" } }).status, 400);
  assert.equal(viewAsBlocker({ viewer: dir, target: { ...dev, status: "suspended" } }).status, 409);
});

test("no nested view-as; other roles cannot start one", () => {
  assert.equal(viewAsBlocker({ viewer: { ...dir, viewAs: { viewerId: "x" } }, target: dev }).status, 403);
  assert.equal(viewAsBlocker({ viewer: { id: "t", role: "Team Lead", orgId: ORG }, target: dev }).status, 403);
  assert.equal(baseRole("Junior Tester"), "Tester");
});

test("guard: every non-GET is blocked, exit is allowed, GETs run read-only, AI is off", () => {
  const v = { viewerId: "d" };
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) assert.equal(guardDecision({ method, path: "/api/tasks/1", viewAs: v }).block.status, 403);
  assert.deepEqual(guardDecision({ method: "POST", path: "/api/auth/view-as/exit", viewAs: v }), { readOnly: false });
  assert.equal(guardDecision({ method: "POST", path: "/api/auth/view-as", viewAs: v }).block.status, 403); // nested start
  assert.deepEqual(guardDecision({ method: "GET", path: "/api/tasks?x=1", viewAs: v }), { readOnly: true });
  assert.equal(guardDecision({ method: "GET", path: "/api/manager/ai/insight", viewAs: v }).block.status, 403);
  assert.deepEqual(guardDecision({ method: "POST", path: "/api/tasks", viewAs: null }), { readOnly: false });
  assert.equal(guardDecision({ method: "GET", path: "/api/Manager/AI/insight", viewAs: v }).block.status, 403); // case
  assert.equal(guardDecision({ method: "GET", path: "/api/manager/%61i/insight", viewAs: v }).block.status, 403); // encoded
  assert.deepEqual(guardDecision({ method: "POST", path: "/api/auth/view-as/exit/", viewAs: v }), { readOnly: false });
});

test("claims: token is the target, viewer kept, read-only, 30 minutes", () => {
  const c = viewAsClaims({ viewer: { _id: "d", role: "Director", name: "Dee", tokenVersion: 3 }, target: { _id: "u1", role: "Developer", name: "Uma", orgId: ORG, tokenVersion: 1 } });
  assert.equal(c.id, "u1");
  assert.deepEqual(c.viewAs, { viewerId: "d", viewerRole: "Director", viewerName: "Dee", viewerTokenVersion: 3, readOnly: true });
  assert.equal(VIEW_AS_MINUTES, 30);
});

test("database: writes refused inside a view-as request, allowed outside", async () => {
  mongoose.set("bufferCommands", false);
  const M = mongoose.model("ViewAsProbe", new mongoose.Schema({ a: Number }));
  const err = async (f) => { try { await f(); return null; } catch (e) { return e; } };
  const inside = [
    await runReadOnly(() => err(() => new M({ a: 1 }).save())),
    await runReadOnly(() => err(() => M.updateOne({}, { a: 2 }))),
    await runReadOnly(() => err(() => M.findOneAndUpdate({}, { a: 2 }, { upsert: true }))),
    await runReadOnly(() => err(() => M.deleteMany({}))),
    await runReadOnly(() => err(() => M.insertMany([{ a: 1 }]))),
  ];
  assert.ok(inside.every((e) => e?.viewAsReadOnly), inside.map((e) => e?.message).join(" | "));
  const outside = await err(() => new M({ a: 1 }).save()); // no DB here: fails, but not because of view-as
  assert.ok(!outside?.viewAsReadOnly);
  assert.equal(isReadOnly(), false);
});
