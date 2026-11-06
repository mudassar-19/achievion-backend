// V2 Phase 2 communities rules (ACHIEVION_BUILD_PLAN_V2 "COMMUNITIES: RULES", D-074).
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../services/chatRules.js";

const DIR = { id: "d1", role: "Director" };
const MGR = { id: "m1", role: "Manager" };
const TL  = { id: "t1", role: "Team Lead" };
const DEV = { id: "u1", role: "Developer" };
const DES = { id: "u2", role: "Senior Designer" };
const QA  = { id: "u3", role: "Tester" };
const ALL = [DIR, MGR, TL, DEV, DES, QA];
const who = (fn) => ALL.filter(fn).map((u) => u.role);

test("role table: create community = Director, Manager only", () => {
  assert.deepEqual(who((u) => R.canCreateCommunity(u.role)), ["Director", "Manager"]);
});

test("role table: create group = Director, Manager, Team Lead", () => {
  assert.deepEqual(who((u) => R.canCreateGroup(u.role)), ["Director", "Manager", "Team Lead"]);
});

test("role table: group request = employees only; decide = Manager, Team Lead", () => {
  assert.deepEqual(who((u) => R.canRequestGroup(u.role)), ["Developer", "Senior Designer", "Tester"]);
  assert.deepEqual(who((u) => R.canDecideGroupRequest(u.role)), ["Manager", "Team Lead"]);
});

test("role table: archive community = Director; nominate group admin = Manager", () => {
  assert.deepEqual(who((u) => R.canArchiveCommunity(u.role)), ["Director"]);
  assert.deepEqual(who((u) => R.canNominateGroupAdmin(u.role)), ["Manager"]);
});

test("Director and Manager are always members and community admins", () => {
  assert.deepEqual(who((u) => R.isAlwaysMember(u.role)), ["Director", "Manager"]);
  const c = { memberIds: [], adminIds: [] };
  assert.equal(R.isCommunityMember(c, MGR), true);
  assert.equal(R.isCommunityMember(c, DEV), false);
  assert.equal(R.isCommunityMember({ memberIds: ["u1"] }, DEV), true);
  assert.deepEqual(who((u) => R.isCommunityAdmin(u)), ["Director", "Manager"]);
});

test("group admin = Director, Manager, or a nominated member", () => {
  const g = { memberIds: ["t1", "u1"], adminIds: ["u1"] };
  assert.deepEqual(who((u) => R.isGroupAdmin(g, u)), ["Director", "Manager", "Developer"]);
});

test("Director/Manager cannot be removed or leave; others can", () => {
  assert.equal(R.removalBlocked(MGR.role), "Directors and Managers are always members and cannot be removed.");
  assert.equal(R.removalBlocked(DIR.role) !== null, true);
  assert.equal(R.removalBlocked(TL.role), null);
  assert.equal(R.leaveBlocked({ type: "custom" }, DEV), null);
  assert.notEqual(R.leaveBlocked({ type: "custom" }, MGR), null);
  assert.notEqual(R.leaveBlocked({ type: "announcement" }, DEV), null); // leave the community, not its announcement group
});

test("send: everyone-groups allow members; admins-only allow admins and granted posters", () => {
  const open = { type: "custom", memberIds: ["u1"], adminIds: [], permissions: { sendMessages: "everyone" } };
  assert.equal(R.canSend(open, DEV), true);
  assert.equal(R.canSend(open, DES), false); // not a member
  const ann = { type: "announcement", memberIds: ["u1", "u2", "t1"], adminIds: [], posterIds: ["u2"], permissions: { sendMessages: "admins" } };
  assert.deepEqual(who((u) => R.canSend(ann, u)), ["Director", "Manager", "Senior Designer"]);
});

test("send: announcement is admins-only even if the stored setting says everyone", () => {
  const ann = { type: "announcement", memberIds: ["u1"], adminIds: [], permissions: { sendMessages: "everyone" } };
  assert.equal(R.canSend(ann, DEV), false);
  assert.equal(R.effectiveSendMode(ann), "admins");
});

test("send: DM only between its two members; Director/Manager not auto-members of DMs", () => {
  const dm = { type: "dm", memberIds: ["u1", "u2"] };
  assert.equal(R.canSend(dm, DEV), true);
  assert.equal(R.canSend(dm, MGR), false);
  assert.equal(R.canView(dm, DIR), false);
});

test("edit group info follows editInfo; settings and members need a group admin", () => {
  const g = { type: "custom", memberIds: ["u1"], adminIds: [], permissions: { editInfo: "admins" } };
  assert.equal(R.canEditGroupInfo(g, DEV), false);
  assert.equal(R.canEditGroupInfo({ ...g, permissions: { editInfo: "everyone" } }, DEV), true);
  assert.equal(R.canEditGroupInfo({ ...g, permissions: { editInfo: "everyone" } }, DES), false);
  assert.deepEqual(who((u) => R.canManageGroup(g, u)), ["Director", "Manager"]);
});

test("delete message: sender, or a group admin", () => {
  const g = { type: "custom", memberIds: ["u1", "u2"], adminIds: ["u2"] };
  const msg = { sender: "u1" };
  assert.deepEqual(who((u) => R.canDeleteMessage(g, msg, u)), ["Director", "Manager", "Developer", "Senior Designer"]);
});

test("withLeaders adds Director/Manager ids once", () => {
  assert.deepEqual(R.withLeaders(["u1", "m1"], ["d1", "m1"]).sort(), ["d1", "m1", "u1"]);
});

test("join: open group joins at once, approval group makes a request, announcement is not joinable", () => {
  const c = { memberIds: ["u1"] };
  assert.equal(R.joinMode({ type: "custom", joinApproval: false, memberIds: [] }, c, DEV), "join");
  assert.equal(R.joinMode({ type: "custom", joinApproval: true, memberIds: [] }, c, DEV), "request");
  assert.equal(R.joinMode({ type: "custom", memberIds: ["u1"] }, c, DEV), "already");
  assert.equal(R.joinMode({ type: "custom", memberIds: [] }, c, DES), "not_in_community");
  assert.equal(R.joinMode({ type: "announcement", memberIds: [] }, c, DEV), "already");
});

test("reactions: toggle one emoji per user, reject emojis outside the set", () => {
  let r = R.toggleReaction([], "u1", "👍");
  assert.deepEqual(r, [{ emoji: "👍", userId: "u1" }]);
  r = R.toggleReaction(r, "u2", "👍");
  r = R.toggleReaction(r, "u1", "❤️");               // switching replaces u1's reaction
  assert.deepEqual(r, [{ emoji: "👍", userId: "u2" }, { emoji: "❤️", userId: "u1" }]);
  r = R.toggleReaction(r, "u1", "❤️");               // same again removes it
  assert.deepEqual(r, [{ emoji: "👍", userId: "u2" }]);
  assert.equal(R.isAllowedReaction("🦄"), false);
  assert.equal(R.isAllowedReaction("👍"), true);
});

test("legacy org channels (no community, default or no member list) stay open to the org", () => {
  assert.equal(R.canView({ type: "general", isDefault: true, memberIds: ["x"] }, DEV), true);
  assert.equal(R.canView({ type: "general", memberIds: [] }, DEV), true);
  assert.equal(R.canView({ type: "announcement", communityId: "c1", isDefault: true, memberIds: [] }, DEV), false);
});
