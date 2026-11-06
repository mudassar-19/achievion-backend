/**
 * Team Lead Gamification Controller
 * Endpoints:
 *   GET  /api/teamlead/gamification/profile         — full TL gami profile
 *   GET  /api/teamlead/gamification/leaderboard     — TL org leaderboard
 *   GET  /api/teamlead/gamification/badges          — TL badge catalog + earned
 *   GET  /api/teamlead/gamification/titles          — TL title catalog + earned
 *   PATCH /api/teamlead/gamification/titles/equip   — equip a title { titleId }
 *   GET  /api/teamlead/gamification/xp-events       — recent XP log (last 30)
 *   GET  /api/teamlead/gamification/timeline        — achievement timeline
 */
import GamificationProfile from "../models/GamificationProfile.js";
import XpLog              from "../models/XpLog.js";
import User, { ROLE_CATEGORY_MAP } from "../models/User.js";
import { TL_BADGE_DEFINITIONS, TL_TITLE_DEFINITIONS } from "../services/tlGamificationService.js";

// ── GET /api/teamlead/gamification/profile ────────────────────────────────────
export async function getTLGamProfile(req, res) {
  const { id: userId, orgId } = req.user;

  let profile = await GamificationProfile.findOne({ userId }).lean();
  if (!profile) {
    profile = await GamificationProfile.create({ userId, orgId });
    profile = profile.toObject();
  }

  const tlStats = profile.tlStats ?? {};

  // Recent XP events (last 10 TL-specific)
  const xpEvents = await XpLog.find(
    { userId, source: { $regex: /^tl_/ } },
    "source amount createdAt"
  ).sort({ createdAt: -1 }).limit(10).lean();

  res.json({
    level:     profile.level    ?? 1,
    currentXp: profile.currentXp ?? 0,
    maxXp:     profile.maxXp    ?? 100,
    totalXp:   profile.totalXp  ?? 0,
    gold:      profile.gold     ?? 0,
    hp:        profile.hp       ?? 100,
    badges:    profile.badges   ?? [],
    titles:    profile.titles   ?? [],
    activeTitle: profile.activeTitle ?? null,
    tlStats,
    recentXpEvents: xpEvents.map((e) => ({
      source:    e.source,
      amount:    e.amount,
      label:     XP_SOURCE_LABEL[e.source] ?? e.source,
      timestamp: e.createdAt,
    })),
  });
}

// ── GET /api/teamlead/gamification/leaderboard ────────────────────────────────
// Query: ?tab=org|sprint  (default: org)
const TL_ROLES = Object.keys(ROLE_CATEGORY_MAP).filter((r) => ROLE_CATEGORY_MAP[r] === "team_lead");

