import { tlReviewAward } from "./xpEngine.js";
import { levelFromTotalXp } from "./xpEngine.js";
/**
 * Team Lead Gamification Service
 *
 * XP sources are leadership-based, NOT task-completion-based.
 * Rewards operational efficiency, delivery quality, sprint stability, review effectiveness.
 */
import GamificationProfile from "../models/GamificationProfile.js";
import XpLog              from "../models/XpLog.js";
import Notification       from "../models/Notification.js";
import { getIo }          from "../utils/io.js";

// ── XP amounts ────────────────────────────────────────────────────────────────
export const TL_XP = {
  MILESTONE_DELIVERED:       100,
  MILESTONE_ON_TIME_BONUS:    80, // extra bonus for on-time
  SPRINT_COMPLETED:          150,
  SPRINT_ON_TIME_BONUS:       80,
  SPRINT_HIGH_COMPLETION:     60, // ≥ 80% completion rate
  SPRINT_PERFECT:            120, // 100% completion
  REVIEW_EFFICIENT:           40, // task passed on first review
  TEAM_STABILITY:             60, // weekly stability reward
  DELIVERY_CONSISTENCY:       30, // per delivery without gaps
};

// ── TL Badge definitions ──────────────────────────────────────────────────────
// condition(tlStats, profile) — both are lean objects
export const TL_BADGE_DEFINITIONS = [
  // ─── Delivery ────────────────────────────────────────────────────────────
  {
    id: "deadline_guardian", name: "Deadline Guardian", category: "delivery", rarity: "common",
    emoji: "🛡️", desc: "First milestone delivered on time",
    condition: (s) => (s.milestonesOnTime ?? 0) >= 1,
  },
  {
    id: "sprint_closer", name: "Sprint Closer", category: "delivery", rarity: "rare",
    emoji: "🏁", desc: "Successfully close your first sprint",
    condition: (s) => (s.sprintsCompleted ?? 0) >= 1,
  },
  {
    id: "milestone_master", name: "Milestone Master", category: "delivery", rarity: "epic",
    emoji: "🏆", desc: "Deliver 10 milestones",
    condition: (s) => (s.milestonesDelivered ?? 0) >= 10,
  },
  {
    id: "delivery_commander", name: "Delivery Commander", category: "delivery", rarity: "legendary",
    emoji: "⚔️", desc: "5 consecutive on-time deliveries",
    condition: (s) => (s.consecutiveOnTime ?? 0) >= 5,
  },
  {
    id: "iron_scheduler", name: "Iron Scheduler", category: "delivery", rarity: "rare",
    emoji: "📅", desc: "Deliver 5 milestones on time",
    condition: (s) => (s.milestonesOnTime ?? 0) >= 5,
  },

  // ─── Leadership ───────────────────────────────────────────────────────────
  {
    id: "team_stabilizer", name: "Team Stabilizer", category: "leadership", rarity: "common",
    emoji: "⚖️", desc: "Earn your first team stability reward",
    condition: (s) => (s.reviewsApproved ?? 0) >= 1,
  },
  {
    id: "workflow_architect", name: "Workflow Architect", category: "leadership", rarity: "rare",
    emoji: "🏗️", desc: "Create and complete 5 sprints",
    condition: (s) => (s.sprintsCompleted ?? 0) >= 5,
  },
  {
    id: "crisis_controller", name: "Crisis Controller", category: "leadership", rarity: "epic",
    emoji: "🚨", desc: "Complete 10 sprints with high delivery rate",
    condition: (s) => (s.sprintsHighCompletion ?? 0) >= 10,
  },
  {
    id: "operations_captain", name: "Operations Captain", category: "leadership", rarity: "legendary",
    emoji: "🎖️", desc: "20 milestones + 10 sprints delivered",
    condition: (s) => (s.milestonesDelivered ?? 0) >= 20 && (s.sprintsCompleted ?? 0) >= 10,
  },

  // ─── Efficiency ───────────────────────────────────────────────────────────
  {
    id: "zero_delay_lead", name: "Zero Delay Lead", category: "efficiency", rarity: "rare",
    emoji: "⚡", desc: "3 consecutive on-time milestones",
    condition: (s) => (s.consecutiveOnTime ?? 0) >= 3,
  },
  {
    id: "fast_reviewer", name: "Fast Reviewer", category: "efficiency", rarity: "common",
    emoji: "🔍", desc: "Approve 10 task reviews",
    condition: (s) => (s.reviewsApproved ?? 0) >= 10,
  },
  {
    id: "clean_executor", name: "Clean Executor", category: "efficiency", rarity: "epic",
    emoji: "✨", desc: "Complete a sprint with 100% task completion",
    condition: (s) => (s.perfectSprints ?? 0) >= 1,
  },
  {
    id: "precision_planner", name: "Precision Planner", category: "efficiency", rarity: "legendary",
    emoji: "🎯", desc: "10 sprints with ≥90% completion rate",
    condition: (s) => (s.sprintsHighCompletion ?? 0) >= 10 && (s.sprintsCompleted ?? 0) >= 10,
  },
  {
    id: "review_ace", name: "Review Ace", category: "efficiency", rarity: "rare",
    emoji: "🏅", desc: "Approve 50 task reviews",
    condition: (s) => (s.reviewsApproved ?? 0) >= 50,
  },

  // ─── Special ─────────────────────────────────────────────────────────────
  {
    id: "legendary_lead", name: "Legendary Lead", category: "special", rarity: "legendary",
    emoji: "👑", desc: "50 milestones delivered",
    condition: (s) => (s.milestonesDelivered ?? 0) >= 50,
  },
  {
    id: "elite_commander", name: "Elite Commander", category: "special", rarity: "legendary",
    emoji: "💎", desc: "25 sprints completed",
    condition: (s) => (s.sprintsCompleted ?? 0) >= 25,
  },
  {
    id: "execution_titan", name: "Execution Titan", category: "special", rarity: "legendary",
    emoji: "🔥", desc: "100 task reviews approved",
    condition: (s) => (s.reviewsApproved ?? 0) >= 100,
  },
  {
    id: "peak_strategist", name: "Peak Strategist", category: "special", rarity: "legendary",
    emoji: "🧠", desc: "10 consecutive on-time deliveries",
    condition: (s) => (s.consecutiveOnTime ?? 0) >= 10,
  },
  {
    id: "sprint_maestro", name: "Sprint Maestro", category: "special", rarity: "epic",
    emoji: "🎼", desc: "3 perfect sprints (100% completion)",
    condition: (s) => (s.perfectSprints ?? 0) >= 3,
  },
];

