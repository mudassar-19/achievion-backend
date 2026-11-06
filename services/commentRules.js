// Task comments (T-4, D-139; FR03-12, FR09-05/06). Pure. Tests: tests/reviewRules.test.mjs.
export const REACTIONS = ["👍", "🎉", "❤️", "👀", "✅"];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Project members named as @Name in the text, without the author. "ali@x.com" is not a mention (letter before the @).
export function mentionedIds(text, members, authorId) {
  const out = [];
  for (const m of members) {
    if (!m.name || String(m.id) === String(authorId)) continue;
    if (new RegExp(`(^|[^\\p{L}\\p{N}])@${esc(m.name)}(?![\\p{L}\\p{N}])`, "iu").test(text)) out.push(String(m.id));
  }
  return out;
}
// Next reaction list; null when the emoji is not in the set.
export function toggleReaction(list, emoji, userId) {
  if (!REACTIONS.includes(emoji)) return null;
  const mine = (r) => r.emoji === emoji && String(r.user) === String(userId);
  return list.some(mine) ? list.filter((r) => !mine(r)) : [...list, { emoji, user: userId }];
}
export const canChangeComment = (c, userId) => String(c.author?._id ?? c.author) === String(userId);
