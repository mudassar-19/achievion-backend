// Item 76 (D-544): who the OTHER person in a DM is. A DM is stored as "dm-<id>-<id>"; screens must never show that.
// Pure. users: Map(id string → { _id, name, role, avatarStyle, avatarSeed, ... }). Only public fields are copied.
export function dmPeer(channel, meId, users) {
  const other = (channel?.memberIds ?? []).map(String).find((id) => id !== String(meId));
  const u = other && users.get(other);
  return u ? { _id: String(u._id), name: u.name, role: u.role, avatarStyle: u.avatarStyle, avatarSeed: u.avatarSeed } : null;
}

// Adds `dm` (the other person, or null when that account is gone) to every DM of a channel list.
export const withDmPeers = (channels, meId, users) => channels.map((c) => (c.type === "dm" ? { ...c, dm: dmPeer(c, meId, users) } : c));

// The name to use in a notification or a title.
export const dmLabel = (channel, meId, users) => (channel?.type === "dm" ? dmPeer(channel, meId, users)?.name ?? "a deactivated user" : `#${channel?.name ?? ""}`);
