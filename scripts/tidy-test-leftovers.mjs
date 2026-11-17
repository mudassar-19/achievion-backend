// QA2 runbook Step B item 7: tidy test leftovers in ONE organisation (TEST-7843 only, refuses any other code).
//   node scripts/tidy-test-leftovers.mjs            -> dry run: counts and samples, changes nothing
//   node scripts/tidy-test-leftovers.mjs --apply    -> writes a JSON backup of every matching row first, then deletes only those rows
// A row matches when its own title / name / text starts with a test prefix. Nothing else is touched. Needs server/.env (MONGO_URI).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ORG_CODE = process.env.TIDY_ORG_CODE ?? "TEST-7843";
if (ORG_CODE !== "TEST-7843") { console.error("Refused: this tidy only runs for TEST-7843."); process.exit(2); }
const APPLY = process.argv.includes("--apply");
const env = Object.fromEntries(fs.readFileSync(path.join(root, "server/.env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const uri = env.MONGO_URI.replace(/\/([^/?]*)(\?|$)/, "/test$2");
const PREFIX = /^(AUDIT-|AUDIT_|F057-|QA2-|THROWAWAY|FIX2-|FIX3-|SMOKE-|TEST-ANN|RT-)/i;
// collection -> fields that carry the human name; rows are matched on the first present field
const FIELDS = { projects: ["title"], tasks: ["title"], milestones: ["title"], sprints: ["name"], teams: ["name"], quests: ["title"], goals: ["title"], risks: ["title"], bugs: ["title"], testcases: ["title"],
  chatchannels: ["name"], chatcommunities: ["name"], chatmessages: ["text", "content"], announcements: ["title", "message"], recaps: ["title", "content"], assets: ["name"], lessons: ["text", "title"], operationalrequests: ["title"], approvals: ["title", "reason"] };
const first = (doc, keys) => keys.map((k) => doc[k]).find((v) => typeof v === "string") ?? "";

const conn = await mongoose.createConnection(uri).asPromise(), db = conn.db;
const org = await db.collection("organizations").findOne({ orgCode: ORG_CODE });
if (!org) { console.error("TEST-7843 not found"); process.exit(1); }
const ids = [String(org._id), ...(org.orgId ? [org.orgId] : [])], oids = [org._id];
const found = {};
for (const [coll, keys] of Object.entries(FIELDS)) {
  if (!(await db.listCollections({ name: coll }).hasNext())) continue;
  const docs = await db.collection(coll).find({ $or: [{ orgId: { $in: ids } }, { orgId: { $in: oids } }] }).limit(20000).toArray();
  const hit = docs.filter((d) => PREFIX.test(first(d, keys).trim()));
  if (hit.length) found[coll] = hit;
}
// Cascade: the groups of a test community and the messages of a test group go with them (they have no test name of their own).
const have = (c) => new Set((found[c] ?? []).map((d) => String(d._id)));
if (found.chatcommunities) {
  const more = await db.collection("chatchannels").find({ communityId: { $in: found.chatcommunities.map((d) => d._id) } }).toArray();
  const seen = have("chatchannels"); found.chatchannels = [...(found.chatchannels ?? []), ...more.filter((d) => !seen.has(String(d._id)))];
}
if (found.chatchannels) {
  const more = await db.collection("chatmessages").find({ channelId: { $in: found.chatchannels.map((d) => d._id) } }).toArray();
  const seen = have("chatmessages"); found.chatmessages = [...(found.chatmessages ?? []), ...more.filter((d) => !seen.has(String(d._id)))];
}
console.log(`Organisation TEST-7843 (${APPLY ? "APPLY" : "dry run"}):`);
for (const [c, rows] of Object.entries(found)) console.log(`  ${c}: ${rows.length}  e.g. ${rows.slice(0, 3).map((d) => JSON.stringify(first(d, FIELDS[c]).slice(0, 50))).join(", ")}`);
if (!Object.keys(found).length) console.log("  nothing matches");
if (APPLY && Object.keys(found).length) {
  const dir = path.join(os.homedir(), "Achievion-runbook", "backups"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `tidy-test7843-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(found, null, 1), { mode: 0o600 });
  console.log(`Backup written: ${file}`);
  for (const [c, rows] of Object.entries(found)) { const r = await db.collection(c).deleteMany({ _id: { $in: rows.map((d) => d._id) } }); console.log(`  deleted ${r.deletedCount} from ${c}`); }
}
await conn.close();
