// Challenges engine glue (M-5). Pure rules: questRules.js. Progress comes from the XP ledger, rewards go
// through gamificationService.applyQuestReward (one ledger row per user per quest), expiry never takes XP away.
import Quest   from "../models/Quest.js";
import XpLog   from "../models/XpLog.js";
import User    from "../models/User.js";
import Project from "../models/Project.js";
import Team    from "../models/Team.js";
import Sprint  from "../models/Sprint.js";
import GamificationProfile from "../models/GamificationProfile.js";
import { applyQuestReward } from "./gamificationService.js";
import { progressValue, reached, nextStatus, dueRewards, nextPeriod, countFrom } from "./questRules.js";

const LEADERS = ["Director", "Manager"];

// People in scope: active, in the org, not Director/Manager (D-081). `orgIds` = both org id forms.
export async function resolveParticipants(q, orgIds) {
  const base = { orgId: { $in: orgIds }, status: "active", role: { $nin: LEADERS } };
  let ids = null;
  if (q.scope === "individual") ids = [q.scopeRef?.id];
  else if (q.scope === "team" && q.scopeRef?.kind === "project") ids = (await Project.findOne({ _id: q.scopeRef.id, orgId: { $in: orgIds } }, "members").lean())?.members ?? [];
  else if (q.scope === "team" && q.scopeRef?.kind === "team") ids = ((await Team.findOne({ _id: q.scopeRef.id, orgId: { $in: orgIds } }, "members").lean())?.members ?? []).filter((m) => m.isActive !== false).map((m) => m.userId);
  const users = await User.find(ids ? { ...base, _id: { $in: ids.filter(Boolean) } } : base, "_id").lean();
  return users.map((u) => u._id);
}

// Recompute progress, pay due rewards, move status, issue the next repeat. Safe to call any time.
export async function refreshQuest(quest, { by = "system", orgIds = null } = {}) {
  if (quest.status !== "active") return quest;
  const now = new Date();
  let closesNow = false;
  if (quest.type === "sprint" && quest.sprintId) closesNow = (await Sprint.findById(quest.sprintId, "status").lean())?.status === "Completed";
  const ids = quest.participants ?? [];
  const [logs, profiles, rewardedRows] = await Promise.all([
    XpLog.find({ userId: { $in: ids }, source: "task_approved", createdAt: { $gte: countFrom(quest), $lte: quest.deadline } }, "userId isLate qualityScore createdAt").lean(),
    quest.metric === "streak_days" ? GamificationProfile.find({ userId: { $in: ids } }, "userId streaks").lean() : [],
    XpLog.find({ source: "quest", questId: quest._id }, "userId createdAt").lean(),
  ]);
  const open = now <= quest.deadline && !closesNow;
  const rewarded = new Map(rewardedRows.map((r) => [String(r.userId), r.createdAt]));
  const rows = ids.map((uid) => {
    const mine = logs.filter((l) => String(l.userId) === String(uid));
    const streak = open ? (profiles.find((p) => String(p.userId) === String(uid))?.streaks?.daily ?? 0) : 0;
    const value = progressValue(quest.metric, mine, { start: countFrom(quest), end: quest.deadline, streakDays: streak });
    return { userId: uid, value, tasks: mine.length, reached: reached(quest.metric, value, quest.target, mine.length) };
  });
  for (const uid of dueRewards(rows, rewarded)) {
    if (quest.metric === "streak_days" && !open) continue;
    if (await applyQuestReward({ questId: quest._id, userId: uid, orgId: quest.orgId, xp: quest.rewardXp, gold: quest.rewardGold, title: quest.title, rewardBadgeId: quest.rewardBadgeId ?? null, by })) rewarded.set(uid, now);
  }
  quest.progress = rows.map((r) => ({ userId: r.userId, value: r.value, tasks: r.tasks, completedAt: rewarded.get(String(r.userId)) ?? null }));
  const status = nextStatus(quest, { now: closesNow ? new Date(8.64e15) : now, everyoneDone: ids.length > 0 && ids.every((u) => rewarded.has(String(u))) });
  const update = { progress: quest.progress };
  if (status !== "active") Object.assign(update, { status, closedAt: now });
  const saved = await Quest.findOneAndUpdate({ _id: quest._id, status: "active" }, { $set: update }, { returnDocument: "after" });
  if (saved && status !== "active" && saved.repeat) await issueNext(saved, orgIds);
  return saved ?? quest;
}

// Repeat (daily/weekly): a fresh quest for the next period, progress from zero; the old one stays in history.
export async function issueNext(prev, orgIds = null) {
  const period = nextPeriod(prev);
  if (!period) return null;
  const ids = orgIds ?? [prev.orgId];
  // Batch 3 (E13): a quest people joined keeps its joiners in the next period; an automatic one re-reads its scope.
  const participants = prev.entry === "join" ? (prev.participants ?? []) : await resolveParticipants(prev, ids);
  try {
    const next = await Quest.create({
      orgId: prev.orgId, title: prev.title, description: prev.description, type: prev.type, repeat: true, metric: prev.metric, target: prev.target,
      scope: prev.scope, scopeRef: prev.scopeRef, rewardXp: prev.rewardXp, rewardGold: prev.rewardGold,
      startDate: period.start, deadline: period.end, status: "active", participants, progress: [],
      seriesId: prev.seriesId ?? prev._id, previousId: prev._id, createdBy: prev.createdBy, publishedAt: new Date(),
      entry: prev.entry ?? "auto", aiDraft: !!prev.aiDraft, rewardBadgeId: prev.rewardBadgeId ?? null, // the next period keeps the badge reward
    });
    return next;
  } catch (err) {
    if (err?.code === 11000) return null; // this period was already issued
    throw err;
  }
}

export async function evaluateQuestsForUser(userId) {
  const quests = await Quest.find({ status: "active", participants: userId });
  for (const q of quests) await refreshQuest(q);
}

// Expiry / streaks / repeats for every active quest (or one org's). Read-time + nightly cron.
export async function sweepQuests(filter = {}, orgIds = null) {
  const quests = await Quest.find({ status: "active", ...filter });
  for (const q of quests) await refreshQuest(q, { orgIds });
}
