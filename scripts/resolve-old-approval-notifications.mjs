/**
 * Migration: resolve-old-approval-notifications.mjs
 * Renames Notification.type "approval_required" → "approval_pending" and sets tier="needs_action"
 * for unread Director notifications whose approval has already been APPROVED or REJECTED.
 * Marks them as read.
 *
 * Usage:
 *   node server/scripts/resolve-old-approval-notifications.mjs           # dry run
 *   node server/scripts/resolve-old-approval-notifications.mjs --apply   # write changes
 */
import mongoose from "mongoose";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const l of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !process.env[l.slice(0, i)]) process.env[l.slice(0, i)] = l.slice(i + 1);
}

const apply = process.argv.includes("--apply");

await mongoose.connect(process.env.MONGO_URI);
const Notification = mongoose.model("Notification", new mongoose.Schema({}, { strict: false }));
const Approval     = mongoose.model("Approval",     new mongoose.Schema({}, { strict: false }));

// 1. Rename all "approval_required" → "approval_pending" and set tier
const toRename = await Notification.find({ type: "approval_required" }).lean();
console.log(`Notifications to rename (type: approval_required → approval_pending): ${toRename.length}`);

// 2. Mark as read those whose approval is already resolved
const approvalIds = toRename.map((n) => n.meta?.approvalId).filter(Boolean);
const resolved    = new Set(
  (await Approval.find({ _id: { $in: approvalIds }, status: { $in: ["APPROVED", "REJECTED"] } }, "_id").lean())
    .map((a) => String(a._id))
);
const toMarkRead  = toRename.filter((n) => resolved.has(String(n.meta?.approvalId)));
console.log(`Of those, already-resolved approvals (will mark read): ${toMarkRead.length}`);

if (apply) {
  await Notification.updateMany(
    { type: "approval_required" },
    { $set: { type: "approval_pending", tier: "needs_action" } }
  );
  if (toMarkRead.length) {
    await Notification.updateMany(
      { _id: { $in: toMarkRead.map((n) => n._id) } },
      { $set: { read: true } }
    );
  }
  console.log("Done.");
} else {
  console.log("Dry run — pass --apply to write changes.");
}

await mongoose.disconnect();
