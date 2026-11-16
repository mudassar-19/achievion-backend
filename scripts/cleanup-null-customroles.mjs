/**
 * Removes `null` entries from Organization.customRoles (legacy data: unguarded code threw on them).
 * Only `$pull: { customRoles: null }` is written; nothing else on the organization is touched. Idempotent.
 *
 * Usage (from the repo root):
 *   DB_NAME_OVERRIDE=achievion_dev node server/scripts/cleanup-null-customroles.mjs          # dry run (default)
 *   DB_NAME_OVERRIDE=achievion_dev node server/scripts/cleanup-null-customroles.mjs --apply  # write
 *   node server/scripts/cleanup-null-customroles.mjs                                          # dry run on the DB in server/.env
 *
 * Connection: server/.env (MONGO_URI). DB_NAME_OVERRIDE swaps the database name in that URI (same trick as
 * start-smoke.mjs). The URI is never printed. --apply on the DB named in server/.env needs ALLOW_LIVE=1 as well.
 *
 * Backup (automatic before --apply): mongodump of the `organizations` collection ONLY, into
 * db-backups/null-customroles-<db>-<timestamp>/ (db-backups/ is gitignored). Restore with mongorestore from there.
 */
import mongoose from "mongoose";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const l of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !process.env[l.slice(0, i)]) process.env[l.slice(0, i)] = l.slice(i + 1);
}

const apply = process.argv.includes("--apply");
const override = process.env.DB_NAME_OVERRIDE;
if (apply && !override && process.env.ALLOW_LIVE !== "1") {
  console.error("Refusing --apply on the database named in server/.env. Set DB_NAME_OVERRIDE, or ALLOW_LIVE=1 on purpose.");
  process.exit(1);
}
const uri = override ? process.env.MONGO_URI.replace(/\/([^/?]*)(\?|$)/, `/${override}$2`) : process.env.MONGO_URI;

await mongoose.connect(uri);
const db = mongoose.connection.db;
const orgs = db.collection("organizations");
console.log(`Database: ${mongoose.connection.name}${apply ? " (APPLY)" : " (dry run)"}`);

const report = async () => {
  const rows = await orgs.find({ customRoles: { $type: "array" } }, { projection: { name: 1, orgId: 1, customRoles: 1 } }).toArray();
  const hit = rows
    .map((o) => ({ id: String(o._id), name: o.name, nullAt: o.customRoles.map((r, i) => (r == null ? i : -1)).filter((i) => i >= 0), kept: o.customRoles.filter((r) => r != null).length }))
    .filter((o) => o.nullAt.length);
  return { orgsWithRoles: rows.length, hit, nulls: hit.reduce((s, o) => s + o.nullAt.length, 0) };
};

const before = await report();
console.log(`Organizations with customRoles: ${before.orgsWithRoles}`);
console.log(`Organizations with null entries: ${before.hit.length}; null entries in total: ${before.nulls}`);
for (const o of before.hit) console.log(`  ${o.id}  ${o.name}  null at index [${o.nullAt.join(", ")}]  (${o.kept} real roles kept)`);

if (!apply) {
  console.log("Dry run: nothing written. Pass --apply to remove the null entries (a backup is taken first).");
} else if (!before.hit.length) {
  console.log("Nothing to clean.");
} else {
  const dir = path.resolve(root, "..", "db-backups", `null-customroles-${mongoose.connection.name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("mongodump", [`--uri=${uri}`, "--collection=organizations", `--out=${dir}`, "--quiet"]);
  console.log(`Backup (organizations only): ${path.relative(path.resolve(root, ".."), dir)}`);

  const r = await orgs.updateMany({ _id: { $in: before.hit.map((o) => new mongoose.Types.ObjectId(o.id)) } }, { $pull: { customRoles: null } });
  console.log(`Updated organizations: ${r.modifiedCount}`);
  const after = await report();
  console.log(`After: organizations with null entries ${after.hit.length}, null entries ${after.nulls}`);
}

await mongoose.disconnect();
