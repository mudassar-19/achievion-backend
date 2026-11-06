import ChatCommunity from "../models/ChatCommunity.js";
import { coworkerFields } from "../services/accessRules.js";
import { firstLengthError } from "../services/textLimits.js";
import ChatChannel   from "../models/ChatChannel.js";
import ChatMessage   from "../models/ChatMessage.js";
import User          from "../models/User.js";
import Notification  from "../models/Notification.js";
import mongoose      from "mongoose";
import * as R        from "../services/chatRules.js";
import { orgUserIds, chatAudit, addToCommunity, roleOf, unreadCounts } from "../services/chatService.js";
import { getIo }     from "../utils/io.js";

// Permissions: services/chatRules.js (D-074). Every admin action writes an AuditLog row.
const { ObjectId } = mongoose.Types;
function toOid(id) { return new ObjectId(id); }
const me = (req) => ({ id: req.user.id, role: req.user.role });
const POP_SENDER = "name role avatarStyle avatarSeed";

// Can user access this group? (kept async-compatible for the existing call sites)
async function isMember(channel, userId, userRole, orgId) {
  if (channel.orgId.toString() !== orgId) return false;
  return R.canView(channel, { id: userId, role: userRole });
}

// Load a non-DM channel in the caller's org, or answer 404.
async function loadGroup(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: "Group not found." }); return null; }
  const group = await ChatChannel.findById(req.params.id);
  if (!group || String(group.orgId) !== req.user.orgId || group.type === "dm") { res.status(404).json({ error: "Group not found." }); return null; }
  return group;
}

// ── GET /api/chat/channels — all groups this user can access (flat list) ──────
// Used by the sidebar to supplement community-structured data with DMs
export async function getChannels(req, res) {
  const { id: userId, orgId, role } = req.user;
  const orgOid = toOid(orgId);

  const all = await ChatChannel.find({ orgId: orgOid, isArchived: { $ne: true } }).sort({ type: 1, name: 1 }).lean();
  const channels = all.filter((ch) => R.canView(ch, { id: userId, role }));

  const counts = await unreadCounts(channels, userId); // one aggregate (D-078)
  const withUnread = channels.map((ch) => ({ ...ch, unread: counts[String(ch._id)] ?? 0 }));

  res.json(withUnread);
}

// ── POST /api/chat/channels — create standalone channel (legacy/DM support) ───
export async function createChannel(req, res) {
  const { role, id: userId, orgId } = req.user;
  const orgOid = toOid(orgId);
  const allowed = ["Manager", "Team Lead", "Director"];
  if (!allowed.includes(role)) {
    return res.status(403).json({ error: "Only Manager, Team Lead, or Director can create channels." });
  }

  const { name, description, type = "general", memberIds = [], projectId, teamId, postRoles, communityId } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Channel name is required." });
  const tooLong = firstLengthError([["Channel name", name, "name"], ["Description", description, "description"]]);
  if (tooLong) return res.status(400).json({ error: tooLong });
  // Groups inside a community go through /api/communities/:id/groups so the community rules apply.
  if (communityId || type === "announcement") return res.status(400).json({ error: "Create community groups from the community." });

  const creatorOid  = toOid(userId);
  const memberOids  = [...new Set([userId, ...memberIds])].map(toOid);
  const slug = type === "dm" ? name.trim() : name.trim().toLowerCase().replace(/\s+/g, "-");

  if (type === "dm" && memberOids.length === 2) {
    const existing = await ChatChannel.findOne({ orgId: orgOid, type: "dm", memberIds: { $all: memberOids, $size: 2 } });
    if (existing) return res.json(existing);
  }

  try {
    const channel = await ChatChannel.create({
      orgId:       orgOid,
      communityId: communityId ? toOid(communityId) : null,
      name:        slug,
      description: description?.trim() ?? "",
      type,
      memberIds:   memberOids,
      adminIds:    [creatorOid],
      projectId:   projectId ? toOid(projectId) : null,
      teamId:      teamId    ? toOid(teamId)    : null,
      postRoles:   postRoles ?? [],
      createdBy:   creatorOid,
    });
    res.status(201).json(channel);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "Channel name already exists." });
    throw err;
  }
}

