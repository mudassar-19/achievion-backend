/**
 * Backfills missing `key` and `category` fields on Organization.customRoles items.
 * key   = label.toLowerCase().replace(/\s+/g, "_")
 * category = inferred from label (designer/tester) else "developer"
 *
 * Usage:
 *   node server/scripts/backfill-customroles.mjs         # dry run
 *   node server/scripts/backfill-customroles.mjs --apply  # write (backup first)
 */
import mongoose from "mongoose";
import { execSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const l of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !process.env[l.slice(0, i)]) process.env[l.slice(0, i)] = l.slice(i + 1);
}

const apply = process.argv.includes("--apply");
const VALID_CATS = ["developer", "designer", "tester"];

function inferCategory(label = "") {
  const l = label.toLowerCase();
  if (l.includes("design")) return "designer";
  if (l.includes("test") || l.includes("qa")) return "tester";
  return "developer";
}

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;

if (apply) {
  const backupDir = path.resolve(root, "..", "db-backups", `backfill-customroles-${Date.now()}`);
  mkdirSync(backupDir, { recursive: true });
  execSync(`mongodump --uri="${process.env.MONGO_URI}" --collection=organizations --out="${backupDir}" --quiet`);
  console.log(`Backup: ${backupDir}`);
}

const orgs = await db.collection("organizations")
  .find({ "customRoles.0": { $exists: true } })
  .toArray();

let totalOrgs = 0, totalRoles = 0;
const updates = [];

for (const org of orgs) {
  let changed = false;
  const fixed = org.customRoles.map(role => {
    const needsKey = !role.key;
    const needsCategory = !role.category || !VALID_CATS.includes(role.category);
    if (!needsKey && !needsCategory) return role;
    totalRoles++;
    changed = true;
    return {
      ...role,
      key:      needsKey      ? (role.label?.toLowerCase().replace(/\s+/g, "_") ?? String(role._id)) : role.key,
      category: needsCategory ? inferCategory(role.label) : role.category,
    };
  });
  if (changed) {
    totalOrgs++;
    updates.push({ orgId: org._id, fixed });
  }
}

console.log(`Orgs needing backfill: ${totalOrgs}`);
console.log(`Role items to fix: ${totalRoles}`);

if (apply) {
  for (const { orgId, fixed } of updates) {
    await db.collection("organizations").updateOne({ _id: orgId }, { $set: { customRoles: fixed } });
  }
  console.log("Done.");
} else {
  console.log("Dry run — pass --apply to write changes.");
}

await mongoose.disconnect();