// ── TL Title definitions ──────────────────────────────────────────────────────
export const TL_TITLE_DEFINITIONS = [
  // Leadership
  {
    id: "tl_operations_lead", name: "Operations Lead", rarity: "common",
    emoji: "⚙️", category: "leadership", desc: "First milestone delivered — your ops career begins.",
    condition: (s, p) => (p.totalXp ?? 0) >= 500 || (s.milestonesDelivered ?? 0) >= 1,
  },
  {
    id: "tl_delivery_chief", name: "Delivery Chief", rarity: "rare",
    emoji: "🚀", category: "delivery", desc: "5 milestones delivered — you own the pipeline.",
    condition: (s) => (s.milestonesDelivered ?? 0) >= 5,
  },
  {
    id: "tl_workflow_commander", name: "Workflow Commander", rarity: "epic",
    emoji: "🏗️", category: "leadership", desc: "10 sprints completed — a true operations architect.",
    condition: (s) => (s.sprintsCompleted ?? 0) >= 10,
  },
  {
    id: "tl_strategic_captain", name: "Strategic Captain", rarity: "legendary",
    emoji: "🎖️", category: "special", desc: "25 milestones + 15 sprints — operational excellence.",
    condition: (s) => (s.milestonesDelivered ?? 0) >= 25 && (s.sprintsCompleted ?? 0) >= 15,
  },

  // Performance
  {
    id: "tl_the_reliable", name: "The Reliable", rarity: "common",
    emoji: "🛡️", category: "delivery", desc: "3 milestones on time — teams trust your schedule.",
    condition: (s) => (s.milestonesOnTime ?? 0) >= 3,
  },
  {
    id: "tl_the_consistent", name: "The Consistent", rarity: "rare",
    emoji: "📅", category: "delivery", desc: "7 consecutive on-time deliveries — zero miss streak.",
    condition: (s) => (s.consecutiveOnTime ?? 0) >= 7,
  },
  {
    id: "tl_the_finisher", name: "The Finisher", rarity: "epic",
    emoji: "🏁", category: "leadership", desc: "20 sprints completed — you close every loop.",
    condition: (s) => (s.sprintsCompleted ?? 0) >= 20,
  },
  {
    id: "tl_the_stabilizer", name: "The Stabilizer", rarity: "legendary",
    emoji: "⚖️", category: "leadership", desc: "15 high-completion sprints — your team never wavers.",
    condition: (s) => (s.sprintsHighCompletion ?? 0) >= 15,
  },

  // Legendary
  {
    id: "tl_master_executor", name: "Master of Execution", rarity: "legendary",
    emoji: "⚔️", category: "special", desc: "50 reviews approved + 20 milestones — elite operator.",
    condition: (s) => (s.reviewsApproved ?? 0) >= 50 && (s.milestonesDelivered ?? 0) >= 20,
  },
  {
    id: "tl_the_architect", name: "The Architect", rarity: "legendary",
    emoji: "🧩", category: "special", desc: "30 sprints + 30 milestones — the system builder.",
    condition: (s) => (s.sprintsCompleted ?? 0) >= 30 && (s.milestonesDelivered ?? 0) >= 30,
  },
  {
    id: "tl_supreme_coordinator", name: "Supreme Coordinator", rarity: "legendary",
    emoji: "👑", category: "special", desc: "Level 20 — pinnacle of leadership mastery.",
    condition: (_s, p) => (p.level ?? 1) >= 20,
  },
  {
    id: "tl_operational_legend", name: "Operational Legend", rarity: "legendary",
    emoji: "💎", category: "special", desc: "50 milestones + 25 sprints + 100 reviews — the rarest achievement.",
    condition: (s) =>
      (s.milestonesDelivered ?? 0) >= 50 &&
      (s.sprintsCompleted ?? 0) >= 25 &&
      (s.reviewsApproved ?? 0) >= 100,
  },
];