export async function getTLLeaderboard(req, res) {
  const { orgId, id: requestingUserId } = req.user;
  const tab = req.query.tab ?? "org";

  // All Team Leads in org
  const tls = await User.find(
    // roleCategory is a virtual (not stored), so filter by the stored role list.
    { orgId, role: { $in: TL_ROLES }, status: { $ne: "deleted" } },
    "_id name role"
  ).lean();
  const tlIds  = tls.map((u) => u._id);
  const tlMap  = Object.fromEntries(tls.map((u) => [String(u._id), u]));

  const profiles = await GamificationProfile.find(
    { userId: { $in: tlIds } },
    "userId totalXp level badges activeTitle tlStats"
  ).lean();

  const scored = profiles.map((p) => {
    const uid = String(p.userId);
    const u   = tlMap[uid] ?? {};
    const s   = p.tlStats ?? {};
    const totalXp     = p.totalXp ?? 0;

    // Delivery score: milestones + sprints + efficiency
    const milestones  = s.milestonesDelivered   ?? 0;
    const msOnTime    = s.milestonesOnTime       ?? 0;
    const sprints     = s.sprintsCompleted       ?? 0;
    const spHighComp  = s.sprintsHighCompletion  ?? 0;
    const reviews     = s.reviewsApproved        ?? 0;
    const consecutive = s.consecutiveOnTime      ?? 0;

    const onTimeRate  = milestones > 0 ? Math.round((msOnTime  / milestones) * 100) : 0;
    const sprintRate  = sprints    > 0 ? Math.round((spHighComp / sprints)   * 100) : 0;

    // Composite score for rankings
    const deliveryScore = tab === "sprint"
      ? (sprints * 10 + spHighComp * 15 + consecutive * 5)
      : (milestones * 10 + msOnTime * 8 + sprints * 6 + reviews * 2 + consecutive * 10);

    const tieBreaker1 = onTimeRate;
    const tieBreaker2 = sprintRate;
    const tieBreaker3 = reviews;

    return {
      userId: uid,
      name:   u.name ?? "—",
      role:   u.role ?? "",
      level:  p.level ?? 1,
      totalXp,
      activeTitle: p.activeTitle ?? null,
      badgeCount:  (p.badges ?? []).length,
      recentBadges: (p.badges ?? []).slice(-3).map((b) => ({ id: b.id, name: b.name, rarity: b.rarity })),
      tlStats: {
        milestonesDelivered:  milestones,
        milestonesOnTime:     msOnTime,
        sprintsCompleted:     sprints,
        sprintsHighCompletion: spHighComp,
        reviewsApproved:      reviews,
        consecutiveOnTime:    consecutive,
        onTimeRate,
        sprintHighCompRate:   sprintRate,
      },
      deliveryScore,
      tieBreaker1,
      tieBreaker2,
      tieBreaker3,
    };
  });

  // Sort with tie-breakers
  scored.sort((a, b) => {
    if (b.deliveryScore !== a.deliveryScore) return b.deliveryScore - a.deliveryScore;
    if (b.tieBreaker1  !== a.tieBreaker1)   return b.tieBreaker1  - a.tieBreaker1;
    if (b.tieBreaker2  !== a.tieBreaker2)   return b.tieBreaker2  - a.tieBreaker2;
    if (b.tieBreaker3  !== a.tieBreaker3)   return b.tieBreaker3  - a.tieBreaker3;
    return b.totalXp - a.totalXp;
  });

  let rank = 0, prevScore = null;
  const ranked = scored.map((entry, i) => {
    if (entry.deliveryScore !== prevScore) rank = i + 1;
    prevScore = entry.deliveryScore;
    return { ...entry, rank, isUser: entry.userId === requestingUserId };
  });

  res.json({ leaderboard: ranked, total: ranked.length, tab });
}

// ── GET /api/teamlead/gamification/badges ─────────────────────────────────────
export async function getTLBadges(req, res) {
  const { id: userId } = req.user;
  const profile = await GamificationProfile.findOne({ userId }, "badges tlStats level totalXp").lean();
  const earned  = profile?.badges ?? [];
  const tlStats = profile?.tlStats ?? {};

  const earnedMap = Object.fromEntries(earned.map((b) => [b.id, b]));
  const rarityOrder = { legendary: 4, epic: 3, rare: 2, common: 1 };

  const catalog = TL_BADGE_DEFINITIONS.map((def) => {
    const e        = earnedMap[def.id];
    const isEarned = !!e;
    // Compute progress for unearned badges
    let progress = null;
    if (!isEarned) {
      const val  = badgeProgressValue(def.id, tlStats, profile);
      const tgt  = badgeProgressTarget(def.id);
      if (tgt != null) {
        progress = { current: val, target: tgt, pct: Math.min(100, Math.round((val / tgt) * 100)) };
      }
    }
    // state matches Manager Portal format: "unlocked" | "in_progress" | "locked"
    const state = isEarned ? "unlocked" : (progress ? "in_progress" : "locked");
    return {
      id:        def.id,
      name:      def.name,
      category:  def.category,
      rarity:    def.rarity,
      emoji:     def.emoji,
      desc:      def.desc,
      condition: def.desc,     // alias for UI hint
      state,
      earned:    isEarned,
      earnedAt:  e?.earnedAt ?? null,
      progress,
    };
  }).sort((a, b) => {
    const stateOrder = { unlocked: 0, in_progress: 1, locked: 2 };
    const sd = (stateOrder[a.state] ?? 3) - (stateOrder[b.state] ?? 3);
    if (sd !== 0) return sd;
    return (rarityOrder[b.rarity] ?? 0) - (rarityOrder[a.rarity] ?? 0);
  });

  // Rarity breakdown
  const rarityStats = { legendary: 0, epic: 0, rare: 0, common: 0 };
  earned.forEach((b) => { const r = b.rarity ?? "common"; if (rarityStats[r] != null) rarityStats[r]++; });

  // Stats matching Manager format
  const stats = {
    total:          earned.length,
    totalInCatalog: TL_BADGE_DEFINITIONS.length,
    delivery:       catalog.filter((b) => b.category === "delivery"   && b.state === "unlocked").length,
    leadership:     catalog.filter((b) => b.category === "leadership" && b.state === "unlocked").length,
    efficiency:     catalog.filter((b) => b.category === "efficiency" && b.state === "unlocked").length,
    special:        catalog.filter((b) => b.category === "special"    && b.state === "unlocked").length,
    inProgress:     catalog.filter((b) => b.state === "in_progress").length,
    rarity:         rarityStats,
    level:          profile?.level    ?? 1,
    totalXp:        profile?.totalXp  ?? 0,
  };

  res.json({ catalog, stats, rarityStats, totalEarned: earned.length, total: catalog.length });
}

