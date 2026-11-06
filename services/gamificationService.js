import GamificationProfile from "../models/GamificationProfile.js";
import XpLog              from "../models/XpLog.js";
import Notification       from "../models/Notification.js";
import Task               from "../models/Task.js";
import User               from "../models/User.js";
import Organization       from "../models/Organization.js";
import AuditLog           from "../models/AuditLog.js";
import { calculateTaskXP, levelFromTotalXp, crossedBurnout, lateAtSubmission, streakWindow, HP_BURNOUT, xpIncrement } from "./xpEngine.js";
import { getIo }          from "../utils/io.js";
import { reversalPlan }   from "./anomalyRules.js";

const IS_OBJECT_ID = /^[0-9a-f]{24}$/i;

async function fetchOrgRules(orgId) {
  try {
    const filter = IS_OBJECT_ID.test(String(orgId)) ? { _id: orgId } : { orgId: String(orgId) };
    const org = await Organization.findOne(filter, "gamificationRules").lean();
    return org?.gamificationRules ?? null;
  } catch {
    return null;
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────
export const XP_CONFIG = {
  TASK_BASE_XP: { Critical: 100, High: 75, Medium: 50, Low: 25 },

  ON_TIME_BONUS_PCT: 0.20,
  EARLY_BONUS_PCT:   0.10,

  QUALITY_MULTIPLIER: {
    5: 1.30,
    4: 1.15,
    3: 1.00,
    2: 0.85,
    1: 0.70,
  },

  STREAK_XP_PER_DAY: 5,
  STREAK_XP_CAP:     50,

  FIRST_LATE_WARNING:  true,
  LATE_XP_PENALTY_PCT: 0.15,
  LATE_HP_PENALTY:     5,

  REJECTION_XP_PENALTY: 10,
  REJECTION_HP_PENALTY:  3,

  ASSIGNER_BONUS_5STAR: 5,

  HP_MAX: 100, HP_MIN: 0,
  HP_DAILY_REGEN: 2,

  // Level curve: services/xpEngine.js levelFromTotalXp (D-058)
};

// ── Badge definitions ─────────────────────────────────────────────────────────
export const BADGE_DEFINITIONS = [
  { id: "on_fire",      name: "On Fire",       type: "streak",  rarity: "epic",
    description: "Maintain a 7-day daily streak",         goldReward: 50,
    condition: (p) => (p.streaks?.daily ?? 0) >= 7 },
  { id: "unstoppable",  name: "Unstoppable",   type: "streak",  rarity: "epic",
    description: "Maintain a 30-day daily streak",        goldReward: 100,
    condition: (p) => (p.streaks?.daily ?? 0) >= 30 },
  { id: "the_legend",   name: "The Legend",    type: "streak",  rarity: "legendary",
    description: "Maintain a 100-day streak",             goldReward: 500,
    condition: (p) => (p.streaks?.daily ?? 0) >= 100 },
  { id: "sprint_mvp",   name: "Sprint MVP",    type: "task",    rarity: "legendary",
    description: "Complete 10 tasks",                     goldReward: 100,
    condition: (p) => (p.stats?.tasksCompleted ?? 0) >= 10 },
  { id: "speed_demon",  name: "Speed Demon",   type: "task",    rarity: "rare",
    description: "Submit 10 tasks before deadline",       goldReward: 25,
    condition: (p) => (p.stats?.onTimeDeliveries ?? 0) >= 10 },
  { id: "perfectionist", name: "Perfectionist", type: "task",   rarity: "legendary",
    description: "Complete 5+ tasks with zero late submissions", goldReward: 200,
    condition: (p) =>
      (p.stats?.tasksCompleted ?? 0) >= 5 && (p.stats?.lateSubmissions ?? 0) === 0 },
  { id: "clean_coder",  name: "Clean Coder",   type: "quality", rarity: "rare",
    description: "Maintain avg quality score 4.5+ over 5+ tasks", goldReward: 25,
    condition: (p) =>
      (p.stats?.avgQualityScore ?? 0) >= 4.5 && (p.stats?.tasksCompleted ?? 0) >= 5 },
  { id: "xp_hunter",   name: "XP Hunter",     type: "xp",      rarity: "rare",
    description: "Earn 5,000 total XP",                   goldReward: 25,
    condition: (p) => (p.totalXp ?? 0) >= 5000 },
  { id: "10x_pioneer",  name: "10x Pioneer",   type: "xp",      rarity: "epic",
    description: "Earn 10,000 total XP",                  goldReward: 50,
    condition: (p) => (p.totalXp ?? 0) >= 10000 },
  { id: "the_mentor",   name: "The Mentor",    type: "special", rarity: "rare",
    description: "Complete 10 task reviews",               goldReward: 25,
    condition: (p) => (p.stats?.reviewsGiven ?? 0) >= 10 },
  { id: "early_adopter", name: "Early Adopter", type: "special", rarity: "legendary",
    description: "Founding member of the organization",    goldReward: 100,
    condition: (p) => p.stats?.isFoundingMember === true },
  { id: "bug_slayer",   name: "Bug Slayer",    type: "special", rarity: "epic",
    description: "Fix 10 Bug-type tasks",                  goldReward: 50,
    condition: (p) => (p.stats?.bugsFixed ?? 0) >= 10 },
  // Legacy
  { id: "first_quest",  name: "First Quest",   type: "task",    rarity: "common",
    description: "Complete your first task",               goldReward: 10,
    condition: (p) => (p.stats?.tasksCompleted ?? 0) >= 1 },
  { id: "xp_rookie",    name: "XP Rookie",     type: "xp",      rarity: "common",
    description: "Earn 1,000 total XP",                    goldReward: 10,
    condition: (p) => (p.totalXp ?? 0) >= 1000 },
];

// ── Title definitions ─────────────────────────────────────────────────────────
export const TITLE_DEFINITIONS = [
  { id: "newcomer",       name: "The Newcomer",   rarity: "common",    condition: () => true },
  { id: "rising_star",    name: "Rising Star",    rarity: "common",    condition: (p) => (p.totalXp ?? 0) >= 100 },
  { id: "apprentice",     name: "Apprentice",     rarity: "common",    condition: (p) => (p.level ?? 1) >= 5 },
  { id: "journeyman",     name: "Journeyman",     rarity: "common",    condition: (p) => (p.level ?? 1) >= 10 },
  { id: "the_adept",      name: "The Adept",      rarity: "rare",      condition: (p) => (p.level ?? 1) >= 15 },
  { id: "expert",         name: "Expert",         rarity: "rare",      condition: (p) => (p.level ?? 1) >= 20 },
  { id: "master",         name: "Master",         rarity: "epic",      condition: (p) => (p.level ?? 1) >= 30 },
  { id: "grand_master",   name: "Grand Master",   rarity: "legendary", condition: (p) => (p.level ?? 1) >= 50 },
  { id: "command_chief",  name: "Command Chief",  rarity: "legendary",
    condition: (_p, user) => user?.role === "Director" },
  { id: "code_vanguard",  name: "Code Vanguard",  rarity: "epic",
    condition: (p, user) =>
      ["Senior Developer", "Junior Developer"].includes(user?.role) && (p.level ?? 1) >= 10 },
  { id: "design_artisan", name: "Design Artisan", rarity: "epic",
    condition: (p, user) =>
      ["Senior Designer", "Junior Designer"].includes(user?.role) && (p.level ?? 1) >= 10 },
  { id: "qa_guardian",    name: "QA Guardian",    rarity: "epic",
    condition: (p, user) =>
      ["Senior Tester", "Junior Tester"].includes(user?.role) && (p.level ?? 1) >= 10 },
  { id: "the_mentor_title", name: "The Mentor",   rarity: "rare",
    condition: (p) => (p.stats?.reviewsGiven ?? 0) >= 10 },
];

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _notify(userId, orgId, message, type = "system") {
  await Notification.create({ userId, orgId, message, type, isRead: false });
  const io = getIo();
  if (io) io.to(`user:${userId}`).emit("notification:new", { message, type });
}

// 1.11e: when HP drops below HP_BURNOUT, tell the employee (burnout_risk) and their leads (burnout_alert). Once per crossing.
export async function notifyBurnout(userId, orgId, prevHp, nextHp) {
  if (!crossedBurnout(prevHp, nextHp)) return;
  await _notify(userId, orgId,
    `Your HP is ${nextHp}/100 (below ${HP_BURNOUT}). Take a breather, and talk to your Team Lead if your workload is too high.`,
    "burnout_risk");
  const [leads, me] = await Promise.all([
    User.find({ orgId, role: { $in: ["Manager", "Team Lead", "Director"] }, status: "active" }).select("_id").lean(),
    User.findById(userId, "name").lean(),
  ]);
  for (const l of leads) {
    await _notify(l._id, orgId, `Burnout risk: ${me?.name ?? "A team member"} is at ${nextHp}/100 HP. Consider reducing their workload.`, "burnout_alert");
  }
}

// Level curve and XP formula live in the pure engine (D-058, D-066, tests in server/tests).
const computeLevelDisplay = levelFromTotalXp;
export { calculateTaskXP };

// ── Level recalculation ───────────────────────────────────────────────────────
export async function recalculateLevel(userId, orgId) {
  const profile = await GamificationProfile.findOne({ userId });
  if (!profile) return;

  const { level, currentXp, maxXp } = computeLevelDisplay(profile.totalXp ?? 0);
  const didLevelUp = level > (profile.level ?? 1);

  await GamificationProfile.findOneAndUpdate(
    { userId },
    { $set: { level, currentXp, maxXp } }
  );

  if (didLevelUp) {
    const io = getIo();
    if (io) io.to(`user:${userId}`).emit("level:up", { newLevel: level });
    if (orgId) {
      await _notify(userId, orgId, `Level Up! You are now Level ${level}!`, "system");
    }
  }
}

// ── Badge check ───────────────────────────────────────────────────────────────
export async function checkAndAwardBadges(userId, orgId, profile) {
  const p = profile ?? await GamificationProfile.findOne({ userId }).lean();
  if (!p) return;

  const earnedIds = new Set((p.badges ?? []).map((b) => b.id).filter(Boolean));

  for (const def of BADGE_DEFINITIONS) {
    if (earnedIds.has(def.id)) continue;
    if (!def.condition(p)) continue;

    await GamificationProfile.findOneAndUpdate(
      { userId },
      {
        $push: { badges: {
          id: def.id, name: def.name, type: def.type,
          rarity: def.rarity, earnedAt: new Date(),
        }},
        $inc: { gold: def.goldReward ?? 10 },
      }
    );

    await _notify(
      userId, orgId,
      `Badge Unlocked: "${def.name}"! +${def.goldReward ?? 10} gold`,
      "badge"
    );

    const io = getIo();
    if (io) {
      io.to(`user:${userId}`).emit("badge:unlocked", {
        badge: { id: def.id, name: def.name, rarity: def.rarity },
      });
    }
  }
}

// ── Title check ───────────────────────────────────────────────────────────────
export async function checkAndAwardTitles(userId, orgId, profile, userDoc) {
  const p = profile ?? await GamificationProfile.findOne({ userId }).lean();
  if (!p) return;

  const unlockedIds = new Set((p.titles ?? []).map((t) => t.id).filter(Boolean));

  for (const def of TITLE_DEFINITIONS) {
    if (unlockedIds.has(def.id)) continue;
    if (!def.condition(p, userDoc)) continue;

    await GamificationProfile.findOneAndUpdate(
      { userId },
      { $push: { titles: { id: def.id, name: def.name, rarity: def.rarity, unlockedAt: new Date() } } }
    );

    await _notify(
      userId, orgId,
      `Title Unlocked: "${def.name}"! Equip it from your profile.`,
      "system"
    );
  }
}

// ── Core XP award (backward-compat for directorController, etc.) ──────────────
export async function awardXp(userId, orgId, amount, source, gold = Math.floor(Math.abs(amount) * 0.5)) {
  // Directors are not part of the gamification system
  const actor = await User.findById(userId, "role").lean();
  if (actor?.role === "Director") return { skipped: true };

  let profile = await GamificationProfile.findOne({ userId });
  if (!profile) {
    profile = await GamificationProfile.create({ userId, orgId: orgId ?? null });
  }

  // E-4b (D-195): one atomic $inc of total, month and gold. Before, a read-then-$set left monthlyXp out (the same bug
  // D-148 fixed in awardTLXp) and could lose a change made at the same moment. Totals never go below 0.
  const after = await GamificationProfile.findOneAndUpdate({ userId }, { $inc: xpIncrement(amount, gold) }, { returnDocument: "after" });
  if ((after?.totalXp ?? 0) < 0) await GamificationProfile.updateOne({ userId, totalXp: { $lt: 0 } }, { $set: { totalXp: 0 } });
  if ((after?.monthlyXp ?? 0) < 0) await GamificationProfile.updateOne({ userId, monthlyXp: { $lt: 0 } }, { $set: { monthlyXp: 0 } });
  const newTotal = Math.max(0, after?.totalXp ?? 0);
  const newGold  = after?.gold ?? 0;
  const { level, currentXp, maxXp } = computeLevelDisplay(newTotal);
  const didLevelUp = level > (profile.level ?? 1);

  // Strip optional ":taskId" suffix so XpLog enum matches (source may be "task_accepted:abc123")
  const logSource = source.split(":")[0];

  await Promise.all([
    GamificationProfile.updateOne({ userId }, { $set: { level, currentXp, maxXp } }),
    XpLog.create({ userId, orgId: orgId ?? null, source: logSource, amount }),
  ]);

  const io = getIo();
  if (io) {
    io.to(`user:${userId}`).emit("xp:awarded", {
      xpValue:      amount,
      goldValue:    gold,
      newXpTotal:   newTotal,
      newGold,
      levelUp:      didLevelUp,
      newLevel:     level,
      newCurrentXp: currentXp,
    });
    if (didLevelUp) {
      io.to(`user:${userId}`).emit("level:up", { newLevel: level });
    }
  }

  return { level, currentXp, maxXp, totalXp: newTotal, gold: newGold, xpAwarded: amount };
}

export async function getOrCreateProfile(userId, orgId) {
  let profile = await GamificationProfile.findOne({ userId });
  if (!profile) profile = await GamificationProfile.create({ userId, orgId: orgId ?? null });
  return profile;
}

// ── task.approved handler ─────────────────────────────────────────────────────
// Emitter payload: { taskId, assignees, qualityScore, approverId, orgId, taskTitle }
async function applyTaskApproved({ taskId, assignees, qualityScore = 3, approverId, orgId, taskTitle }) {
  const task = await Task.findById(taskId).lean();
  if (!task) return;

  // Fetch this org's gamification rules once and share across all assignees
  const orgRules = await fetchOrgRules(orgId);


  const qs = Math.max(1, Math.min(5, Math.round(qualityScore ?? 3)));

  const recipients = [...new Set([...(assignees ?? []), ...(task.assignee ? [task.assignee] : [])].map(String))];

  for (const uid of recipients) {
    const profile = await GamificationProfile.findOne({ userId: uid });
    if (!profile) continue;

    const submittedAt = task.submittedAt ?? task.updatedAt ?? new Date();
    const deadline    = task.deadline ? new Date(task.deadline) : null;
    // D-057: lateness was fixed at the first submission (legacy tasks: judged from submittedAt).
    const { isLate }  = lateAtSubmission(task, new Date(submittedAt));

    // D-056/D-066: one formula, xpValue base, −15 % and −5 HP for every late task.
    const calc = calculateTaskXP({
      task, submittedAt, isLate, qualityStars: qs,
      streakDays: profile.streaks?.daily ?? 0, orgRules,
    });
    const xpEarned       = calc.finalXP;
    const goldEarned     = calc.gold;
    const hpDelta        = calc.hpDelta;
    const warningIssued  = false;
    const penaltyApplied = isLate;

    // Double-award guard (V1 1.2): the ledger row is written first; the unique
    // {userId, taskId, source} index rejects a second approval of the same task.
    try {
      await XpLog.create({
        userId:         uid,
        orgId:          profile.orgId ?? null,
        amount:         xpEarned,
        source:         "task_approved",
        taskId,
        qualityScore:   qs,
        isLate,
        warningIssued,
        penaltyApplied,
        breakdown: {
          base: calc.base, typeMult: calc.typeMult, timeMult: calc.timeMult, qualMult: calc.qualMult,
          streakMult: calc.streakMult, lateMult: calc.lateMult, gold: goldEarned, priority: task.priority,
        },
      });
    } catch (err) {
      if (err?.code === 11000) {
        console.warn(`[Gamification] XP already awarded for task ${taskId} to ${uid}; skipped.`);
        continue;
      }
      throw err;
    }
    await AuditLog.create({
      action:       "xp_awarded",
      orgId:        profile.orgId ?? null,
      targetUserId: uid,
      performedBy:  approverId ?? "system",
      scope:        "account",
      detail:       `+${xpEarned} XP for task "${task.title}"`,
      after:        { amount: xpEarned, gold: goldEarned, taskId: String(taskId), qualityScore: qs, isLate },
    }).catch((e) => console.error("[Gamification] audit xp_awarded:", e.message));

    // M-5 / D-076: anomaly flags for this award. Never blocks or fails the award.
    import("./flagService.js").then((m) => m.recordAwardFlags({ task, userId: uid, xp: xpEarned, stars: qs, approverId, orgId }))
      .catch((e) => console.error("[Gamification] anomaly flags:", e.message));

    // Quality streak
    const qualStreakInc   = qs >= 4 ? 1 : 0;
    const qualStreakReset = qs < 4;

    // HP clamp
    const newHP = Math.min(XP_CONFIG.HP_MAX, Math.max(XP_CONFIG.HP_MIN, (profile.hp ?? 100) + hpDelta));

    await notifyBurnout(uid, orgId, profile.hp ?? 100, newHP);

    // Running avg quality score
    const completedCount = (profile.stats?.tasksCompleted ?? 0) + 1;
    const prevAvg        = profile.stats?.avgQualityScore ?? 0;
    const newAvg         = Math.round(
      (((prevAvg * (completedCount - 1)) + qs) / completedCount) * 10
    ) / 10;

    // Bug count increment
    const bugInc = task.type === "Bug" ? 1 : 0;

    // Build $inc ops
    const incOps = {
      totalXp:                xpEarned,
      monthlyXp:              xpEarned,
      gold:                   goldEarned,
      "stats.tasksCompleted": 1,
      "stats.bugsFixed":      bugInc,
    };
    if (isLate)             incOps["stats.lateSubmissions"]  = 1;
    if (!isLate && deadline) incOps["stats.onTimeDeliveries"] = 1;
    if (qualStreakInc)       incOps["streaks.quality"]        = 1;

    const setOps = {
      hp:                     newHP,
      "stats.avgQualityScore": newAvg,
    };
    if (qualStreakReset) setOps["streaks.quality"] = 0;

    const updatedProfile = await GamificationProfile.findOneAndUpdate(
      { userId: uid },
      { $inc: incOps, $set: setOps },
      { returnDocument: "after" }
    );

    const levelBefore = profile.level ?? 1;
    await recalculateLevel(uid, orgId);
    const lv = levelFromTotalXp(updatedProfile?.totalXp ?? 0);

    // Assigner bonus for 5-star
    if (qs === 5 && task.assignedBy) {
      await GamificationProfile.findOneAndUpdate(
        { userId: task.assignedBy.toString() },
        { $inc: { totalXp: XP_CONFIG.ASSIGNER_BONUS_5STAR, monthlyXp: XP_CONFIG.ASSIGNER_BONUS_5STAR } }
      );
      // D-148: this bonus changed the total without a ledger row, so profile and log could not agree.
      await XpLog.create({ userId: task.assignedBy, orgId: orgId ?? null, source: "assigner_bonus", amount: XP_CONFIG.ASSIGNER_BONUS_5STAR, taskId });
      await _notify(task.assignedBy, orgId,
        `Your assigned task "${task.title}" received 5 stars! +${XP_CONFIG.ASSIGNER_BONUS_5STAR} XP bonus.`,
        "xp"
      );
    }

    await _notify(uid, orgId,
      `Task "${taskTitle}" approved! +${xpEarned} XP, +${goldEarned} gold${penaltyApplied ? " (late: −15% XP, −5 HP)" : ""}`,
      "xp"
    );

    const io = getIo();
    if (io) {
      // 1.11c: same event and shape as awardXp (client listens for xp:awarded, report TC-GX-06)
      io.to(`user:${uid}`).emit("xp:awarded", {
        xpValue:      xpEarned,
        goldValue:    goldEarned,
        newXpTotal:   updatedProfile?.totalXp ?? 0,
        newGold:      updatedProfile?.gold ?? 0,
        levelUp:      lv.level > levelBefore,
        newLevel:     lv.level,
        newCurrentXp: lv.currentXp,
        hp:           newHP,
        qualityScore: qs,
        isLate,
      });
    }

    // Badge + title checks
    const freshProfile = await GamificationProfile.findOne({ userId: uid }).lean();
    const userDoc = await User.findById(uid).lean();
    await checkAndAwardBadges(uid, orgId, freshProfile);
    await checkAndAwardTitles(uid, orgId, freshProfile, userDoc);

    // M-5: challenge progress from the ledger; rewards go through applyQuestReward below.
    import("./questService.js").then((m) => m.evaluateQuestsForUser(uid))
      .catch((e) => console.error("[Gamification] quest progress:", e.message));
  }
}

// ── Challenge reward (M-5, FR07) ──────────────────────────────────────────────
// Same path as a task award: ledger row first (unique {userId, questId}), then profile, level, celebration.
// Returns false when this user already got this quest's reward.
export async function applyQuestReward({ questId, userId, orgId, xp, gold = 0, title, by = "system" }) {
  const profile = await getOrCreateProfile(userId, orgId);
  try {
    await XpLog.create({ userId, orgId: profile.orgId ?? null, amount: xp, source: "quest", questId, breakdown: { gold, questTitle: title } });
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
  const levelBefore = profile.level ?? 1;
  const updated = await GamificationProfile.findOneAndUpdate({ userId }, { $inc: { totalXp: xp, monthlyXp: xp, gold } }, { returnDocument: "after" });
  await recalculateLevel(userId, orgId);
  const lv = levelFromTotalXp(updated?.totalXp ?? 0);
  AuditLog.create({ action: "xp_awarded", orgId: profile.orgId ?? null, targetUserId: userId, performedBy: by, scope: "account",
    detail: `+${xp} XP, +${gold} gold for challenge "${title}"`, after: { amount: xp, gold, questId: String(questId) } })
    .catch((e) => console.error("[Gamification] audit quest:", e.message));
  await _notify(userId, orgId, `Challenge complete: "${title}"! +${xp} XP${gold ? `, +${gold} gold` : ""}.`, "xp");
  const io = getIo();
  if (io) {
    io.to(`user:${userId}`).emit("xp:awarded", { xpValue: xp, goldValue: gold, newXpTotal: updated?.totalXp ?? 0, newGold: updated?.gold ?? 0,
      levelUp: lv.level > levelBefore, newLevel: lv.level, newCurrentXp: lv.currentXp, source: "quest" });
    io.to(`user:${userId}`).emit("quest:completed", { questId: String(questId), title, xp, gold });
  }
  const fresh = await GamificationProfile.findOne({ userId }).lean();
  await checkAndAwardBadges(userId, orgId, fresh);
  return true;
}

// ── Anomaly confirmed → XP reversal (M-5, FR05-13) ───────────────────────────
// A NEGATIVE ledger row cancels one original award (unique on reversalOf, so it happens once);
// the original row is never touched. Totals stay at 0 or above; level is recomputed.
export async function applyFlagReversal({ original, flagId, by, orgId, taskTitle }) {
  const profile = await getOrCreateProfile(original.userId, orgId);
  const plan = reversalPlan({ original, profile });
  if (!plan) return null;
  try {
    await XpLog.create({ userId: original.userId, orgId: profile.orgId ?? null, amount: plan.amount, source: "flag_reversal",
      taskId: original.taskId ?? null, questId: original.questId ?? null, reversalOf: original._id, flagId, breakdown: { gold: plan.goldDelta } });
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
  await GamificationProfile.updateOne({ userId: original.userId }, { $inc: { totalXp: plan.amount, monthlyXp: plan.amount, gold: plan.goldDelta } });
  await GamificationProfile.updateOne({ userId: original.userId, totalXp: { $lt: 0 } }, { $set: { totalXp: 0 } });
  await GamificationProfile.updateOne({ userId: original.userId, monthlyXp: { $lt: 0 } }, { $set: { monthlyXp: 0 } });
  await GamificationProfile.updateOne({ userId: original.userId, gold: { $lt: 0 } }, { $set: { gold: 0 } });
  await recalculateLevel(original.userId, orgId);
  AuditLog.create({ action: "xp_adjusted", orgId: profile.orgId ?? null, targetUserId: original.userId, performedBy: by, scope: "account",
    detail: `${plan.amount} XP after a review of "${taskTitle ?? "a task"}"`, after: { amount: plan.amount, gold: plan.goldDelta, reversalOf: String(original._id), flagId: String(flagId) } })
    .catch((e) => console.error("[Gamification] audit reversal:", e.message));
  await _notify(original.userId, orgId, `After a review, the XP for "${taskTitle ?? "a task"}" was adjusted by ${plan.amount} XP. Ask your Manager if you have questions.`, "xp_adjusted");
  return plan;
}

// ── task.rejected handler ─────────────────────────────────────────────────────
async function applyTaskRejected({ taskId, orgId, reason }) {
  const task = await Task.findById(taskId).lean();
  if (!task) return;

  for (const assigneeId of (task.assignees ?? [])) {
    const uid     = assigneeId.toString();
    const profile = await GamificationProfile.findOne({ userId: uid }).lean();
    if (!profile) continue;

    const newHP = Math.max(XP_CONFIG.HP_MIN, (profile.hp ?? 100) - XP_CONFIG.REJECTION_HP_PENALTY);

    await GamificationProfile.findOneAndUpdate(
      { userId: uid },
      {
        $inc: {
          totalXp:               -XP_CONFIG.REJECTION_XP_PENALTY,
          monthlyXp:             -XP_CONFIG.REJECTION_XP_PENALTY,
          "stats.tasksRejected":  1,
        },
        $set: { hp: newHP },
      }
    );

    // Floor guard — XP never below 0
    await GamificationProfile.updateOne(
      { userId: uid, totalXp: { $lt: 0 } },
      { $set: { totalXp: 0 } }
    );
    await GamificationProfile.updateOne(
      { userId: uid, monthlyXp: { $lt: 0 } },
      { $set: { monthlyXp: 0 } }
    );

    await XpLog.create({
      userId: uid,
      orgId:  profile.orgId ?? null,
      amount: -XP_CONFIG.REJECTION_XP_PENALTY,
      source: "task_rejected",
      taskId,
    });

    await _notify(uid, orgId,
      `Task "${task.title}" rejected. -${XP_CONFIG.REJECTION_XP_PENALTY} XP, -${XP_CONFIG.REJECTION_HP_PENALTY} HP. Reason: ${reason ?? "See review notes"}`,
      "task_rejected"
    );
    await notifyBurnout(uid, orgId, profile.hp ?? 100, newHP);
    await recalculateLevel(uid, orgId);

    const io = getIo();
    if (io) {
      io.to(`user:${uid}`).emit("xp:penalty", {
        amount:  -XP_CONFIG.REJECTION_XP_PENALTY,
        hpLost:  XP_CONFIG.REJECTION_HP_PENALTY,
        newHP,
        reason:  "Task rejected",
      });
    }
  }
}

// ── Daily streak cron ─────────────────────────────────────────────────────────
// Streak only counts Mon–Fri. On weekends the cron still runs HP regen but
// does NOT break or advance streaks — working-day inactivity required to reset.
export async function updateDailyStreaks(now = new Date()) {
  // 1.11b: judge the working day that just ended (cron fires at 00:00).
  const { start, end, isWorkingDay } = streakWindow(now);

  if (isWorkingDay) {
    const activeUserIds = await Task.distinct("assignees", {
      status:      "Done",
      completedAt: { $gte: start, $lt: end },
    });

    if (activeUserIds.length > 0) {
      await GamificationProfile.updateMany(
        { userId: { $in: activeUserIds } },
        { $inc: { "streaks.daily": 1, "streaks.collab": 1 } }
      );
    }

    // Only reset streak if inactive on a working day
    await GamificationProfile.updateMany(
      { userId: { $nin: activeUserIds } },
      { $set: { "streaks.daily": 0 } }
    );
  }
  // Weekend: no streak change at all (no increment, no reset)

  // HP daily regen always runs regardless of day
  await GamificationProfile.updateMany(
    {},
    [{ $set: { hp: { $min: [XP_CONFIG.HP_MAX, { $add: ["$hp", XP_CONFIG.HP_DAILY_REGEN] }] } } }]
  );

  console.log(`[Gamification] Daily streaks updated. Working day: ${isWorkingDay}`);
  // M-5: streak challenges, expiry and repeats.
  import("./questService.js").then((m) => m.sweepQuests()).catch((e) => console.error("[Gamification] quest sweep:", e.message));
}

// ── Register event listeners ──────────────────────────────────────────────────
export function registerGamificationListeners(emitter) {
  emitter.on("task.approved", async (payload) => {
    try {
      await applyTaskApproved(payload);
    } catch (err) {
      console.error("[Gamification] task.approved error:", err.message);
    }
  });

  emitter.on("task.rejected", async (payload) => {
    try {
      await applyTaskRejected(payload);
    } catch (err) {
      console.error("[Gamification] task.rejected error:", err.message);
    }
  });
}
