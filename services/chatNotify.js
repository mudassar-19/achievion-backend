// Item 77 (D-546): who the bell tells about a chat message. Pure planner + the one DB writer both send paths (REST and socket) use.
// Rule: a DM tells the other person; an @mention tells the member mentioned; a plain group message tells nobody (the dock and the
// chat page carry its unread count). A muted conversation stays quiet. Tests: server/tests/chatNotify.test.mjs.
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { getIo } from "../utils/io.js";

const has = (list, id) => (list ?? []).some((x) => String(x?._id ?? x) === String(id));

export function snippet(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "(attachment)";
  return t.length <= 80 ? t : `${t.slice(0, 79).trimEnd()}…`;
}

export function planChatNotices({ channel, message, senderId, senderName, mentionIds }) {
  const who = senderName || "Someone";
  if (channel.type === "dm") {
    const other = (channel.memberIds ?? []).map(String).find((id) => id !== String(senderId));
    if (!other || has(channel.mutedBy, other)) return [];
    return [{ userId: other, type: "dm_message", title: `${who} sent you a message`, message: snippet(message.content), meta: { channelId: String(channel._id), kind: "dm" } }];
  }
  const out = [];
  for (const id of [...new Set((mentionIds ?? []).map(String))]) {
    if (id === String(senderId) || !has(channel.memberIds, id) || has(channel.mutedBy, id)) continue;
    out.push({ userId: id, type: "mention", title: `${who} mentioned you in #${channel.name}`, message: snippet(message.content), meta: { channelId: String(channel._id), kind: "mention" } });
  }
  return out;
}

// Where a person's chat lives in their portal (the bell and the notifications page link there; `open` picks the conversation).
export const chatLinkFor = (role, channelId) => {
  const base = role === "Director" ? "/director/chat" : role === "Manager" ? "/manager/chat" : role === "Team Lead" ? "/teamlead/chat" : "/workspace/chat";
  return `${base}?open=${channelId}`;
};

// Writes the notices. A DM thread keeps ONE unread notice that is refreshed (count and latest text), not one per message.
export async function notifyChat({ channel, message, senderId, senderName, mentionIds, orgId }) {
  const notices = planChatNotices({ channel, message, senderId, senderName, mentionIds });
  if (!notices.length) return;
  const roles = new Map((await User.find({ _id: { $in: notices.map((n) => n.userId) } }, "role").lean()).map((u) => [String(u._id), u.role]));
  for (const n of notices) {
    try {
      n.deepLink = chatLinkFor(roles.get(String(n.userId)), n.meta.channelId);
      let doc = null;
      if (n.type === "dm_message") {
        doc = await Notification.findOneAndUpdate({ userId: n.userId, type: "dm_message", read: false, "meta.channelId": n.meta.channelId },
          { $set: { message: n.message, title: n.title, createdAt: new Date() }, $inc: { "meta.count": 1 } }, { returnDocument: "after" });
      }
      if (!doc) doc = await Notification.create({ userId: n.userId, orgId, type: n.type, tier: "fyi", title: n.title, message: n.message, deepLink: n.deepLink, meta: { ...n.meta, count: 1 } });
      if (!doc.muted) getIo()?.to(`user:${n.userId}`).emit("notification:new", doc.toObject());
    } catch { /* a notice that cannot be written never blocks the message */ }
  }
}

// Reading a conversation clears its bell notices (the same unread, everywhere).
export const markChatNoticesRead = (userId, channelId) =>
  Notification.updateMany({ userId, type: { $in: ["dm_message", "mention"] }, read: false, "meta.channelId": String(channelId) }, { $set: { read: true } });
