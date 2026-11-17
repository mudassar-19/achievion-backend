// Item 78 (D-547): the Company community every organisation has. All active employees are in it; General and Random are open chats,
// Announcements is read by everyone and posted by Director and Manager only (the existing chatRules: an announcement group is
// admins-only, Director and Manager are always admins). Pure planner + the idempotent DB writers. Tests: tests/companyCommunity.test.mjs.
import ChatCommunity from "../models/ChatCommunity.js";
import ChatChannel from "../models/ChatChannel.js";
import AuditLog from "../models/AuditLog.js";
import User from "../models/User.js";

export const COMPANY = {
  name: "Company", icon: "🏢", type: "organization", description: "Everyone in the organisation.",
  groups: [
    { name: "announcements", icon: "📢", type: "announcement", description: "Official announcements. Everyone reads; Director and Manager post.", send: "admins" },
    { name: "general", icon: "💬", type: "general", description: "Open chat for everyone.", send: "everyone" },
    { name: "random", icon: "🎲", type: "general", description: "Anything else, open to everyone.", send: "everyone" },
  ],
};
const ids = (list) => (list ?? []).map((x) => String(x?._id ?? x));
const eligible = (e) => !e.status || e.status === "active";

// employees: [{ _id, role, status? }] → what is missing. community / channels are null / [] when nothing exists yet.
export function companyGaps({ community, channels, employees }) {
  const everyone = employees.filter(eligible).map((e) => String(e._id));
  const inCom = new Set(ids(community?.memberIds));
  const byName = new Map((channels ?? []).map((c) => [c.name, c]));
  const createGroups = COMPANY.groups.map((g) => g.name).filter((n) => !byName.has(n));
  const addToGroups = {};
  for (const [name, ch] of byName) {
    const have = new Set(ids(ch.memberIds));
    const missing = everyone.filter((id) => !have.has(id));
    if (missing.length) addToGroups[name] = missing;
  }
  return { createCommunity: !community, createGroups, addToCommunity: everyone.filter((id) => !inCom.has(id)), addToGroups };
}

export const isCompanyGroup = (channel, community) => community?.type === "organization" && community?.name === COMPANY.name && COMPANY.groups.some((g) => g.name === channel?.name);

// ── DB ───────────────────────────────────────────────────────────────────────
export async function loadCompany(orgOid) {
  const community = await ChatCommunity.findOne({ orgId: orgOid, type: "organization", name: COMPANY.name }).lean();
  const channels = community ? await ChatChannel.find({ communityId: community._id }).lean() : [];
  return { community, channels };
}

// The plan for one organisation without writing anything (used by the dry run).
export async function planCompany(orgOid) {
  const employees = await User.find({ orgId: String(orgOid), role: { $ne: "org_admin" }, status: { $ne: "deleted" } }, "role status").lean();
  const { community, channels } = await loadCompany(orgOid);
  return { employees, community, channels, gaps: companyGaps({ community, channels, employees }) };
}

// Creates what is missing and adds everyone. Idempotent. Needs a Director (the owner); without one nothing is done.
export async function ensureCompany(orgOid, { actorId = null } = {}) {
  const plan = await planCompany(orgOid);
  const g = plan.gaps;
  if (!g.createCommunity && !g.createGroups.length && !g.addToCommunity.length && !Object.keys(g.addToGroups).length) return { changed: false, plan };
  const leaders = await User.find({ orgId: String(orgOid), role: { $in: ["Director", "Manager"] }, status: { $ne: "deleted" } }, "role").lean();
  const director = leaders.find((u) => u.role === "Director");
  if (!director) return { changed: false, plan, skipped: "no Director yet" };
  const leaderIds = leaders.map((u) => u._id);
  const everyone = plan.employees.filter(eligible).map((e) => e._id);

  let community = plan.community;
  if (g.createCommunity) {
    community = (await ChatCommunity.create({ orgId: orgOid, name: COMPANY.name, description: COMPANY.description, icon: COMPANY.icon, type: COMPANY.type,
      createdBy: director._id, adminIds: leaderIds, memberIds: everyone, settings: { addMembers: "admins", editInfo: "admins" } })).toObject();
  } else if (g.addToCommunity.length) {
    await ChatCommunity.updateOne({ _id: community._id }, { $addToSet: { memberIds: { $each: g.addToCommunity } } });
  }
  for (const def of COMPANY.groups.filter((d) => g.createGroups.includes(d.name))) {
    await ChatChannel.create({ orgId: orgOid, communityId: community._id, name: def.name, description: def.description, icon: def.icon, type: def.type, memberIds: everyone,
      adminIds: leaderIds, createdBy: director._id, isDefault: true, permissions: { sendMessages: def.send, editInfo: "admins", addMembers: "admins" } });
  }
  for (const [name, missing] of Object.entries(g.addToGroups)) await ChatChannel.updateOne({ communityId: community._id, name }, { $addToSet: { memberIds: { $each: missing } } });

  await AuditLog.create({ action: g.createCommunity ? "company_community_created" : "company_members_added", orgId: orgOid, performedBy: actorId ?? director._id, scope: "chat",
    detail: g.createCommunity ? `Company community created with ${everyone.length} member(s).` : `${g.addToCommunity.length} member(s) added to the Company community.`,
    after: { added: g.addToCommunity.length, groupsCreated: g.createGroups } }).catch(() => {});
  return { changed: true, plan };
}