// ── GET /api/chat/channels/:id/messages ───────────────────────────────────────
export async function getMessages(req, res) {
  const { id: userId, orgId, role } = req.user;
  const channel = await ChatChannel.findById(req.params.id).lean();
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  if (!(await isMember(channel, userId, role, orgId))) return res.status(403).json({ error: "Not a member." });

  const { before, limit = 50 } = req.query;
  // Apply per-user clear filter
  const clearedAt = channel.clearedBy?.find((e) => e.userId?.toString() === userId)?.clearedAt ?? null;

  const filter = { channelId: channel._id };
  if (before)    filter.createdAt = { ...(filter.createdAt ?? {}), $lt: new Date(before) };
  if (clearedAt) filter.createdAt = { ...(filter.createdAt ?? {}), $gt: clearedAt };

  const msgs = await ChatMessage.find(filter)
    .populate("sender",   "name role avatarStyle avatarSeed")
    .populate("mentions", "name role")
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .lean();

  await ChatMessage.updateMany(
    { channelId: channel._id, readBy: { $ne: toOid(userId) }, deletedAt: null },
    { $addToSet: { readBy: toOid(userId) } }
  );

  res.json(msgs.reverse());
}

// ── POST /api/chat/channels/:id/messages ─────────────────────────────────────
export async function sendMessage(req, res) {
  const { id: userId, orgId, role } = req.user;
  const channel = await ChatChannel.findById(req.params.id).lean();
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  if (!(await isMember(channel, userId, role, orgId))) return res.status(403).json({ error: "Not a member." });

  // Permission check: sendMessages (announcement = admins + granted posters)
  const legacyPostRoles = channel.postRoles ?? [];
  if (!R.canSend(channel, { id: userId, role })) {
    return res.status(403).json({ error: "Only admins can send messages in this group." });
  }
  // Legacy postRoles check
  if (legacyPostRoles.length && !legacyPostRoles.includes(role)) {
    return res.status(403).json({ error: "You do not have posting permission in this channel." });
  }

  const { content, clientId, mentions = [] } = req.body;
  if (!content?.trim() && !req.body.attachments?.length) return res.status(400).json({ error: "Message cannot be empty." });
  if ((content?.length ?? 0) > 2000) return res.status(400).json({ error: "Message too long (max 2000 chars)." });

  if (clientId) {
    const dup = await ChatMessage.findOne({ channelId: channel._id, clientId }).lean();
    if (dup) return res.json(dup);
  }

  const mentionOids = (mentions ?? []).filter(Boolean).map(toOid);
  const msg = await ChatMessage.create({
    orgId:     toOid(orgId),
    channelId: channel._id,
    sender:    toOid(userId),
    content:   content?.trim() ?? "",
    clientId:  clientId ?? null,
    mentions:  mentionOids,
    readBy:    [toOid(userId)],
  });

  const populated = await ChatMessage.findById(msg._id)
    .populate("sender",   "name role avatarStyle avatarSeed")
    .populate("mentions", "name role")
    .lean();

  for (const mOid of mentionOids) {
    if (mOid.toString() === userId) continue;
    await Notification.create({
      userId: mOid, orgId,
      type: "system", tier: "needs_action",
      title:   "You were mentioned",
      message: `${populated.sender?.name ?? "Someone"} mentioned you in #${channel.name}`,
      deepLink: `/chat/${channel._id}`,
    }).catch(() => {});
  }

  res.status(201).json(populated);
}

// ── PATCH /api/chat/messages/:id ─────────────────────────────────────────────
export async function editMessage(req, res) {
  const { id: userId } = req.user;
  const msg = await ChatMessage.findById(req.params.id);
  if (!msg) return res.status(404).json({ error: "Message not found." });
  if (msg.sender.toString() !== userId) return res.status(403).json({ error: "Can only edit your own messages." });
  if (msg.deletedAt) return res.status(409).json({ error: "Message was deleted." });
  if (Date.now() - msg.createdAt.getTime() > 5 * 60 * 1000) return res.status(409).json({ error: "Edit window has passed (5 minutes)." });

  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "Content cannot be empty." });
  if (content.length > 2000) return res.status(400).json({ error: "Message too long." });

  msg.content  = content.trim();
  msg.editedAt = new Date();
  await msg.save();

  const populated = await ChatMessage.findById(msg._id)
    .populate("sender",   "name role avatarStyle avatarSeed")
    .populate("mentions", "name role")
    .lean();
  res.json(populated);
}

