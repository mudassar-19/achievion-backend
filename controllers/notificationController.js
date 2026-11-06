import Notification from "../models/Notification.js";
import { getIo }    from "../utils/io.js";

// ── Shared helper — create a notification and push via socket ─────────────────
export async function createNotification({ userId, orgId, type, title, message, meta = {} }) {
  const notif = await Notification.create({ userId, orgId: orgId ?? null, type, title, message, meta });
  const io = getIo();
  if (io && !notif.muted) {
    io.to(`user:${userId}`).emit("notification:new", notif.toObject());
  }
  return notif;
}

// ── GET /api/notifications ─────────────────────────────────────────────────────
// Supports ?tab=all|unread|system|project|gamification&limit=N
export async function getNotifications(req, res) {
  const { tab = "all", limit } = req.query;
  const query = { userId: req.user.id, muted: { $ne: true } };

  if (tab === "unread") {
    query.read = false;
  } else if (tab === "system") {
    query.type = { $in: ["system", "risk_alert", "approval_requested", "approval_resolved"] };
  } else if (tab === "project") {
    query.type = { $regex: /^project_/ };
  } else if (tab === "gamification") {
    query.type = { $in: ["badge_unlocked", "badge_earned", "xp_gained", "level_up", "title_unlocked"] };
  }

  const notifications = await Notification.find(query)
    .sort({ createdAt: -1 })
    .limit(limit ? Math.min(parseInt(limit, 10) || 50, 100) : 50)
    .lean();
  res.json({ success: true, notifications });
}

// ── GET /api/notifications/unread-count ───────────────────────────────────────
export async function getUnreadCount(req, res) {
  const count = await Notification.countDocuments({ userId: req.user.id, read: false });
  res.json({ success: true, count });
}

// ── PATCH /api/notifications/read-all ─────────────────────────────────────────
export async function markAllRead(req, res) {
  await Notification.updateMany(
    { userId: req.user.id, read: false },
    { $set: { read: true } }
  );
  res.json({ success: true });
}

// ── PATCH /api/notifications/:id/read ─────────────────────────────────────────
export async function markOneRead(req, res) {
  const notif = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { $set: { read: true } },
    { returnDocument: "after" }
  ).lean();
  if (!notif) return res.status(404).json({ error: "Notification not found." });
  res.json({ success: true, notification: notif });
}

// ── DELETE /api/notifications/:id ────────────────────────────────────────────
export async function deleteOne(req, res) {
  const notif = await Notification.findOneAndDelete({
    _id: req.params.id,
    userId: req.user.id,
  }).lean();
  if (!notif) return res.status(404).json({ error: "Notification not found." });
  res.json({ success: true });
}

// ── DELETE /api/notifications ─────────────────────────────────────────────────
export async function deleteAll(req, res) {
  await Notification.deleteMany({ userId: req.user.id });
  res.json({ success: true });
}
