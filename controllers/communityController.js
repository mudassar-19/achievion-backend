import ChatCommunity from "../models/ChatCommunity.js";
import { coworkerFields } from "../services/accessRules.js";
import { firstLengthError } from "../services/textLimits.js";
import ChatChannel   from "../models/ChatChannel.js";
import User          from "../models/User.js";
import Notification  from "../models/Notification.js";
import mongoose      from "mongoose";
import * as R        from "../services/chatRules.js";
import { orgLeaderIds, orgUserIds, chatAudit, addToCommunity, removeFromCommunity, roleOf, unreadCounts } from "../services/chatService.js";

// Rules: ACHIEVION_BUILD_PLAN_V2.md "COMMUNITIES: RULES", enforced via services/chatRules.js (D-074).
const { ObjectId } = mongoose.Types;
function toOid(id) { return new ObjectId(id); }
const me = (req) => ({ id: req.user.id, role: req.user.role });
const GROUP_TYPES = ["custom", "general", "project", "team", "department"];
const slug = (s) => s.trim().toLowerCase().replace(/\s+/g, "-");

async function loadCommunity(req, res, { lean = false } = {}) {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: "Community not found." }); return null; }
  const q = ChatCommunity.findById(req.params.id);
  const community = lean ? await q.lean() : await q;
  if (!community || String(community.orgId) !== req.user.orgId) { res.status(404).json({ error: "Community not found." }); return null; }
  return community;
}

function permissionsFrom(body) {
  const p = body?.permissions ?? {};
  const pick = (v, d) => (["everyone", "admins"].includes(v) ? v : d);
  return { sendMessages: pick(p.sendMessages, "everyone"), editInfo: pick(p.editInfo, "admins"), addMembers: "admins" };
}

// ── GET /api/communities — communities, my groups, groups I can join, group requests ──
export async function getCommunities(req, res) {
  const { id: userId, orgId } = req.user;
  const user = me(req);
  const leader = R.isAlwaysMember(user.role);
  const showArchived = R.canArchiveCommunity(user.role) && req.query.archived === "1";

  const communities = await ChatCommunity.find({
    orgId: toOid(orgId),
    isArchived: showArchived ? true : { $ne: true },
    ...(leader ? {} : { memberIds: toOid(userId) }),
  }).populate("groupRequests.requestedBy", "name role").sort({ name: 1 }).lean();

  const groups = await ChatChannel.find({
    communityId: { $in: communities.map((c) => c._id) }, type: { $ne: "dm" }, isArchived: { $ne: true },
  }).sort({ isDefault: -1, name: 1 }).lean();

  const unread = await unreadCounts(groups.filter((g) => R.canView(g, user)), userId);
  const result = communities.map((c) => {
    const mine = [], joinable = [];
    for (const g of groups.filter((x) => String(x.communityId) === String(c._id))) {
      if (R.canView(g, user)) mine.push({ ...g, unread: unread[String(g._id)] ?? 0, muted: (g.mutedBy ?? []).some((m) => String(m) === userId) });
      else joinable.push({ _id: g._id, name: g.name, icon: g.icon, description: g.description, joinApproval: !!g.joinApproval,
        requested: (g.joinRequests ?? []).some((m) => String(m) === userId) });
    }
    const requests = (c.groupRequests ?? []).filter((r) =>
      (R.canDecideGroupRequest(user.role) && r.status === "pending") || String(r.requestedBy?._id ?? r.requestedBy) === userId);
    const { groupRequests: _all, ...rest } = c;
    return {
      ...rest, groups: mine, joinable, groupRequests: requests,
      can: {
        manage: R.isCommunityAdmin(user), createGroup: R.canCreateGroup(user.role), requestGroup: R.canRequestGroup(user.role),
        decideRequests: R.canDecideGroupRequest(user.role), archive: R.canArchiveCommunity(user.role),
      },
    };
  });
  res.json(result);
}

