// QA4 Y-2: names are read from ids wherever the app can (chat senders, assignees, leaderboard, ...). A few old rows keep a person's name
// inside text (bell items, audit sentences). When a name changes, that text is updated too, so the old name does not survive. Pure part tested.
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import mongoose from "mongoose";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function replaceName(text, oldName, newName) {
  if (!oldName || !text || oldName === newName) return text;
  return String(text).replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc(oldName)}(?![\\p{L}\\p{N}])`, "gu"), newName);
}

// Rewrites the person's old name inside this organization's bell text. The audit log is append-only (tamper-evident), so it is NOT rewritten:
// it is corrected when it is READ (applyRenames below), from User.previousNames.
export async function propagateRename({ orgId, oldName, newName }) {
  if (!oldName || !newName || oldName === newName) return { notifications: 0, audit: 0 };
  const rx = new RegExp(`(?<![\\p{L}\\p{N}])${esc(oldName)}(?![\\p{L}\\p{N}])`, "u");
  const orgHex = String(orgId), orgOid = /^[0-9a-f]{24}$/i.test(orgHex) ? new mongoose.Types.ObjectId(orgHex) : null;
  let n = 0, a = 0; // a stays 0: audit rows are never changed
  for (const doc of await Notification.find({ orgId: orgHex, $or: [{ message: rx }, { title: rx }] }, "message title").lean()) {
    await Notification.updateOne({ _id: doc._id }, { $set: { message: replaceName(doc.message, oldName, newName), title: replaceName(doc.title, oldName, newName) } }); n++;
  }
  return { notifications: n, audit: a };
}

// Read-time correction for append-only text (audit sentences, activity): every OLD name of a renamed person becomes the current name.
export async function loadRenames(orgId) {
  const rows = await User.find({ orgId: String(orgId), "previousNames.0": { $exists: true } }, "name previousNames").lean();
  return rows.flatMap((u) => u.previousNames.map((old) => ({ old, now: u.name })));
}
export const applyRenames = (text, renames) => (text == null ? text : renames.reduce((t, r) => replaceName(t, r.old, r.now), text));