// ── DELETE /api/chat/messages/:id ────────────────────────────────────────────
export async function deleteMessage(req, res) {
  const { id: userId, role } = req.user;
  const msg = await ChatMessage.findById(req.params.id);
  if (!msg) return res.status(404).json({ error: "Message not found." });

  const channel = await ChatChannel.findById(msg.channelId).lean();
  if (!channel || String(channel.orgId) !== req.user.orgId) return res.status(404).json({ error: "Message not found." });
  if (!R.canDeleteMessage(channel, msg, { id: userId, role })) return res.status(403).json({ error: "Cannot delete this message." });

  msg.deletedAt = new Date();
  msg.content   = "";
  await msg.save();
  if (String(msg.sender) !== userId) {
    chatAudit(req, "chat_message_removed", `Removed a message in "${channel.name}"`, { targetUserId: msg.sender });
  }
  getIo()?.to(`chat:${String(msg.channelId)}`).emit("chat:message_deleted", { _id: msg._id, channelId: msg.channelId });
  res.json({ deleted: true, _id: msg._id });
}

// ── POST /api/chat/channels/:id/read ─────────────────────────────────────────
export async function markRead(req, res) {
  const { id: userId, orgId, role } = req.user;
  const channel = await ChatChannel.findById(req.params.id).lean();
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  if (!(await isMember(channel, userId, role, orgId))) return res.status(403).json({ error: "Not a member." });

  await ChatMessage.updateMany(
    { channelId: channel._id, readBy: { $ne: toOid(userId) } },
    { $addToSet: { readBy: toOid(userId) } }
  );
  res.json({ ok: true });
}

// ── GET /api/chat/channels/:id/unread-count ───────────────────────────────────
export async function getUnreadCount(req, res) {
  const { id: userId } = req.user;
  const channel = await ChatChannel.findById(req.params.id).lean();
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  const clearedAt = channel.clearedBy?.find((e) => e.userId?.toString() === userId)?.clearedAt ?? null;
  const count = await ChatMessage.countDocuments({
    channelId: req.params.id,
    sender:    { $ne: toOid(userId) },
    readBy:    { $ne: toOid(userId) },
    deletedAt: null,
    ...(clearedAt ? { createdAt: { $gt: clearedAt } } : {}),
  });
  res.json({ count });
}

// ── GET /api/chat/channels/:id — group info ───────────────────────────────────
export async function getGroupInfo(req, res) {
  const { id: userId, orgId, role } = req.user;
  const channel = await ChatChannel.findById(req.params.id)
    .populate("createdBy", "name role")
    .populate("adminIds",  "name role avatarStyle avatarSeed")
    .populate("memberIds", "name role avatarStyle avatarSeed")
    .populate("joinRequests", "name role")
    .lean();
  if (!channel) return res.status(404).json({ error: "Group not found." });
  if (!(await isMember(channel, userId, role, orgId))) return res.status(403).json({ error: "Not a member." });
  const user = { id: userId, role };
  res.json({
    ...channel,
    joinRequests: R.canManageGroup(channel, user) ? channel.joinRequests : [],
    muted: (channel.mutedBy ?? []).some((m) => String(m) === userId),
    can: {
      manage: R.canManageGroup(channel, user), editInfo: R.canEditGroupInfo(channel, user), send: R.canSend(channel, user),
      nominateAdmins: R.canNominateGroupAdmin(role), leave: R.leaveBlocked(channel, user) === null,
    },
    sendMode: R.effectiveSendMode(channel),
  });
}

