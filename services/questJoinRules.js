// Employee quest board rules (Batch 3: E13; UC-17, FR07-03/05/06) — pure, no DB. Tests: server/tests/b3QuestBoard.test.mjs.
// Joining never pays anything: progress and rewards stay with questService.refreshQuest → gamificationService.applyQuestReward.
// A card is built field by field from the reader's own progress, so no other person's numbers (and no AI score, D-075) reach it.
import { progressPct } from "./questRules.js";

const LEADERS = ["Director", "Manager"]; // D-025 / D-081: no XP, so no quests
const DAY = 86_400_000;
const has = (list, id) => (list ?? []).some((x) => String(x?._id ?? x) === String(id));

// UC-17: step 3 "User joins a quest"; alternative flow "AI generates new quest … and assigns users automatically".
// A quest made for one person is theirs already, so it has no join step either.
export const entryFor = ({ scope, aiDraft = false } = {}) => (aiDraft || scope === "individual" ? "auto" : "join");

export const isOpen = (q, now = new Date()) => q?.status === "active" && !!q.deadline && new Date(q.deadline) > now;
const no = (status, error) => ({ ok: false, status, error });

// POST join. `eligible` = the person is in the quest's scope (questService.resolveParticipants).
export function joinVerdict({ quest, role, userId, eligible, now = new Date() }) {
  if (LEADERS.includes(role)) return no(403, "Directors and Managers do not earn XP, so they do not join quests.");
  if (!quest || quest.status === "draft") return no(404, "Quest not found.");
  if (!isOpen(quest, now)) return no(409, "This quest has ended, so it can no longer be joined.");
  if (has(quest.participants, userId)) return { ok: true, already: true };
  if (quest.entry !== "join") return no(409, "People are added to this quest automatically, so there is nothing to join.");
  if (!eligible) return no(403, "This quest is for another team, so you cannot join it.");
  return { ok: true, already: false };
}

// What the reader may see: quests they are in (also finished ones), and open join quests in their scope.
export function visibleTo({ quest, userId, eligible, now = new Date() }) {
  if (!quest || quest.status === "draft") return false;
  if (has(quest.participants, userId)) return true;
  return quest.entry === "join" && isOpen(quest, now) && !!eligible;
}

const mineOf = (q, userId) => (q.progress ?? []).find((p) => String(p.userId) === String(userId)) ?? null;
// done = reward given · joined = running and I am in · open = I may join · expired = ended before I finished.
export function stateOf(q, userId, now = new Date()) {
  if (mineOf(q, userId)?.completedAt) return "done";
  if (has(q.participants, userId)) return isOpen(q, now) ? "joined" : "expired";
  return isOpen(q, now) && q.entry === "join" ? "open" : "expired";
}

const n = (c, one, many) => `${c} ${c === 1 ? one : many}`;
const WORDS = { developer: ["Ship", "task", "tasks", ""], designer: ["Get", "design", "designs", " approved"], tester: ["Finish", "check", "checks", ""] };
const goals = ([verb, one, many, tail]) => ({
  tasks_completed: (t) => `${verb} ${n(t, one, many)}${tail}`,
  on_time_tasks: (t) => `${verb} ${n(t, one, many)}${tail} on time`,
  avg_quality: (t) => `Keep an average of ${t} stars on your reviews (at least 3 reviewed ${many})`,
  streak_days: (t) => `Reach a ${t}-day streak`,
});
export const GOAL = Object.fromEntries(Object.entries(WORDS).map(([k, w]) => [k, goals(w)]));
const UNIT = { tasks_completed: null, on_time_tasks: null, avg_quality: "stars", streak_days: "days" };
const SCOPE = { individual: "Just you", team: "Team", organisation: "Company" };
const TYPE = { daily: "Daily", weekly: "Weekly", sprint: "Sprint", custom: "Quest" };

// `badgeOf(id)` → the badge definition (or null). Only id, name and rarity are copied to the card.
export function questView(q, userId, kind = "developer", now = new Date(), badgeOf = null) {
  const b = q.rewardBadgeId && badgeOf ? badgeOf(q.rewardBadgeId) : null;
  const mine = mineOf(q, userId), state = stateOf(q, userId, now), w = WORDS[kind] ?? WORDS.developer;
  const value = mine?.value ?? 0;
  return {
    id: String(q._id), title: q.title, description: q.description ?? "", type: q.type, typeLabel: TYPE[q.type] ?? "Quest",
    scope: q.scope, scopeLabel: SCOPE[q.scope] ?? "Team", entry: q.entry === "join" ? "join" : "auto",
    goal: (GOAL[kind] ?? GOAL.developer)[q.metric]?.(q.target) ?? q.title, unit: UNIT[q.metric] ?? w[2],
    value, target: q.target, pct: state === "done" ? 100 : progressPct(value, q.target),
    deadline: q.deadline ?? null, daysLeft: q.deadline ? Math.max(0, Math.ceil((+new Date(q.deadline) - +now) / DAY)) : null,
    reward: { xp: q.rewardXp, gold: q.rewardGold ?? 0, badge: b ? { id: b.id, name: b.name, rarity: b.rarity ?? null } : null },
    state, canJoin: state === "open", people: (q.participants ?? []).length,
    finishedAt: mine?.completedAt ?? null, endedAt: q.closedAt ?? null,
  };
}

// The three lists of the board. `eligible(q)` → is the reader in that quest's scope.
export function boardOf(quests, { userId, kind, eligible, now = new Date(), badgeOf = null }) {
  const seen = (quests ?? []).filter((q) => visibleTo({ quest: q, userId, eligible: eligible(q), now })).map((q) => questView(q, userId, kind, now, badgeOf));
  const t = (d) => (d ? +new Date(d) : 0);
  return {
    open: seen.filter((q) => q.state === "open").sort((a, b) => t(a.deadline) - t(b.deadline)),
    mine: seen.filter((q) => q.state === "joined").sort((a, b) => t(a.deadline) - t(b.deadline)),
    finished: seen.filter((q) => q.state === "done" || q.state === "expired").sort((a, b) => t(b.finishedAt ?? b.endedAt ?? b.deadline) - t(a.finishedAt ?? a.endedAt ?? a.deadline)).slice(0, 20),
  };
}
