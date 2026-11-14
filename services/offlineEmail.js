// Offline email notifications (D-296, IMPL-5 Part 6).
// Called by createNotification callers for the four event types. Never blocks the main action.
// Guard: user offline (lastSeenAt > 5min), user setting on (default on), max 5/day, mail not configured → silent. Sent through utils/mailer.js (D-340).
import User         from "../models/User.js";
import Notification from "../models/Notification.js";
import { isMailConfigured, sendMail } from "../utils/mailer.js";
import { getIo }    from "../utils/io.js";

export const OFFLINE_EMAIL_TYPES = new Set([
  "task_assigned",
  "task_review_result",
  "deadline_24h",
  "extension_decision",
]);

const FIVE_MIN = 5 * 60 * 1000;
const DAY_MS   = 24 * 60 * 60 * 1000;

// In-memory per-user daily count. Resets when the process restarts or at midnight (good enough — no DB needed).
const dailyCounts = new Map(); // userId:dateStr → count

function todayKey(userId) { return `${userId}:${new Date().toISOString().slice(0, 10)}`; }
function countToday(userId) { return dailyCounts.get(todayKey(userId)) ?? 0; }
function bumpToday(userId) {
  const k = todayKey(userId);
  const yesterday = `${userId}:${new Date(Date.now() - DAY_MS).toISOString().slice(0, 10)}`;
  dailyCounts.delete(yesterday);
  dailyCounts.set(k, (dailyCounts.get(k) ?? 0) + 1);
}

function isOffline(userId) {
  const io = getIo();
  if (!io) return true; // no socket server → assume offline
  const room = io.sockets?.adapter?.rooms?.get(`user:${userId}`);
  return !room || room.size === 0;
}

function subjectFor(type, title) {
  const labels = {
    task_assigned:      "Task assigned",
    task_review_result: "Review result",
    deadline_24h:       "Deadline in 24 hours",
    extension_decision: "Extension decision",
  };
  return `[ACHIEVION] ${labels[type] ?? title}`;
}

// maybeEmailNotify — fire-and-forget wrapper (never throws; callers do not await it, tests may). A failure is one plain log line: no key, no address.
export function maybeEmailNotify({ userId, type, title, message }) {
  if (!OFFLINE_EMAIL_TYPES.has(type)) return Promise.resolve();
  return _send({ userId, type, title, message }).catch((e) => { console.warn(`[offlineEmail] send failed: ${e?.message ?? "error"}`); });
}

async function _send({ userId, type, title, message }) {
  if (!isMailConfigured()) return; // SMTP not configured → silent

  // Online check: socket connected
  if (!isOffline(userId)) return;

  // Fetch user (email, lastSeenAt, settings)
  const user = await User.findById(userId, "email lastSeenAt settings").lean().catch(() => null);
  if (!user?.email) return;

  // lastSeenAt > 5min check (null = never seen = offline)
  const lastSeen = user.lastSeenAt ? new Date(user.lastSeenAt) : null;
  if (lastSeen && Date.now() - lastSeen.getTime() < FIVE_MIN) return;

  // User setting (default on)
  if (user.settings?.emailNotificationsEnabled === false) return;

  // Max 5/day
  if (countToday(userId) >= 5) return;

  bumpToday(userId);
  const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); // task titles are user text
  await sendMail({
    to:      user.email,
    subject: subjectFor(type, title),
    text:    `${title}\n\n${message ?? ""}\n\nThis is an automated notification from ACHIEVION.`,
    html:    `<p><strong>${esc(title)}</strong></p><p>${esc(message)}</p><p><em>ACHIEVION automated notification</em></p>`,
  }); // a failure throws; maybeEmailNotify logs it plainly
}