// ── PATCH /api/chat/channels/:id/settings — info (editInfo rule) + rules (group admins) ──
export async function updateGroupSettings(req, res) {
  const group = await loadGroup(req, res);
  if (!group) return;
  const user = me(req);
  const { name, description, icon, permissions, joinApproval } = req.body;
  const touchesInfo  = name !== undefined || description !== undefined || icon !== undefined;
  const touchesRules = permissions !== undefined || joinApproval !== undefined;
  if (touchesInfo && !R.canEditGroupInfo(group, user)) return res.status(403).json({ error: "Only group admins can edit group info." });
  if (touchesRules && !R.canManageGroup(group, user)) return res.status(403).json({ error: "Only group admins can change settings." });

  const snap = () => ({ name: group.name, description: group.description, icon: group.icon,
    sendMessages: group.permissions?.sendMessages, editInfo: group.permissions?.editInfo, joinApproval: group.joinApproval });
  const before = snap();
  const pick = (v, d) => (["everyone", "admins"].includes(v) ? v : d);
  if (name?.trim() && group.type !== "announcement") group.name = name.trim().toLowerCase().replace(/\s+/g, "-");
  if (description !== undefined) group.description = String(description).trim().slice(0, 300);
  if (icon) group.icon = icon;
  if (permissions) {
    if (group.type !== "announcement") group.permissions.sendMessages = pick(permissions.sendMessages, group.permissions.sendMessages);
    group.permissions.editInfo = pick(permissions.editInfo, group.permissions.editInfo);
  }
  if (joinApproval !== undefined && group.type !== "announcement") group.joinApproval = joinApproval === true;
  try { await group.save(); } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A group with this name already exists." });
    throw err;
  }
  chatAudit(req, "group_updated", `Changed settings of "${group.name}"`, { before, after: snap() });
  res.json(group);
}

// ── GET /api/chat/channels/:id/members — Directors/Managers always listed ─────
export async function getMembers(req, res) {
  const { id: userId, orgId, role } = req.user;
  const channel = await ChatChannel.findById(req.params.id).lean();
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  if (!(await isMember(channel, userId, role, orgId))) return res.status(403).json({ error: "Not a member." });

  const or = [{ _id: { $in: channel.memberIds ?? [] } }];
  if (channel.type !== "dm") or.push({ orgId, role: { $in: ["Director", "Manager"] } });
  const members = await User.find({ $or: or, status: { $ne: "deleted" } }, "name role avatarStyle avatarSeed department").lean();
  const posters = new Set((channel.posterIds ?? []).map(String));
  res.json(members.map((m) => ({
    ...m,
    isAdmin: R.isGroupAdmin(channel, { id: String(m._id), role: m.role }),
    isProtected: channel.type !== "dm" && R.isAlwaysMember(m.role),
    canPost: posters.has(String(m._id)),
  })));
}

// ── POST /api/chat/channels/:id/members { userIds } — group admins ────────────
export async function addMember(req, res) {
  const group = await loadGroup(req, res);
  if (!group) return;
  if (!R.canManageGroup(group, me(req))) return res.status(403).json({ error: "Only group admins can add members." });
  const ids = await orgUserIds(req.user.orgId, req.body?.userIds);
  if (!ids.length) return res.status(400).json({ error: "Choose at least one person from your organisation." });
  await ChatChannel.updateOne({ _id: group._id }, { $addToSet: { memberIds: { $each: ids.map(toOid) } }, $pull: { joinRequests: { $in: ids.map(toOid) } } });
  await addToCommunity(group.communityId, ids);
  chatAudit(req, "group_member_added", `Added ${ids.length} member(s) to "${group.name}"`, { after: { userIds: ids } });
  res.json({ ok: true });
}