// ── POST /api/communities — Director / Manager ────────────────────────────────
export async function createCommunity(req, res) {
  const { id: userId, orgId, role } = req.user;
  if (!R.canCreateCommunity(role)) return res.status(403).json({ error: "Only Directors and Managers can create communities." });

  const { name, description = "", icon = "💬", type = "custom", memberIds = [], projectId, department, teamId, initialGroups = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Community name is required." });
  const tooLong = firstLengthError([["Community name", name, "name"], ["Description", description, "description"]]);
  if (tooLong) return res.status(400).json({ error: tooLong });

  const leaders = await orgLeaderIds(orgId);
  const members = R.withLeaders([userId, ...(await orgUserIds(orgId, memberIds))], leaders);

  let community;
  try {
    community = await ChatCommunity.create({
      orgId: toOid(orgId), name: name.trim(), description: String(description).trim(), icon,
      type: ["organization", "project", "department", "team", "custom"].includes(type) ? type : "custom",
      projectId: mongoose.isValidObjectId(projectId) ? toOid(projectId) : null,
      department: department ?? null, teamId: mongoose.isValidObjectId(teamId) ? toOid(teamId) : null,
      createdBy: toOid(userId), adminIds: leaders.map(toOid), memberIds: members.map(toOid),
      settings: { addMembers: "admins", editInfo: "admins" },
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A community with this name already exists." });
    throw err;
  }

  const announcements = await ChatChannel.create({
    orgId: toOid(orgId), communityId: community._id, name: "announcements", description: "Official announcements", icon: "📢",
    type: "announcement", memberIds: members.map(toOid), adminIds: leaders.map(toOid), createdBy: toOid(userId), isDefault: true,
    permissions: { sendMessages: "admins", editInfo: "admins", addMembers: "admins" },
  });

  const createdGroups = [announcements.toObject()];
  for (const g of initialGroups) {
    if (!g?.name?.trim()) continue;
    const gMembers = g.memberIds?.length ? R.withLeaders([userId, ...(await orgUserIds(orgId, g.memberIds))], leaders) : members;
    try {
      const group = await ChatChannel.create({
        orgId: toOid(orgId), communityId: community._id, name: slug(g.name), description: g.description?.trim() ?? "",
        icon: g.icon ?? "💬", type: "custom", memberIds: gMembers.map(toOid), adminIds: [toOid(userId)], createdBy: toOid(userId),
      });
      await addToCommunity(community._id, gMembers);
      createdGroups.push(group.toObject());
    } catch { /* duplicate name — skip */ }
  }

  chatAudit(req, "community_created", `Created community "${community.name}"`, { after: { communityId: String(community._id), members: members.length } });
  res.status(201).json({ community: community.toObject(), groups: createdGroups });
}

// ── GET /api/communities/:id ──────────────────────────────────────────────────
export async function getCommunityInfo(req, res) {
  const community = await loadCommunity(req, res, { lean: true });
  if (!community) return;
  if (!R.isCommunityMember(community, me(req))) return res.status(403).json({ error: "Not a member." });
  const populated = await ChatCommunity.findById(community._id, "-groupRequests")
    .populate("createdBy", "name role").populate("memberIds", "name role avatarStyle avatarSeed").lean();
  const groups = await ChatChannel.find({ communityId: community._id, type: { $ne: "dm" }, isArchived: { $ne: true } }).lean();
  res.json({ ...populated, groups: groups.filter((g) => R.canView(g, me(req))) });
}

// ── PATCH /api/communities/:id — name / description / icon (community admins) ──
export async function updateCommunity(req, res) {
  const community = await loadCommunity(req, res);
  if (!community) return;
  if (!R.isCommunityAdmin(me(req))) return res.status(403).json({ error: "Only the Director or a Manager can edit community info." });

  const before = { name: community.name, description: community.description, icon: community.icon };
  const { name, description, icon } = req.body;
  if (name?.trim()) community.name = name.trim();
  if (description !== undefined) community.description = String(description).trim();
  if (icon) community.icon = icon;
  try { await community.save(); } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A community with this name already exists." });
    throw err;
  }
  chatAudit(req, "community_updated", `Edited community "${community.name}"`, { before, after: { name: community.name, description: community.description, icon: community.icon } });
  res.json(community);
}

// ── PATCH /api/communities/:id/archive { archived } — Director only ───────────
export async function archiveCommunity(req, res) {
  const community = await loadCommunity(req, res);
  if (!community) return;
  if (!R.canArchiveCommunity(req.user.role)) return res.status(403).json({ error: "Only the Director can deactivate a community." });
  community.isArchived = req.body?.archived !== false;
  await community.save();
  chatAudit(req, community.isArchived ? "community_archived" : "community_restored",
    `${community.isArchived ? "Deactivated" : "Restored"} community "${community.name}"`);
  res.json({ ok: true, isArchived: community.isArchived });
}

// ── POST /api/communities/:id/members { userIds } — community admins ─────────
export async function addCommunityMembers(req, res) {
  const community = await loadCommunity(req, res, { lean: true });
  if (!community) return;
  if (!R.isCommunityAdmin(me(req))) return res.status(403).json({ error: "Only the Director or a Manager can add community members." });
  const ids = await orgUserIds(req.user.orgId, req.body?.userIds);
  if (!ids.length) return res.status(400).json({ error: "Choose at least one person from your organization." });
  await addToCommunity(community._id, ids);
  chatAudit(req, "community_member_added", `Added ${ids.length} member(s) to "${community.name}"`, { after: { userIds: ids } });
  res.json({ ok: true });
}

// ── DELETE /api/communities/:id/members/:userId — also leaves every group ────
export async function removeCommunityMember(req, res) {
  const community = await loadCommunity(req, res, { lean: true });
  if (!community) return;
  if (!R.isCommunityAdmin(me(req))) return res.status(403).json({ error: "Only the Director or a Manager can remove community members." });
  const targetId = req.params.userId;
  if (!mongoose.isValidObjectId(targetId)) return res.status(400).json({ error: "Invalid user." });
  const blocked = R.removalBlocked(await roleOf(targetId, req.user.orgId));
  if (blocked) return res.status(409).json({ error: blocked });
  await removeFromCommunity(community._id, targetId);
  chatAudit(req, "community_member_removed", `Removed a member from "${community.name}" and all its groups`, { targetUserId: targetId });
  res.json({ ok: true });
}

// ── POST /api/communities/:id/groups — Director / Manager / Team Lead ─────────
export async function createGroup(req, res) {
  const { id: userId, orgId, role } = req.user;
  const community = await loadCommunity(req, res, { lean: true });
  if (!community) return;
  if (community.isArchived) return res.status(409).json({ error: "This community is deactivated." });
  if (!R.canCreateGroup(role)) return res.status(403).json({ error: "Only the Director, Managers and Team Leads can create groups. You can send a group request instead." });
  if (!R.isCommunityMember(community, me(req))) return res.status(403).json({ error: "Not a community member." });

  const { name, description = "", icon = "💬", type = "custom", memberIds = [], joinApproval = false } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Group name is required." });

  const members = R.withLeaders([userId, ...(await orgUserIds(orgId, memberIds))], await orgLeaderIds(orgId));
  try {
    const group = await ChatChannel.create({
      orgId: toOid(orgId), communityId: community._id, name: slug(name), description: String(description).trim(), icon,
      type: GROUP_TYPES.includes(type) ? type : "custom", memberIds: members.map(toOid), adminIds: [toOid(userId)],
      createdBy: toOid(userId), permissions: permissionsFrom(req.body), joinApproval: joinApproval === true,
    });
    await addToCommunity(community._id, members);
    chatAudit(req, "group_created", `Created group "${group.name}" in "${community.name}"`, { after: { groupId: String(group._id) } });
    res.status(201).json(group);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A group with this name already exists." });
    throw err;
  }
}

// ── POST /api/communities/:id/group-requests { name, description } — employees ──
export async function requestGroup(req, res) {
  const { id: userId, orgId, role } = req.user;
  const community = await loadCommunity(req, res);
  if (!community) return;
  if (community.isArchived) return res.status(409).json({ error: "This community is deactivated." });
  if (!R.canRequestGroup(role)) return res.status(403).json({ error: "You can create the group yourself." });
  if (!R.isCommunityMember(community, me(req))) return res.status(403).json({ error: "Not a community member." });

  const name = String(req.body?.name ?? "").trim();
  const description = String(req.body?.description ?? "").trim();
  if (!name || name.length > 60) return res.status(400).json({ error: "Group name is required (60 characters max)." });
  if (description.length > 300) return res.status(400).json({ error: "Reason is too long (300 characters max)." });
  if (community.groupRequests.some((r) => r.status === "pending" && String(r.requestedBy) === userId))
    return res.status(409).json({ error: "You already have a pending group request in this community." });

  community.groupRequests.push({ requestedBy: toOid(userId), name, description });
  await community.save();

  const deciders = await User.find({ _id: { $in: community.memberIds }, role: { $in: ["Manager", "Team Lead"] }, status: { $ne: "deleted" } }).distinct("_id");
  const extraMgrs = await User.find({ orgId, role: "Manager", status: { $ne: "deleted" } }).distinct("_id");
  const to = [...new Set([...deciders, ...extraMgrs].map(String))];
  if (to.length) await Notification.insertMany(to.map((uid) => ({
    userId: uid, orgId, type: "system", tier: "needs_action", title: "Group request",
    message: `${req.user.name ?? "A team member"} asked for a group "${name}" in ${community.name}.`,
  }))).catch(() => {});
  res.status(201).json(community.groupRequests.at(-1));
}

// ── POST /api/communities/:id/group-requests/:reqId { decision } — Manager / Team Lead ──
export async function decideGroupRequest(req, res) {
  const { id: userId, orgId, role } = req.user;
  const community = await loadCommunity(req, res, { lean: true });
  if (!community) return;
  if (!R.canDecideGroupRequest(role)) return res.status(403).json({ error: "Only a Manager or Team Lead can decide group requests." });
  if (!R.isCommunityMember(community, me(req))) return res.status(403).json({ error: "Not a community member." });
  const decision = req.body?.decision;
  if (!["approve", "reject"].includes(decision)) return res.status(400).json({ error: "decision must be approve or reject." });
  if (!mongoose.isValidObjectId(req.params.reqId)) return res.status(404).json({ error: "Request not found." });

  // Claim atomically so two deciders cannot both act.
  const status = decision === "approve" ? "approved" : "rejected";
  const claimed = await ChatCommunity.findOneAndUpdate(
    { _id: community._id, groupRequests: { $elemMatch: { _id: toOid(req.params.reqId), status: "pending" } } },
    { $set: { "groupRequests.$.status": status, "groupRequests.$.decidedBy": toOid(userId), "groupRequests.$.decidedAt": new Date() } },
    { returnDocument: "after" },
  );
  if (!claimed) return res.status(409).json({ error: "This request was already decided." });
  const reqDoc = claimed.groupRequests.id(req.params.reqId);

  let group = null;
  if (status === "approved") {
    const members = R.withLeaders([String(reqDoc.requestedBy), userId], await orgLeaderIds(orgId));
    try {
      group = await ChatChannel.create({
        orgId: toOid(orgId), communityId: community._id, name: slug(reqDoc.name), description: reqDoc.description,
        type: "custom", memberIds: members.map(toOid), adminIds: [toOid(userId)], createdBy: toOid(userId),
        permissions: permissionsFrom({}),
      });
    } catch (err) {
      await ChatCommunity.updateOne({ _id: community._id, "groupRequests._id": reqDoc._id },
        { $set: { "groupRequests.$.status": "pending", "groupRequests.$.decidedBy": null, "groupRequests.$.decidedAt": null } });
      if (err.code === 11000) return res.status(409).json({ error: "A group with this name already exists. Reject the request or rename the existing group." });
      throw err;
    }
    await ChatCommunity.updateOne({ _id: community._id, "groupRequests._id": reqDoc._id }, { $set: { "groupRequests.$.groupId": group._id } });
    await addToCommunity(community._id, members);
  }

  chatAudit(req, `group_request_${status}`, `${status === "approved" ? "Approved" : "Rejected"} group request "${reqDoc.name}" in "${community.name}"`,
    { targetUserId: reqDoc.requestedBy, after: { groupId: group ? String(group._id) : null } });
  await Notification.create({
    userId: reqDoc.requestedBy, orgId, type: "system", tier: "fyi", title: `Group request ${status}`,
    message: status === "approved" ? `Your group "${group.name}" is ready in ${community.name}.` : `Your group request "${reqDoc.name}" was not approved.`,
  }).catch(() => {});
  res.json({ ok: true, status, group });
}

// ── GET /api/communities/:id/members ──────────────────────────────────────────
export async function getCommunityMembers(req, res) {
  const community = await loadCommunity(req, res, { lean: true });
  if (!community) return;
  if (!R.isCommunityMember(community, me(req))) return res.status(403).json({ error: "Not a member." });
  const members = await User.find(
    { $or: [{ _id: { $in: community.memberIds } }, { orgId: req.user.orgId, role: { $in: ["Director", "Manager"] } }], status: { $ne: "deleted" } },
    "name role email avatarStyle avatarSeed department",
  ).lean();
  res.json(members.map((m) => ({ ...m, isAdmin: R.isCommunityAdmin({ role: m.role }), isProtected: R.isAlwaysMember(m.role) })));
}

// ── GET /api/communities/org-users — member picker ────────────────────────────
export async function searchOrgUsers(req, res) {
  const { orgId } = req.user;
  const q = (req.query.q ?? "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter = { orgId, status: { $ne: "deleted" } };
  const fields = coworkerFields(req.user.role); // S10 (D-167): only leads see and search by email
  if (q) filter.$or = [{ name: { $regex: q, $options: "i" } }, ...(fields.includes("email") ? [{ email: { $regex: q, $options: "i" } }] : []), { role: { $regex: q, $options: "i" } }];
  res.json(await User.find(filter, fields).limit(30).lean());
}
