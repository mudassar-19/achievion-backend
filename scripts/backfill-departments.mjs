/**
 * One-off (item 7, D-541): put employees who have NO department into the department of their role category, where the organisation
 * already has that department active. It never creates a department and never moves someone who already has one. Idempotent.
 *
 *   node server/scripts/backfill-departments.mjs                    # dry run (default): counts per organisation, nothing written
 *   ALLOW_LIVE=1 node server/scripts/backfill-departments.mjs --apply
 *
 * Connection: server/.env (MONGO_URI). --apply needs ALLOW_LIVE=1 and first dumps the `users` collection into BACKUP_DIR
 * (default ~/Achievion-backups). The URI is never printed.
 */
import mongoose from "mongoose";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDepartmentFor } from "../services/departmentDefault.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const l of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !process.env[l.slice(0, i)]) process.env[l.slice(0, i)] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const apply = process.argv.includes("--apply");
if (apply && process.env.ALLOW_LIVE !== "1") { console.error("Refusing --apply without ALLOW_LIVE=1."); process.exit(1); }

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;
console.log(`Database: ${mongoose.connection.name}${apply ? " (APPLY)" : " (dry run)"}`);

const ops = [], perOrg = [];
for (const org of await db.collection("organizations").find({}, { projection: { name: 1, orgCode: 1, departments: 1 } }).toArray()) {
  const users = await db.collection("users").find({ orgId: String(org._id), status: { $ne: "deleted" }, $or: [{ department: null }, { department: "" }, { department: { $exists: false } }] }, { projection: { role: 1 } }).toArray();
  let n = 0;
  for (const u of users) {
    const d = defaultDepartmentFor(u.role, org);
    if (d) { ops.push({ updateOne: { filter: { _id: u._id, $or: [{ department: null }, { department: "" }, { department: { $exists: false } }] }, update: { $set: { department: d } } } }); n++; }
  }
  if (users.length) perOrg.push(`${org.orgCode}: ${users.length} without a department, ${n} can be placed${n < users.length ? ` (${users.length - n}: managers, directors, or the organisation has no matching active department)` : ""}`);
}
perOrg.forEach((l) => console.log("  " + l));
console.log(`Employees to place: ${ops.length}`);

if (!apply) console.log("Dry run: nothing written. Pass --apply (with ALLOW_LIVE=1) to write; a backup of `users` is taken first.");
else if (!ops.length) console.log("Nothing to change.");
else {
  const dir = path.join(process.env.BACKUP_DIR || path.join(os.homedir(), "Achievion-backups"), `users-${mongoose.connection.name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try { execFileSync("mongodump", [`--uri=${process.env.MONGO_URI}`, `--db=${mongoose.connection.name}`, "--collection=users", `--out=${dir}`, "--quiet"], { stdio: "pipe" }); }
  catch (e) { console.error(`Backup failed (exit ${e.status}); nothing was written.`); process.exit(1); }
  console.log(`Backup of users: ${dir}`);
  const r = await db.collection("users").bulkWrite(ops, { ordered: false });
  console.log(`Written: ${r.modifiedCount} employee(s) placed.`);
}
await mongoose.disconnect();