// ── Internal helpers ──────────────────────────────────────────────────────────
async function _notify(userId, orgId, message, type = "system") {
  try {
    await Notification.create({ userId, orgId, message, type, isRead: false });
    const io = getIo();
    if (io) io.to(`user:${userId}`).emit("notification:new", { message, type });
  } catch {}
}

// D-058: shared level curve (services/xpEngine.js)
const computeLevelDisplay = levelFromTotalXp;

// ── Core: Award TL XP ─────────────────────────────────────────────────────────
export async function awardTLXp(userId, orgId, amount, source, statIncrement = {}, { logRow = true } = {}) {
  // D-148: atomic. Read-then-$set here could lose an XP change made at the same moment, and monthlyXp was never updated,
  // so a Team Lead's XP was missing from the monthly leaderboard.
  const profileBefore = await GamificationProfile.findOne({ userId }, "level").lean() ?? await GamificationProfile.create({ userId, orgId });
  const profile = { level: profileBefore.level };

  // Build tlStats increment
  const tlInc = {};
  for (const [k, v] of Object.entries(statIncrement)) {
    tlInc[`tlStats.${k}`] = v;
  }
  tlInc[`tlStats.totalXpFromLeadership`] = amount;

  const after = await GamificationProfile.findOneAndUpdate({ userId }, { $inc: { totalXp: amount, monthlyXp: amount, ...tlInc } }, { returnDocument: "after" });
  let newTotal = after.totalXp ?? 0;
  if (newTotal < 0) { newTotal = 0; await GamificationProfile.updateOne({ userId, totalXp: { $lt: 0 } }, { $set: { totalXp: 0 } }); }
  const { level, currentXp, maxXp } = computeLevelDisplay(newTotal);
  const didLevelUp = level > (profile.level ?? 1);
  await Promise.all([
    GamificationProfile.updateOne({ userId }, { $set: { level, currentXp, maxXp } }),
    logRow === false ? null : XpLog.create({ userId, orgId: orgId ?? null, source, amount }),
  ]);

  const io = getIo();
  if (io) {
    io.to(`user:${userId}`).emit("xp:awarded", {
      xpValue:      amount,
      newXpTotal:   newTotal,
      levelUp:      didLevelUp,
      newLevel:     level,
      newCurrentXp: currentXp,
    });
    if (didLevelUp) {
      io.to(`user:${userId}`).emit("level:up", { newLevel: level });
      await _notify(userId, orgId, `Level Up! You are now Level ${level} — keep leading! 🎖️`, "system");
    }
  }

  return { level, currentXp, maxXp, totalXp: newTotal, xpAwarded: amount };
}