// ── DELETE /api/chat/channels/:id/members/:uid — group admins; Director/Manager protected ──
export async function removeMember(req, res) {
  const group = await loadGroup(req, res);
  if (!group) return;
  if (!R.canManageGroup(group, me(req))) return res.status(403).json({ error: "Only group admins can remove members." });
  const targetId = req.params.uid;
  if (!mongoose.isValidObjectId(targetId)) return res.status(400).json({ error: "Invalid user." });
  const blocked = R.removalBlocked(await roleOf(targetId, req.user.orgId));
  if (blocked) return res.status(409).json({ error: blocked });
  if (group.type === "announcement") return res.status(409).json({ error: "Remove them from the community instead; Announcements follows the community." });
  await ChatChannel.updateOne({ _id: group._id }, { $pull: { memberIds: toOid(targetId), adminIds: toOid(targetId), posterIds: toOid(targetId) } });
  chatAudit(req, "group_member_removed", `Removed a member from "${group.name}"`, { targetUserId: targetId });
  res.json({ ok: true });
}

// ── POST /api/chat/channels/:id/leave ─────────────────────────────────────────
export async function leaveGroup(req, res) {
  const group = await loadGroup(req, res);
  if (!group) return;
  const blocked = R.leaveBlocked(group, me(req));
  if (blocked) return res.status(409).json({ error: blocked });
  const uid = toOid(req.user.id);
  await ChatChannel.updateOne({ _id: group._id }, { $pull: { memberIds: uid, adminIds: uid, posterIds: uid } });
  res.json({ ok: true });
}

// ── POST /api/chat/channels/:id/join — join, or ask when join approval is on ──
export async function joinGroup(req, res) {
  const group = await loadGroup(req, res);
  if (!group) return;
  const community = group.communityId ? await ChatCommunity.findById(group.communityId).lean() : null;
  if (!community || community.isArchived) return res.status(404).json({ error: "Group not found." });
  const mode = R.joinMode(group, community, me(req));
  if (mode === "not_in_community") return res.status(403).json({ error: "Join the community first." });
  if (mode === "already") return res.json({ ok: true, status: "member" });
  const uid = toOid(req.user.id);
  if (mode === "join") {
    await ChatChannel.updateOne({ _id: group._id }, { $addToSet: { memberIds: uid }, $pull: { joinRequests: uid } });
    return res.json({ ok: true, status: "member" });
  }
  await ChatChannel.updateOne({ _id: group._id }, { $addToSet: { joinRequests: uid } });
  res.json({ ok: true, status: "requested" });
}

// ── POST /api/chat/channels/:id/join-requests/:uid { approve } — group admins ──
export async function decideJoinRequest(req, res) {
  const group = await loadGroup(req, res);
  if (!group) return;
  if (!R.canManageGroup(group, me(req))) return res.status(403).json({ error: "Only group admins can decide join requests." });
  const targetId = req.params.uid;
  if (!mongoose.isValidObjectId(targetId)) return res.status(400).json({ error: "Invalid user." });
  const approve = req.body?.approve === true;
  const r = await ChatChannel.updateOne(
    { _id: group._id, joinRequests: toOid(targetId) },
    approve ? { $pull: { joinRequests: toOid(targetId) }, $addToSet: { memberIds: toOid(targetId) } } : { $pull: { joinRequests: toOid(targetId) } },
  );
  if (!r.modifiedCount) return res.status(409).json({ error: "No pending request from this person." });
  chatAudit(req, approve ? "group_join_approved" : "group_join_rejected", `${approve ? "Approved" : "Declined"} a join request for "${group.name}"`, { targetUserId: targetId });
  res.json({ ok: true });
}

// ── POST /api/chat/channels/:id/mute { muted } — per person ──────────────────
export async function muteGroup(req, res) {
  const { id: userId, orgId, role } = req.user;
  const channel = await ChatChannel.findById(req.params.id).lean();
  if (!channel || !(await isMember(channel, userId, role, orgId))) return res.status(404).json({ error: "Group not found." });
  const muted = req.body?.muted !== false;
  await ChatChannel.updateOne({ _id: channel._id }, muted ? { $addToSet: { mutedBy: toOid(userId) } } : { $pull: { mutedBy: toOid(userId) } });
  res.json({ ok: true, muted });
}

