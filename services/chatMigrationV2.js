// QA3 chat v2 migration (D-QA3B-6): the PLAN only, no database. scripts/sim/qa3-chat-v2.mjs runs it.
//  1. the old org-wide community ("<Org name> - General": #announcements #general #random #design #engineering #quality-assurance) is merged
//     into Company: its announcements/general/random messages move into Company's groups, its department groups move under Company
//     (history stays), the emptied old groups and the old community are archived (nothing is deleted);
//  2. Company gets a Leadership group (Director + Managers);
//  3. the Director and every Manager become members and admins of EVERY group and community in the organisation (Leadership: only them).
// Pure: tests/chatMigrationV2.test.mjs.
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
const sid = (x) => String(x?._id ?? x);

export const isLegacyOrgCommunity = (c, orgName) => {
  if (!c || c.type === "project" || norm(c.name) === "company") return false;
  const n = norm(c.name), o = norm(orgName);
  return n.endsWith("general") && (!o || n.startsWith(o));
};

// A department group (design, engineering, quality-assurance) is filled with the people of that department.
export const deptMatches = (groupName, dept) => {
  const g = norm(groupName), d = norm(dept);
  if (!g || !d) return false;
  if (g.includes("design")) return d.includes("design");
  if (g.includes("engineer") || g.includes("develop")) return d.includes("develop") || d.includes("engineer");
  if (g.includes("quality") || g === "qa") return d.includes("quality") || d === "qa";
  return false;
};

const MERGE = ["announcements", "general", "random"];

// company: { _id, channels: [{ _id, name, memberIds }] }   legacy: same shape or null
// leaders: [id]   users: [{ _id, department }]   all: [{ communityId, channels: [...] }] for the leader sweep
export function planChatV2({ company, legacy, leaders = [], users = [], allGroups = [] }) {
  const ops = [];
  const byName = new Map((company?.channels ?? []).map((c) => [c.name, c]));
  if (legacy) {
    for (const ch of legacy.channels ?? []) {
      const target = byName.get(ch.name);
      if (MERGE.includes(ch.name) && target) { ops.push({ op: "moveMessages", from: sid(ch), to: sid(target), name: ch.name }); ops.push({ op: "archiveChannel", id: sid(ch), name: ch.name }); }
      else if (!target) {
        const dept = users.filter((u) => deptMatches(ch.name, u.department)).map(sid);
        ops.push({ op: "moveChannel", id: sid(ch), toCommunity: sid(company), name: ch.name, memberIds: [...new Set([...(ch.memberIds ?? []).map(sid), ...dept])] });
      } else ops.push({ op: "skip", id: sid(ch), name: ch.name, why: "Company already has a group with this name" });
    }
    ops.push({ op: "archiveCommunity", id: sid(legacy), name: legacy.name });
  }
  for (const g of allGroups) {
    if (g.type === "dm") continue;
    const have = new Set((g.memberIds ?? []).map(sid)), admins = new Set((g.adminIds ?? []).map(sid));
    const addMembers = leaders.filter((l) => !have.has(sid(l))), addAdmins = leaders.filter((l) => !admins.has(sid(l)));
    if (addMembers.length || addAdmins.length) ops.push({ op: "addLeaders", id: sid(g), name: g.name, addMembers: addMembers.map(sid), addAdmins: addAdmins.map(sid) });
  }
  return ops;
}

export const summarize = (ops) => ops.reduce((m, o) => ({ ...m, [o.op]: (m[o.op] ?? 0) + 1 }), {});