// ── GET /api/teamlead/gamification/titles ─────────────────────────────────────
export async function getTLTitles(req, res) {
  const { id: userId } = req.user;
  const profile = await GamificationProfile.findOne({ userId }, "titles activeTitle tlStats totalXp level badges streaks").lean();
  const unlocked     = profile?.titles   ?? [];
  const activeTitle  = profile?.activeTitle ?? null;
  const unlockedMap  = Object.fromEntries(unlocked.map((t) => [t.id, t]));

  // Return titles in Manager-compatible format for UI consistency
  const titles = TL_TITLE_DEFINITIONS.map((def) => {
    const u        = unlockedMap[def.id];
    const isActive = activeTitle === def.id;
    return {
      id:         def.id,
      label:      def.name,          // Manager UI uses "label"
      name:       def.name,
      emoji:      def.emoji  ?? "🏷️",
      rarity:     def.rarity,
      category:   def.category ?? "leadership",
      desc:       def.desc    ?? "",
      isUnlocked: !!u,
      isActive,
      unlockedAt: u?.unlockedAt ?? null,
    };
  });

  // Stats block matching Manager TitlesPage format
  const stats = {
    level:         profile?.level     ?? 1,
    totalXp:       profile?.totalXp   ?? 0,
    streak:        profile?.streaks?.daily ?? 0,
    badgeCount:    (profile?.badges ?? []).length,
    unlockedCount: unlocked.length,
    totalCount:    TL_TITLE_DEFINITIONS.length,
  };

  res.json({ titles, activeTitle, stats, totalUnlocked: unlocked.length });
}

// ── PATCH /api/teamlead/gamification/titles/equip ─────────────────────────────
export async function equipTLTitle(req, res) {
  const { id: userId } = req.user;
  const { titleId }    = req.body ?? {};
  if (!titleId) return res.status(400).json({ error: "titleId is required." });

  const profile = await GamificationProfile.findOne({ userId }, "titles").lean();
  const owned   = (profile?.titles ?? []).map((t) => t.id);
  if (!owned.includes(titleId)) return res.status(403).json({ error: "Title not unlocked." });

  await GamificationProfile.updateOne({ userId }, { $set: { activeTitle: titleId } });
  res.json({ success: true, activeTitle: titleId });
}

// ── GET /api/teamlead/gamification/xp-events ─────────────────────────────────
export async function getTLXpEvents(req, res) {
  const { id: userId } = req.user;
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

  const events = await XpLog.find(
    { userId, source: { $regex: /^tl_/ } }
  ).sort({ createdAt: -1 }).limit(limit).lean();

  res.json({
    events: events.map((e) => ({
      id:        String(e._id),
      source:    e.source,
      label:     XP_SOURCE_LABEL[e.source] ?? e.source,
      amount:    e.amount,
      timestamp: e.createdAt,
    })),
  });
}

