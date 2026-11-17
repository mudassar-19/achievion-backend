/**
 * One-off (item 78, D-547): give every organisation its Company community (Announcements, General, Random) and put every active
 * employee in it. Idempotent: it only adds what is missing.
 *
 *   node server/scripts/backfill-company-community.mjs                              # dry run for ALL organisations: counts, nothing written
 *   ALLOW_LIVE=1 node server/scripts/backfill-company-community.mjs --apply --org=TEST-7843   # write for ONE organisation (by org code)
 *
 * --apply needs ALLOW_LIVE=1 and --org=<code>: it never writes to all organisations at once. Before it writes it dumps the
 * `chatcommunities` and `chatchannels` collections into BACKUP_DIR (default ~/Achievion-backups). The URI is never printed.
 */
import mongoose from "mongoose";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Organization from "../models/Organization.js";
import { planCompany, ensureCompany } from "../services/companyCommunity.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const l of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !process.env[l.slice(0, i)]) process.env[l.slice(0, i)] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const apply = process.argv.includes("--apply");
const only = process.argv.find((a) => a.startsWith("--org="))?.slice(6).toUpperCase() ?? null;
if (apply && (process.env.ALLOW_LIVE !== "1" || !only)) { console.error("Refusing --apply: it needs ALLOW_LIVE=1 and --org=<org code> (one organisation at a time)."); process.exit(1); }

await mongoose.connect(process.env.MONGO_URI);
console.log(`Database: ${mongoose.connection.name}${apply ? ` (APPLY, ${only} only)` : " (dry run, all organisations)"}`);

const orgs = await Organization.find(only ? { orgCode: only } : {}, "orgCode name").lean();
if (only && !orgs.length) { console.error(`No organisation with code ${only}.`); process.exit(1); }

const rows = [];
for (const o of orgs) {
  const { employees, community, gaps } = await planCompany(o._id);
  const todo = gaps.createCommunity || gaps.createGroups.length || gaps.addToCommunity.length || Object.keys(gaps.addToGroups).length;
  const hasDirector = employees.some((e) => e.role === "Director");
  rows.push({ o, employees: employees.length, gaps, todo, hasDirector, community });
  console.log(`  ${o.orgCode}: ${employees.length} people, ${community ? "Company exists" : "no Company community"}; will ${gaps.createCommunity ? "create it, " : ""}${gaps.createGroups.length ? `create ${gaps.createGroups.join("/")}, ` : ""}add ${gaps.addToCommunity.length} to the community${hasDirector ? "" : "  [SKIPPED: no Director yet]"}`);
}
const doable = rows.filter((r) => r.todo && r.hasDirector);
console.log(`Organisations that would change: ${doable.length} of ${rows.length}; people to add in total: ${doable.reduce((s, r) => s + r.gaps.addToCommunity.length, 0)}`);

if (!apply) console.log("Dry run: nothing written.");
else if (!doable.length) console.log("Nothing to change.");
else {
  const dir = path.join(process.env.BACKUP_DIR || path.join(os.homedir(), "Achievion-backups"), `company-${mongoose.connection.name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try { for (const c of ["chatcommunities", "chatchannels"]) execFileSync("mongodump", [`--uri=${process.env.MONGO_URI}`, `--db=${mongoose.connection.name}`, `--collection=${c}`, `--out=${dir}`, "--quiet"], { stdio: "pipe" }); }
  catch (e) { console.error(`Backup failed (exit ${e.status}); nothing was written.`); process.exit(1); }
  console.log(`Backup: ${dir}`);
  for (const r of doable) { const out = await ensureCompany(r.o._id); console.log(`  ${r.o.orgCode}: ${out.changed ? "done" : "no change"}`); }
}
await mongoose.disconnect();
