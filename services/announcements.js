// Items 79, 80 (D-548): the Announcements feed. Pure. Tests: tests/announcementsFeed.test.mjs.
// An announcement is a message that a Director or Manager posted in an Announcements group; a Developer's message in that
// channel (it should not be possible, but old data exists) is chat, not an announcement.
const LEADERS = ["Director", "Manager"];
export const MAX_LEN = 2000;

export const canPostAnnouncement = (role, text) => LEADERS.includes(role) && (text === undefined || (!!String(text).trim() && String(text).length <= MAX_LEN));

// leader: Director/Manager also get the reach: audience (people in the group) and seen (how many opened it), E-13.
export function feedItems({ messages, channels, communities, meId, leader = false }) {
  const ch = new Map(channels.map((c) => [String(c._id), c]));
  const com = new Map(communities.map((c) => [String(c._id), c]));
  return messages
    .filter((m) => LEADERS.includes(m.sender?.role) && ch.has(String(m.channelId)))
    .map((m) => ({
      id: m._id, text: m.content ?? "", at: m.createdAt, from: m.sender?.name ?? "Someone", role: m.sender?.role ?? null,
      community: com.get(String(ch.get(String(m.channelId)).communityId))?.name ?? "", channel: ch.get(String(m.channelId)).name,
      unread: !(m.readBy ?? []).map(String).includes(String(meId)),
      ...(leader ? (() => { const c = ch.get(String(m.channelId)), n = c.memberIds?.length || com.get(String(c.communityId))?.memberIds?.length || 0; return { audience: n, seen: Math.min((m.readBy ?? []).length, n || Infinity) }; })() : {}),
    }))
    .sort((a, b) => +new Date(b.at) - +new Date(a.at));
}

// Where a Director or Manager may post: the Company announcements first, then each community's.
export function postTargets({ channels, communities }) {
  const com = new Map(communities.map((c) => [String(c._id), c]));
  return channels.map((c) => ({ channelId: String(c._id), label: com.get(String(c.communityId))?.name ?? c.name, company: com.get(String(c.communityId))?.type === "organization" }))
    .sort((a, b) => (b.company - a.company) || a.label.localeCompare(b.label));
}