// ── POST /api/chat/channels/:id/admins { userId } — Manager nominates ────────
export async function addGroupAdmin(req, res) {
  const group = await loadGroup(req, res);
  if (!group) return;
  if (!R.canNominateGroupAdmin(req.user.role)) return res.status(403).json({ error: "Only a Manager can make someone a group admin." });
  const targetId = String(req.body?.userId ?? "");
  if (!group.memberIds.some((m) => String(m) === targetId)) return res.status(400).json({ error: "User must be a member first." });
  await ChatChannel.updateOne({ _id: group._id }, { $addToSet: { adminIds: toOid(targetId) } });
  chatAudit(req, "group_admin_added", `Made a member admin of "${group.name}"`, { targetUserId: targetId });
  res.json({ ok: true });
}

// ── DELETE /api/chat/channels/:id/admins/:uid — Manager ──────────────────────
export async function removeGroupAdmin(req, res) {
  const group = await loadGroup(req, res);
  if (!group) return;
  if (!R.canNominateGroupAdmin(req.user.role)) return res.status(403).json({ error: "Only a Manager can remove a group admin." });
  const targetId = req.params.uid;
  if (!mongoose.isValidObjectId(targetId)) return res.status(400).json({ error: "Invalid user." });
  if (R.isAlwaysMember(await roleOf(targetId, req.user.orgId))) return res.status(409).json({ error: "Directors and Managers are always group admins." });
  await ChatChannel.updateOne({ _id: group._id }, { $pull: { adminIds: toOid(targetId) } });
  chatAudit(req, "group_admin_removed", `Removed an admin of "${group.name}"`, { targetUserId: targetId });
  res.json({ ok: true });
}

// ── POST/DELETE /api/chat/channels/:id/posters — posting rights in admins-only groups ──
export async function addPoster(req, res) {
  const group = await loadGroup(req, res);
  if (!group) return;
  if (!R.canManageGroup(group, me(req))) return res.status(403).json({ error: "Only group admins can give posting rights." });
  const targetId = String(req.body?.userId ?? "");
  if (!group.memberIds.some((m) => String(m) === targetId)) return res.status(400).json({ error: "User must be a member first." });
  await ChatChannel.updateOne({ _id: group._id }, { $addToSet: { posterIds: toOid(targetId) } });
  chatAudit(req, "group_poster_added", `Allowed a member to post in "${group.name}"`, { targetUserId: targetId });
  res.json({ ok: true });
}

export async function removePoster(req, res) {
  const group = await loadGroup(req, res);
  if (!group) return;
  if (!R.canManageGroup(group, me(req))) return res.status(403).json({ error: "Only group admins can change posting rights." });
  const targetId = req.params.uid;
  if (!mongoose.isValidObjectId(targetId)) return res.status(400).json({ error: "Invalid user." });
  await ChatChannel.updateOne({ _id: group._id }, { $pull: { posterIds: toOid(targetId) } });
  chatAudit(req, "group_poster_removed", `Took back posting rights in "${group.name}"`, { targetUserId: targetId });
  res.json({ ok: true });
}

// ── POST /api/chat/channels/:id/clear — clear conversation for me ─────────────
export async function clearConversation(req, res) {
  const { id: userId, orgId, role } = req.user;
  const channel = await ChatChannel.findById(req.params.id);
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  if (!(await isMember(channel, userId, role, orgId))) return res.status(403).json({ error: "Not a member." });

  const now = new Date();
  const existing = channel.clearedBy?.findIndex((e) => e.userId?.toString() === userId);
  if (existing >= 0) {
    channel.clearedBy[existing].clearedAt = now;
  } else {
    (channel.clearedBy ??= []).push({ userId: toOid(userId), clearedAt: now });
  }
  await channel.save();
  res.json({ ok: true, clearedAt: now });
}

