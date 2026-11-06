import mongoose          from "mongoose";
import Notification      from "../models/Notification.js";

const TIER_FROM_TYPE = {
  escalation:       "critical",
  org_health_drop:  "critical",
  system_incident:  "critical",
  approval_pending: "needs_action",
  project_at_risk:  "needs_action",
};

function tierFromType(type) {
  return TIER_FROM_TYPE[type] ?? "fyi";
}

// ── GET /api/director/notifications ──────────────────────────────────────────
export async function listNotifications(req, res) {
  const userId = req.user.id;
  const { tier, read, limit = "50" } = req.query;

  const q = { userId, muted: { $ne: true } };
  if (tier  && ["critical","needs_action","fyi"].includes(tier)) q.tier = tier;
  if (read  === "true")  q.read = true;
  if (read  === "false") q.read = false;
  // Exclude muted notifications
  q.$or = [{ muteUntil: null }, { muteUntil: { $lte: new Date() } }];
  // Exclude expired
  q.$and = [{ $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }];

  const docs = await Notification.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 200))
    .lean();

  // Back-fill tier from type for legacy records without it
  const data = docs.map(n => ({
    ...n,
    tier: n.tier ?? tierFromType(n.type),
  }));

  res.json({ data });
}

// ── GET /api/director/notifications/count ────────────────────────────────────
export async function countNotifications(req, res) {
  const userId = req.user.id;
  const base   = { userId, read: false, $or: [{ muteUntil: null }, { muteUntil: { $lte: new Date() } }] };

  const [total, critical, needs_action] = await Promise.all([
    Notification.countDocuments({ ...base }),
    Notification.countDocuments({ ...base, tier: "critical" }),
    Notification.countDocuments({ ...base, tier: "needs_action" }),
  ]);

  res.json({ total, unread: total, critical, needs_action });
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
  const q = { userId, read: false };
  if (tier && ["critical","needs_action","fyi"].includes(tier)) q.tier = tier;
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
