/**
 * QA3 chat v2 migration (D-QA3B-6). Idempotent. Nothing is deleted: old groups and the old community are archived, messages are MOVED.
 *
 *   node server/scripts/sim/qa3-chat-v2.mjs --dry-run                       # default: plan for ALL organisations, nothing written
 *   ALLOW_LIVE=1 node server/scripts/sim/qa3-chat-v2.mjs --apply --org=SIM-4663   # ONE organisation at a time
 *
 * What it does per organisation (see services/chatMigrationV2.js): makes sure Company + its Leadership group exist, merges the old
 * "<Org> - General" community into Company, puts the Director and every Manager into EVERY group and community as admins.
 * --apply needs ALLOW_LIVE=1 and --org=<code>. Before writing it dumps chatcommunities, chatchannels and chatmessages into BACKUP_DIR
 * (default ~/Achievion-backups). The database address is never printed. Window 1 runs this after deploy; it was tested on TEST-7843.
 */
import mongoose from "mongoose";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Organization from "../../models/Organization.js";
import ChatCommunity from "../../models/ChatCommunity.js";
import ChatChannel from "../../models/ChatChannel.js";
import ChatMessage from "../../models/ChatMessage.js";
import AuditLog from "../../models/AuditLog.js";
import User from "../../models/User.js";
import { ensureCompany } from "../../services/companyCommunity.js";
import { isLegacyOrgCommunity, planChatV2, summarize } from "../../services/chatMigrationV2.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
for (const l of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !process.env[l.slice(0, i)]) process.env[l.slice(0, i)] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const apply = process.argv.includes("--apply");
const only = process.argv.find((a) => a.startsWith("--org="))?.slice(6).toUpperCase() ?? null;
if (apply && (process.env.ALLOW_LIVE !== "1" || !only)) { console.error("Refusing --apply: it needs ALLOW_LIVE=1 and --org=<org code> (one organisation at a time)."); process.exit(1); }

await mongoose.connect(process.env.MONGO_URI);
console.log(`Database: ${mongoose.connection.name}${apply ? ` (APPLY, ${only} only)` : " (dry run)"}`);
const orgs = await Organization.find(only ? { orgCode: only } : {}, "orgCode name").lean();
if (only && !orgs.length) { console.error(`No organisation with code ${only}.`); process.exit(1); }

// Everything the plan needs for one organisation (reads only).
async function load(o) {
  const people = await User.find({ orgId: String(o._id), status: { $nin: ["deleted"] } }, "role department status").lean();
  const leaders = people.filter((p) => ["Director", "Manager"].includes(p.role) && (!p.status || p.status === "active")).map((p) => String(p._id));
  const communities = await ChatCommunity.find({ orgId: o._id }).lean();
  const channels = await ChatChannel.find({ orgId: o._id, type: { $ne: "dm" } }).lean();
  const company = communities.find((c) => c.type === "organization" && c.name === "Company") ?? null;
  const legacy = communities.find((c) => isLegacyOrgCommunity(c, o.name) && !c.isArchived) ?? null;
  const within = (c) => (c ? { ...c, channels: channels.filter((ch) => String(ch.communityId) === String(c._id) && !ch.isArchived) } : null);
  return { people, leaders, communities, channels, company: within(company), legacy: within(legacy) };
}
const plan = (o, s) => planChatV2({ company: s.company, legacy: s.legacy, leaders: s.leaders, users: s.people, allGroups: s.channels.filter((c) => !c.isArchived) });

const rows = [];
for (const o of orgs) {
  const s = await load(o);
  const hasDirector = s.people.some((p) => p.role === "Director");
  const ops = s.company ? plan(o, s) : [];
  const sum = summarize(ops);
  rows.push({ o, s, ops, hasDirector });
  console.log(`  ${o.orgCode}: ${s.company ? "Company exists" : "no Company yet (will be created)"}; ${s.legacy ? `old community "${s.legacy.name}" will be merged` : "no old community"}; plan: ${Object.keys(sum).length ? JSON.stringify(sum) : "nothing"}`);
}
if (!apply) { console.log("Dry run: nothing written."); await mongoose.disconnect(); process.exit(0); }

const r = rows[0];
if (!r.hasDirector) { console.error("This organisation has no Director; nothing to do."); process.exit(1); }
const dir = path.join(process.env.BACKUP_DIR || path.join(os.homedir(), "Achievion-backups"), `chat-v2-${mongoose.connection.name}-${only}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
try { for (const c of ["chatcommunities", "chatchannels", "chatmessages"]) execFileSync("mongodump", [`--uri=${process.env.MONGO_URI}`, `--db=${mongoose.connection.name}`, `--collection=${c}`, `--out=${dir}`, "--quiet"], { stdio: "ignore" }); }
catch (e) { console.error(`Backup failed (exit ${e.status}); nothing was written.`); process.exit(1); }
console.log(`Backup: ${dir}`);

await ensureCompany(r.o._id); // Company + Announcements/General/Leadership, everyone in
const s = await load(r.o);
const ops = plan(r.o, s);
const oid = (x) => new mongoose.Types.ObjectId(x);
let moved = 0;
for (const op of ops) {
  if (op.op === "moveMessages") moved += (await ChatMessage.updateMany({ channelId: oid(op.from) }, { $set: { channelId: oid(op.to) } })).modifiedCount;
  else if (op.op === "archiveChannel") await ChatChannel.updateOne({ _id: oid(op.id) }, { $set: { isArchived: true } });
  else if (op.op === "moveChannel") await ChatChannel.updateOne({ _id: oid(op.id) }, { $set: { communityId: oid(op.toCommunity) }, $addToSet: { memberIds: { $each: op.memberIds.map(oid) } } });
  else if (op.op === "archiveCommunity") await ChatCommunity.updateOne({ _id: oid(op.id) }, { $set: { isArchived: true } });
  else if (op.op === "addLeaders") await ChatChannel.updateOne({ _id: oid(op.id) }, { $addToSet: { memberIds: { $each: op.addMembers.map(oid) }, adminIds: { $each: op.addAdmins.map(oid) } } });
}
// Department groups that moved: their members belong to Company too.
const companyDoc = s.company ?? (await load(r.o)).company;
if (companyDoc) {
  const everyone = (await ChatChannel.find({ communityId: companyDoc._id }, "memberIds").lean()).flatMap((c) => c.memberIds ?? []);
  await ChatCommunity.updateOne({ _id: companyDoc._id }, { $addToSet: { memberIds: { $each: everyone }, adminIds: { $each: s.leaders.map(oid) } } });
}
await ChatCommunity.updateMany({ orgId: r.o._id }, { $addToSet: { memberIds: { $each: s.leaders.map(oid) }, adminIds: { $each: s.leaders.map(oid) } } });
const director = s.people.find((p) => p.role === "Director");
await AuditLog.create({ action: "chat_v2_migration", orgId: r.o._id, performedBy: director._id, scope: "chat",
  detail: `Chat tidy: old community merged into Company, Leadership group, Director and Managers in every group (${ops.length} step(s), ${moved} message(s) moved).`, after: summarize(ops) }).catch(() => {});
console.log(`Done: ${ops.length} step(s), ${moved} message(s) moved. Backup: ${dir}`);
await mongoose.disconnect();
