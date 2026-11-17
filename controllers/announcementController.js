// Items 79, 80 (D-548): one Announcements feed for every portal. Read-only for everyone; Director and Manager post.
//   GET  /api/announcements          → { items, unread, canPost, targets }
//   POST /api/announcements/read     { ids? } → marks them read for this person only
//   POST /api/announcements          { channelId, content } (Director, Manager) → posts into that Announcements group
// Rules come from chatRules (NFR03-03): the server decides who can read and post, whatever the screen shows.
import mongoose from "mongoose";
import ChatChannel from "../models/ChatChannel.js";
import ChatCommunity from "../models/ChatCommunity.js";
import ChatMessage from "../models/ChatMessage.js";
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import * as R from "../services/chatRules.js";
import { chatAudit } from "../services/chatService.js";
import { feedItems, postTargets, canPostAnnouncement, MAX_LEN } from "../services/announcements.js";
import { getIo } from "../utils/io.js";

const OID = (x) => new mongoose.Types.ObjectId(String(x));
const IS_OID = /^[0-9a-f]{24}$/i;
const portalLink = (role) => (role === "Director" ? "/director/announcements" : role === "Manager" ? "/manager/announcements" : role === "Team Lead" ? "/teamlead/announcements" : "/workspace/announcements");

async function visible(req) {
  const user = { id: req.user.id, role: req.user.role };
  const all = await ChatChannel.find({ orgId: OID(req.user.orgId), type: "announcement", isArchived: { $ne: true } }).lean();
  const channels = all.filter((c) => R.canView(c, user));
  const communities = await ChatCommunity.find({ _id: { $in: channels.map((c) => c.communityId).filter(Boolean) } }, "name type memberIds").lean();
  return { user, channels, communities };
}

export async function getAnnouncements(req, res) {
  const { user, channels, communities } = await visible(req);
  const messages = await ChatMessage.find({ channelId: { $in: channels.map((c) => c._id) }, deletedAt: null }, "channelId sender content createdAt readBy")
    .populate("sender", "name role").sort({ createdAt: -1 }).limit(200).lean();
  const canPost = canPostAnnouncement(user.role);
  const items = feedItems({ messages, channels, communities, meId: user.id, leader: canPost });
  res.json({ items, unread: items.filter((i) => i.unread).length, canPost, targets: canPost ? postTargets({ channels: channels.filter((c) => R.canSend(c, user)), communities }) : [] });
}

export async function markAnnouncementsRead(req, res) {
  const { channels } = await visible(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => IS_OID.test(String(x))).map(OID) : null;
  const r = await ChatMessage.updateMany({ channelId: { $in: channels.map((c) => c._id) }, readBy: { $ne: OID(req.user.id) }, ...(ids ? { _id: { $in: ids } } : {}) }, { $addToSet: { readBy: OID(req.user.id) } });
  res.json({ ok: true, marked: r.modifiedCount });
}

export async function postAnnouncement(req, res) {
  const content = String(req.body?.content ?? "").trim();
  if (!canPostAnnouncement(req.user.role)) return res.status(403).json({ error: "Only a Director or Manager can post an announcement." });
  if (!content) return res.status(400).json({ error: "Write the announcement first." });
  if (content.length > MAX_LEN) return res.status(400).json({ error: `An announcement can have at most ${MAX_LEN} characters.` });
  const { user, channels } = await visible(req);
  const channel = IS_OID.test(String(req.body?.channelId)) ? channels.find((c) => String(c._id) === String(req.body.channelId)) : null;
  if (!channel) return res.status(404).json({ error: "That announcements group was not found." });
  if (!R.canSend(channel, user)) return res.status(403).json({ error: "You cannot post in that group." });

  const msg = await ChatMessage.create({ orgId: OID(req.user.orgId), channelId: channel._id, sender: OID(req.user.id), content, readBy: [OID(req.user.id)] });
  const populated = await ChatMessage.findById(msg._id).populate("sender", "name role avatarStyle avatarSeed").lean();
  getIo()?.to(`chat:${channel._id}`).emit("chat:new_message", populated);

  // The bell: everyone in the group except the sender (offline people see it on their next login: it is saved).
  const readers = (await User.find({ _id: { $in: channel.memberIds.filter((m) => String(m) !== req.user.id) }, status: "active" }, "role").lean());
  const sender = populated.sender?.name ?? "A leader";
  if (readers.length) {
    const docs = await Notification.insertMany(readers.slice(0, 1000).map((u) => ({ userId: u._id, orgId: req.user.orgId, type: "announcement", tier: "fyi", title: `Announcement from ${sender}`,
      message: content.length > 80 ? `${content.slice(0, 79).trimEnd()}…` : content, deepLink: portalLink(u.role), meta: { channelId: String(channel._id), messageId: String(msg._id) } })), { ordered: false }).catch(() => []);
    for (const d of docs) getIo()?.to(`user:${d.userId}`).emit("notification:new", d.toObject());
  }
  chatAudit(req, "announcement_posted", `Announcement posted in "${channel.name}" (${channel.memberIds.length} members).`, { after: { channelId: String(channel._id), messageId: String(msg._id) } });
  res.status(201).json({ ok: true, id: msg._id });
}
