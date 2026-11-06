// Communities / groups permission rules (V2 Phase 2, D-074) — pure, no DB.
// Source: ACHIEVION_BUILD_PLAN_V2.md "COMMUNITIES: RULES". Tests: server/tests/chatRules.test.mjs.
// `user` = { id, role }; ids may be strings or ObjectIds (compared as strings).

const LEADERS = ["Director", "Manager"];               // always members, community admins
const STAFF   = ["Director", "Manager", "Team Lead"];
const has = (list, id) => (list ?? []).some((x) => String(x?._id ?? x) === String(id));

export const ALLOWED_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "🙏"];

export const isAlwaysMember        = (role) => LEADERS.includes(role);
export const canCreateCommunity    = (role) => LEADERS.includes(role);
export const canCreateGroup        = (role) => STAFF.includes(role);
export const canRequestGroup       = (role) => !!role && !STAFF.includes(role) && role !== "org_admin";
export const canDecideGroupRequest = (role) => role === "Manager" || role === "Team Lead";
export const canArchiveCommunity   = (role) => role === "Director";
export const canNominateGroupAdmin = (role) => role === "Manager";

export const isCommunityAdmin  = (user) => isAlwaysMember(user.role);
export const isCommunityMember = (community, user) => isAlwaysMember(user.role) || has(community?.memberIds, user.id);

export const isGroupAdmin = (group, user) =>
  group?.type !== "dm" && (isAlwaysMember(user.role) || has(group?.adminIds, user.id));

// Pre-community org channels: open to the whole org when default or without a member list.
const legacyOpen = (ch) => !ch?.communityId && ch?.type !== "dm" && (ch?.isDefault || !ch?.memberIds?.length);

export function canView(channel, user) {
  if (channel?.type === "dm") return has(channel.memberIds, user.id);
  if (legacyOpen(channel)) return true;
  return isAlwaysMember(user.role) || has(channel?.memberIds, user.id) || has(channel?.adminIds, user.id);
}

export const effectiveSendMode = (group) =>
  group?.type === "announcement" ? "admins" : (group?.permissions?.sendMessages ?? "everyone");

export function canSend(group, user) {
  if (!canView(group, user)) return false;
  if (group.type === "dm" || effectiveSendMode(group) === "everyone") return true;
  return isGroupAdmin(group, user) || has(group.posterIds, user.id);
}

export const canManageGroup = (group, user) => isGroupAdmin(group, user); // settings, members, pins, posters

export const canEditGroupInfo = (group, user) =>
  isGroupAdmin(group, user) || (group?.permissions?.editInfo === "everyone" && canView(group, user));

export const canDeleteMessage = (group, msg, user) =>
  String(msg?.sender?._id ?? msg?.sender) === String(user.id) || isGroupAdmin(group, user);

export const removalBlocked = (targetRole) =>
  isAlwaysMember(targetRole) ? "Directors and Managers are always members and cannot be removed." : null;

export function leaveBlocked(group, user) {
  if (isAlwaysMember(user.role)) return "Directors and Managers are always members and cannot leave.";
  if (group?.type === "announcement") return "The Announcements group follows the community; ask an admin to remove you from the community.";
  return null;
}

// "already" | "join" | "request" | "not_in_community"
export function joinMode(group, community, user) {
  if (group?.type === "announcement" || has(group?.memberIds, user.id)) return "already";
  if (!isCommunityMember(community, user)) return "not_in_community";
  return group?.joinApproval ? "request" : "join";
}

export const withLeaders = (ids, leaderIds) => [...new Set([...ids, ...leaderIds].map(String))];

// One reaction per user per message (WhatsApp). Same emoji again removes it.
export const isAllowedReaction = (emoji) => ALLOWED_REACTIONS.includes(emoji);
export function toggleReaction(reactions, userId, emoji) {
  const uid = String(userId);
  const mine = (reactions ?? []).find((r) => String(r.userId) === uid);
  const rest = (reactions ?? []).filter((r) => String(r.userId) !== uid).map((r) => ({ emoji: r.emoji, userId: String(r.userId) }));
  return mine?.emoji === emoji ? rest : [...rest, { emoji, userId: uid }];
}
