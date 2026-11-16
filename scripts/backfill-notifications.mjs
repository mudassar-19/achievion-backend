/**
 * One-off repair of old approval notifications (items 32, 34): Needs action tier, a plain title and sentence, a link to the
 * request, and "read" for requests that were already decided. Only the fields in services/notifBackfill.js are $set, on
 * notifications of the types approval_pending, approval_required and approval_result. Idempotent. Nothing is deleted.
 *
 *   node server/scripts/backfill-notifications.mjs            # dry run (default): counts only, nothing written
 *   ALLOW_LIVE=1 node server/scripts/backfill-notifications.mjs --apply
 *
 * Connection: server/.env (MONGO_URI), the database named there. --apply needs ALLOW_LIVE=1. The URI is never printed.
 * Before --apply: mongodump of the `notifications` collection only, into BACKUP_DIR (default ~/Achievion-backups).
 */
import mongoose from "mongoose";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planFix } from "../services/notifBackfill.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const l of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !process.env[l.slice(0, i)]) process.env[l.slice(0, i)] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const apply = process.argv.includes("--apply");
if (apply && process.env.ALLOW_LIVE !== "1") { console.error("Refusing --apply without ALLOW_LIVE=1."); process.exit(1); }

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;
console.log(`Database: ${mongoose.connection.name}${apply ? " (APPLY)" : " (dry run)"}`);

const notifs = await db.collection("notifications").find({ type: { $in: ["approval_pending", "approval_required", "approval_result"] } }).toArray();
const ids = [...new Set(notifs.map((n) => n.meta?.approvalId).filter(Boolean).map(String))].map((x) => new mongoose.Types.ObjectId(x));
const status = Object.fromEntries((await db.collection("approvals").find({ _id: { $in: ids } }, { projection: { status: 1 } }).toArray()).map((a) => [String(a._id), a.status]));

const ops = [], count = { tier: 0, title: 0, message: 0, deepLink: 0, read: 0 };
for (const n of notifs) {
  const set = planFix(n, status[String(n.meta?.approvalId)] ?? null);
  if (!set) continue;
  for (const k of Object.keys(set)) count[k]++;
  ops.push({ updateOne: { filter: { _id: n._id }, update: { $set: set } } });
}
console.log(`Approval notifications looked at: ${notifs.length}`);
console.log(`Records to change: ${ops.length}  (tier ${count.tier}, title ${count.title}, message ${count.message}, link ${count.deepLink}, marked read ${count.read})`);

if (!apply) console.log("Dry run: nothing written. Pass --apply (with ALLOW_LIVE=1) to write; a backup of `notifications` is taken first.");
else if (!ops.length) console.log("Nothing to change.");
else {
  const dir = path.join(process.env.BACKUP_DIR || path.join(os.homedir(), "Achievion-backups"), `notifications-${mongoose.connection.name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try { execFileSync("mongodump", [`--uri=${process.env.MONGO_URI}`, `--db=${mongoose.connection.name}`, "--collection=notifications", `--out=${dir}`, "--quiet"], { stdio: "pipe" }); }
  catch (e) { console.error(`Backup failed (exit ${e.status}); nothing was written.`); process.exit(1); } // the error text would carry the URI
  console.log(`Backup of notifications: ${dir}`);
  const r = await db.collection("notifications").bulkWrite(ops, { ordered: false });
  console.log(`Written: ${r.modifiedCount} record(s) changed.`);
}
await mongoose.disconnect();