// ── GET /api/chat/dm/:userId ─────────────────────────────────────────────────
export async function getOrCreateDm(req, res) {
  const { id: userId, orgId } = req.user;
  const targetId = req.params.userId;
  if (targetId === userId) return res.status(400).json({ error: "Cannot DM yourself." });

  const orgOid  = toOid(orgId);
  const meOid   = toOid(userId);
  const themOid = toOid(targetId);

  const target = await User.findOne({ _id: themOid, orgId, status: { $ne: "deleted" } }, "name role").lean();
  if (!target) return res.status(404).json({ error: "User not found." });

  let channel = await ChatChannel.findOne({
    orgId: orgOid, type: "dm",
    memberIds: { $all: [meOid, themOid], $size: 2 },
  });

  if (!channel) {
    channel = await ChatChannel.create({
      orgId: orgOid,
      name:  `dm-${[userId, targetId].sort().join("-")}`,
      type:  "dm",
      memberIds: [meOid, themOid],
      adminIds:  [meOid],
      createdBy: meOid,
    });
  }

  res.json({ channel, target });
}

// ── GET /api/chat/users — search org users ───────────────────────────────────
export async function searchUsers(req, res) {
  const { orgId } = req.user;
  const q = (req.query.q ?? "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!q) return res.json([]);
  // S10 (D-167): only leads see and search by email.
  const fields = coworkerFields(req.user.role);
  const users = await User.find(
    { orgId, status: { $ne: "deleted" }, $or: [{ name: { $regex: q, $options: "i" } }, ...(fields.includes("email") ? [{ email: { $regex: q, $options: "i" } }] : [])] },
    fields.replace(" department", "")
  ).limit(10).lean();
  res.json(users);
}

// ── POST/DELETE /api/chat/channels/:id/pin/:msgId — group admins ─────────────
async function setPinned(req, res, pinned) {
  const group = await loadGroup(req, res);
  if (!group) return;
  if (!R.canManageGroup(group, me(req))) return res.status(403).json({ error: "Only group admins can pin messages." });
  if (!mongoose.isValidObjectId(req.params.msgId)) return res.status(404).json({ error: "Message not found." });
  const msg = await ChatMessage.findOneAndUpdate({ _id: req.params.msgId, channelId: group._id }, { $set: { isPinned: pinned } });
  if (!msg) return res.status(404).json({ error: "Message not found." });
  await ChatChannel.updateOne({ _id: group._id }, pinned ? { $addToSet: { pinnedMessages: msg._id } } : { $pull: { pinnedMessages: msg._id } });
  chatAudit(req, pinned ? "chat_message_pinned" : "chat_message_unpinned", `${pinned ? "Pinned" : "Unpinned"} a message in "${group.name}"`);
  res.json({ ok: true });
}
export const pinMessage   = (req, res) => setPinned(req, res, true);
export const unpinMessage = (req, res) => setPinned(req, res, false);

// ── POST /api/chat/messages/:id/reactions { emoji } — toggle (V1 3.7) ─────────
export async function reactToMessage(req, res) {
  const { id: userId, orgId, role } = req.user;
  const emoji = req.body?.emoji;
  if (!R.isAllowedReaction(emoji)) return res.status(400).json({ error: "Pick one of the offered reactions." });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Message not found." });
  const msg = await ChatMessage.findById(req.params.id);
  if (!msg || msg.deletedAt) return res.status(404).json({ error: "Message not found." });
  const channel = await ChatChannel.findById(msg.channelId).lean();
  if (!channel || !(await isMember(channel, userId, role, orgId))) return res.status(404).json({ error: "Message not found." });
  msg.reactions = R.toggleReaction(msg.reactions, userId, emoji);
  await msg.save();
  const populated = await ChatMessage.findById(msg._id).populate("sender", POP_SENDER).populate("mentions", "name role").lean();
  getIo()?.to(`chat:${String(msg.channelId)}`).emit("chat:message_updated", populated);
  res.json(populated);
}

// ── GET /api/chat/channels/:id/pinned — list pinned messages ─────────────────
export async function getPinnedMessages(req, res) {
  const { id: userId, orgId, role } = req.user;
  const channel = await ChatChannel.findById(req.params.id).lean();
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  if (!(await isMember(channel, userId, role, orgId))) return res.status(403).json({ error: "Not a member." });

  const msgs = await ChatMessage.find({ _id: { $in: channel.pinnedMessages ?? [] }, deletedAt: null })
    .populate("sender", "name role avatarStyle avatarSeed")
    .lean();
  res.json(msgs);
}