// ── Check + Award TL Badges ───────────────────────────────────────────────────
export async function checkTLBadges(userId, orgId) {
  const profile = await GamificationProfile.findOne({ userId }).lean();
  if (!profile) return;

  const tlStats   = profile.tlStats ?? {};
  const earnedIds = new Set((profile.badges ?? []).map((b) => b.id).filter(Boolean));

  for (const def of TL_BADGE_DEFINITIONS) {
    if (earnedIds.has(def.id)) continue;
    try {
      if (!def.condition(tlStats, profile)) continue;
    } catch { continue; }

    await GamificationProfile.updateOne(
      { userId },
      {
        $push: { badges: { id: def.id, name: def.name, type: def.category, rarity: def.rarity, earnedAt: new Date() } },
        $inc:  { gold: rarityGold(def.rarity) },
      }
    );

    await _notify(userId, orgId, `Badge Unlocked: "${def.name}" ${def.emoji}! Leadership milestone achieved.`, "badge");

    const io = getIo();
    if (io) {
      io.to(`user:${userId}`).emit("badge:unlocked", {
        badge: { id: def.id, name: def.name, rarity: def.rarity, emoji: def.emoji },
      });
    }
  }
}

// ── Check + Award TL Titles ───────────────────────────────────────────────────
export async function checkTLTitles(userId, orgId) {
  const profile = await GamificationProfile.findOne({ userId }).lean();
  if (!profile) return;

  const tlStats     = profile.tlStats ?? {};
  const unlockedIds = new Set((profile.titles ?? []).map((t) => t.id).filter(Boolean));

  for (const def of TL_TITLE_DEFINITIONS) {
    if (unlockedIds.has(def.id)) continue;
    try {
      if (!def.condition(tlStats, profile)) continue;
    } catch { continue; }

    await GamificationProfile.updateOne(
      { userId },
      { $push: { titles: { id: def.id, name: def.name, rarity: def.rarity, unlockedAt: new Date() } } }
    );

    await _notify(userId, orgId, `Title Unlocked: "${def.name}"! Equip it from your profile.`, "system");

    const io = getIo();
    if (io) {
      io.to(`user:${userId}`).emit("title:unlocked", { title: { id: def.id, name: def.name, rarity: def.rarity } });
    }
  }
}

function rarityGold(rarity) {
  return rarity === "legendary" ? 200 : rarity === "epic" ? 80 : rarity === "rare" ? 30 : 10;
}

// ── T-6 (D-148): the one way a Team Lead earns XP for a review, on every review route. ──
// The ledger row comes first: its unique index (task + TL) stops a second award, so no route can double it.
export async function awardTLReviewXp({ tlId, orgId, taskId, stars, submittedAt, approvedAt, conditional = false }) {
  const plan = tlReviewAward({ stars, submittedAt, approvedAt, conditional });
  if (!plan.xp) return { xp: 0, reason: plan.reason };
  try {
    await XpLog.create({ userId: tlId, orgId: orgId ?? null, source: "tl_review_efficiency", amount: plan.xp, taskId });
  } catch (err) {
    if (err?.code === 11000) return { xp: 0, reason: "already_awarded" };
    throw err;
  }
  await awardTLXp(tlId, orgId, plan.xp, "tl_review_efficiency", { reviewsApproved: 1 }, { logRow: false });
  await checkTLBadges(tlId, orgId);
  return { xp: plan.xp, reason: null };
}