// ── GET /api/teamlead/gamification/timeline ───────────────────────────────────
// Achievement timeline: badges + titles + level-ups (last 50)
export async function getTLTimeline(req, res) {
  const { id: userId } = req.user;
  const profile = await GamificationProfile.findOne(
    { userId },
    "badges titles level"
  ).lean();

  const events = [];

  for (const b of profile?.badges ?? []) {
    const def = TL_BADGE_DEFINITIONS.find((d) => d.id === b.id);
    events.push({
      type:      "badge",
      id:        b.id,
      name:      b.name,
      rarity:    b.rarity,
      emoji:     def?.emoji ?? "🏅",
      category:  def?.category ?? "special",
      timestamp: b.earnedAt,
    });
  }

  for (const t of profile?.titles ?? []) {
    const def = TL_TITLE_DEFINITIONS.find((d) => d.id === t.id);
    events.push({
      type:      "title",
      id:        t.id,
      name:      t.name,
      rarity:    t.rarity,
      emoji:     "🏷️",
      timestamp: t.unlockedAt,
    });
  }

  // Recent XP milestone events
  const xpLogs = await XpLog.find(
    { userId, source: { $regex: /^tl_/ }, amount: { $gte: 100 } }
  ).sort({ createdAt: -1 }).limit(30).lean();

  for (const x of xpLogs) {
    events.push({
      type:      "xp",
      id:        String(x._id),
      name:      XP_SOURCE_LABEL[x.source] ?? x.source,
      amount:    x.amount,
      emoji:     "⚡",
      timestamp: x.createdAt,
    });
  }

  // Sort newest first, limit 50
  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({ events: events.slice(0, 50) });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const XP_SOURCE_LABEL = {
  tl_milestone_delivered:      "Milestone Delivered",
  tl_milestone_on_time:        "On-Time Milestone Bonus",
  tl_sprint_completed:         "Sprint Completed",
  tl_sprint_on_time:           "Sprint On-Time Bonus",
  tl_sprint_high_completion:   "High Completion Sprint",
  tl_sprint_perfect:           "Perfect Sprint",
  tl_review_efficiency:        "Review Efficiency",
  tl_team_stability:           "Team Stability",
  tl_delivery_consistency:     "Delivery Consistency",
};

function badgeProgressValue(id, tlStats) {
  const s = tlStats ?? {};
  const map = {
    deadline_guardian:    s.milestonesOnTime      ?? 0,
    sprint_closer:        s.sprintsCompleted      ?? 0,
    milestone_master:     s.milestonesDelivered   ?? 0,
    delivery_commander:   s.consecutiveOnTime     ?? 0,
    iron_scheduler:       s.milestonesOnTime      ?? 0,
    team_stabilizer:      s.reviewsApproved       ?? 0,
    workflow_architect:   s.sprintsCompleted      ?? 0,
    crisis_controller:    s.sprintsHighCompletion ?? 0,
    operations_captain:   Math.min(s.milestonesDelivered ?? 0, s.sprintsCompleted ?? 0),
    zero_delay_lead:      s.consecutiveOnTime     ?? 0,
    fast_reviewer:        s.reviewsApproved       ?? 0,
    clean_executor:       s.perfectSprints        ?? 0,
    precision_planner:    s.sprintsHighCompletion ?? 0,
    review_ace:           s.reviewsApproved       ?? 0,
    legendary_lead:       s.milestonesDelivered   ?? 0,
    elite_commander:      s.sprintsCompleted      ?? 0,
    execution_titan:      s.reviewsApproved       ?? 0,
    peak_strategist:      s.consecutiveOnTime     ?? 0,
    sprint_maestro:       s.perfectSprints        ?? 0,
  };
  return map[id] ?? 0;
}

function badgeProgressTarget(id) {
  const targets = {
    deadline_guardian: 1,    sprint_closer: 1,
    milestone_master: 10,    delivery_commander: 5,
    iron_scheduler: 5,       team_stabilizer: 1,
    workflow_architect: 5,   crisis_controller: 10,
    operations_captain: 10,  zero_delay_lead: 3,
    fast_reviewer: 10,       clean_executor: 1,
    precision_planner: 10,   review_ace: 50,
    legendary_lead: 50,      elite_commander: 25,
    execution_titan: 100,    peak_strategist: 10,
    sprint_maestro: 3,
  };
  return targets[id] ?? null;
}
