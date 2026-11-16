import mongoose          from "mongoose";
import Notification      from "../models/Notification.js";

import { tierOf, tierFilter, countByTier } from "../services/notifTier.js";

// ── GET /api/director/notifications ──────────────────────────────────────────
// ?tier=&read=&limit= (max 200) &before=<ISO date of the last item seen> for the next page. → { data, hasMore }
// The tier follows the type (services/notifTier.js), so old approval records stored as FYI show under Needs action.
export async function listNotifications(req, res) {
  const userId = req.user.id;
  const { tier, read, limit = "50", before } = req.query;
  const take = Math.min(Number(limit) || 50, 200);

  const now = new Date();
  const and = [{ $or: [{ muteUntil: null }, { muteUntil: { $lte: now } }] }, { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }];
  const tf = tierFilter(tier);
  if (tf) and.push(tf);
  const q = { userId, muted: { $ne: true }, $and: and };
  if (read  === "true")  q.read = true;
  if (read  === "false") q.read = false;
  if (before && !Number.isNaN(+new Date(before))) q.createdAt = { $lt: new Date(before) };

  const docs = await Notification.find(q).sort({ createdAt: -1 }).limit(take + 1).lean();
  const data = docs.slice(0, take).map((n) => ({ ...n, tier: tierOf(n) }));
  res.json({ data, hasMore: docs.length > take });
}

// ── GET /api/director/notifications/count ────────────────────────────────────
// Unread totals per tier, muted ones excluded. { total, unread, critical, needs_action, fyi }
export async function countNotifications(req, res) {
  const rows = await Notification.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(req.user.id), read: false, muted: { $ne: true }, $or: [{ muteUntil: null }, { muteUntil: { $lte: new Date() } }] } },
    { $group: { _id: { type: "$type", tier: "$tier" }, n: { $sum: 1 } } },
  ]);
  const c = countByTier(rows);
  res.json({ ...c, unread: c.total });
}

// ── PATCH /api/director/notifications/:id/read ────────────────────────────────
export async function markRead(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id))
    return res.status(400).json({ error: "Invalid id." });

  const n = await Notification.findOneAndUpdate(
    { _id: id, userId: req.user.id },
    { $set: { read: true } },
    { new: true }
  );
  if (!n) return res.status(404).json({ error: "Not found." });
  res.json({ ok: true });
}

// ── POST /api/director/notifications/mark-all-read ────────────────────────────
export async function markAllRead(req, res) {
  const userId = req.user.id;
  const { tier } = req.body ?? {};
  const q = { userId, read: false, ...(tierFilter(tier) ?? {}) }; // same tier rule as the list and the counts
  await Notification.updateMany(q, { $set: { read: true } });
  res.json({ ok: true });
}

// ── PATCH /api/director/notifications/:id/mute ────────────────────────────────
export async function muteNotification(req, res) {
  const { id }    = req.params;
  const { until } = req.body ?? {};
  if (!mongoose.Types.ObjectId.isValid(id))
    return res.status(400).json({ error: "Invalid id." });

  const muteUntil = until ? new Date(until) : null;
  if (until && isNaN(muteUntil))
    return res.status(400).json({ error: "until must be a valid ISO date." });

  const n = await Notification.findOneAndUpdate(
    { _id: id, userId: req.user.id },
    { $set: { muteUntil } },
    { new: true }
  );
  if (!n) return res.status(404).json({ error: "Not found." });
  res.json({ ok: true });
}
