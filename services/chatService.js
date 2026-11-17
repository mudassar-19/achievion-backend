// DB helpers shared by the community and chat controllers (D-074). Rules live in chatRules.js.
import AuditLog      from "../models/AuditLog.js";
import ChatCommunity from "../models/ChatCommunity.js";
import ChatChannel   from "../models/ChatChannel.js";
import User          from "../models/User.js";
import ChatMessage   from "../models/ChatMessage.js";
import mongoose      from "mongoose";

// Directors + Managers of the org: auto-added to every community and group.
export async function orgLeaderIds(orgId) {
  const ids = await User.find({ orgId: String(orgId), role: { $in: ["Director", "Manager"] }, status: { $ne: "deleted" } }).distinct("_id");
  return ids.map(String);
}

export function chatAudit(req, action, detail, extra = {}) {
  return AuditLog.create({
    action, orgId: req.user.orgId, performedBy: req.user.id, scope: "chat", detail, ip: req.ip ?? null, ...extra,
  }).catch((e) => console.error(`[chat] audit ${action}:`, e.message));
}

// Being in any group means being in its community and its Announcements group.
export async function addToCommunity(communityId, userIds) {
  if (!communityId || !userIds.length) return;
  await ChatCommunity.updateOne({ _id: communityId }, { $addToSet: { memberIds: { $each: userIds } } });
  await ChatChannel.updateMany({ communityId, type: "announcement" }, { $addToSet: { memberIds: { $each: userIds } } });
}

// Removed from the community → removed from every group in it (announcement included).
export async function removeFromCommunity(communityId, userId) {
  await ChatCommunity.updateOne({ _id: communityId }, { $pull: { memberIds: userId, adminIds: userId } });
  await ChatChannel.updateMany({ communityId }, { $pull: { memberIds: userId, adminIds: userId, posterIds: userId, joinRequests: userId } });
}

export async function roleOf(userId, orgId) {
  return (await User.findOne({ _id: userId, orgId: String(orgId) }, "role").lean())?.role ?? null;
}

// Keep only ids of live users in this org (never trust ids from the request body).
export async function orgUserIds(orgId, ids) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((id) => /^[a-f\d]{24}$/i.test(id));
  if (!clean.length) return [];
  return (await User.find({ _id: { $in: clean }, orgId: String(orgId), status: { $ne: "deleted" } }).distinct("_id")).map(String);
}

// Unread counts for many channels in ONE aggregate (was one countDocuments per channel, D-078).
// Respects each person's "clear conversation" time.
export async function unreadCounts(channels, userId) {
  if (!channels.length) return {};
  const uid = new mongoose.Types.ObjectId(userId);
  const plain = [], cleared = [];
  for (const ch of channels) {
    const at = ch.clearedBy?.find((e) => String(e.userId) === String(userId))?.clearedAt;
    if (at) cleared.push({ channelId: ch._id, createdAt: { $gt: at } }); else plain.push(ch._id);
  }
  const rows = await ChatMessage.aggregate([
    { $match: { $or: [...(plain.length ? [{ channelId: { $in: plain } }] : []), ...cleared], sender: { $ne: uid }, readBy: { $ne: uid }, deletedAt: null } },
    { $group: { _id: "$channelId", n: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
}

// Last message of many channels in ONE aggregate, for the chat list preview (E-C 7, D-QA3B-8): { channelId: { text, at, from } }.
// Respects "clear conversation"; an attachment-only message shows as "Attachment".
export async function lastMessages(channels) {
  if (!channels.length) return {};
  const rows = await ChatMessage.aggregate([
    { $match: { channelId: { $in: channels.map((c) => c._id) }, deletedAt: null } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$channelId", content: { $first: "$content" }, at: { $first: "$createdAt" }, sender: { $first: "$sender" }, files: { $first: { $size: { $ifNull: ["$attachments", []] } } } } },
  ]);
  const names = new Map((await User.find({ _id: { $in: rows.map((r) => r.sender) } }, "name").lean()).map((u) => [String(u._id), u.name]));
  return Object.fromEntries(rows.map((r) => [String(r._id), {
    text: (r.content || (r.files ? "Attachment" : "")).slice(0, 80), at: r.at, from: String(names.get(String(r.sender)) ?? "").split(" ")[0] || null,
  }]));
}
