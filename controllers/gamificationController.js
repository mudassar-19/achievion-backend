import { isReadOnly } from "../middleware/viewAs.js";
import { avatarLockError } from "../services/accessRules.js";
import GamificationProfile from "../models/GamificationProfile.js";
import User from "../models/User.js";
import XpLog from "../models/XpLog.js";
import Project from "../models/Project.js";
import Task from "../models/Task.js";
import { orgScope } from "./managerProjectsController.js";
import { isRankable, rankRows, rankChange, scopesFor, MIN_PEOPLE } from "../services/leaderboardRules.js";

// ── Static badge catalog ──────────────────────────────────────────────────────
// `progressType` drives the server-side progress engine (see computeBadgeProgress).
// `target`        is the threshold value for completion.
// The `name` field must match strings stored in GamificationProfile.badges[].name.
export const BADGE_CATALOG = [
  // ── STREAK ──────────────────────────────────────────────────────────────────
  {
    name: "Consistency Starter", category: "streak", rarity: "common",    emoji: "✨",
    desc: "Start building your daily habit",
    condition: "Maintain a 5-day activity streak",
    progressType: "streak", target: 5,
  },
  {
    name: "On Fire",             category: "streak", rarity: "rare",      emoji: "🔥",
    desc: "You're on a hot streak — keep it burning",
    condition: "Maintain a 7-day activity streak",
    progressType: "streak", target: 7,
  },
  {
    name: "Unstoppable",         category: "streak", rarity: "epic",      emoji: "⚡",
    desc: "30 days of unbroken consistency",
    condition: "Maintain a 30-day activity streak",
    progressType: "streak", target: 30,
  },
  {
    name: "Legendary Run",       category: "streak", rarity: "legendary", emoji: "👑",
    desc: "100 days — an achievement very few reach",
    condition: "Maintain a 100-day activity streak",
    progressType: "streak", target: 100,
  },

  // ── TASKS ────────────────────────────────────────────────────────────────────
  {
    name: "First Quest",         category: "tasks",  rarity: "common",    emoji: "✅",
    desc: "Every legend starts with one task",
    condition: "Complete your first task",
    progressType: "tasks", target: 1,
  },
  {
    name: "Task Slayer",         category: "tasks",  rarity: "common",    emoji: "⚔️",
    desc: "You're cutting through the backlog",
    condition: "Complete 10 tasks",
    progressType: "tasks", target: 10,
  },
  {
    name: "Task Master",         category: "tasks",  rarity: "rare",      emoji: "🗡️",
    desc: "50 tasks — serious, consistent output",
    condition: "Complete 50 tasks",
    progressType: "tasks", target: 50,
  },
  {
    name: "Century Club",        category: "tasks",  rarity: "epic",      emoji: "💯",
    desc: "100 tasks completed — you're a machine",
    condition: "Complete 100 tasks",
    progressType: "tasks", target: 100,
  },
  {
    name: "Punctual",            category: "tasks",  rarity: "rare",      emoji: "⏱️",
    desc: "Deadlines don't scare you",
    condition: "Complete 10 tasks on time",
    progressType: "onTime", target: 10,
  },
  {
    name: "Delivery Master",     category: "tasks",  rarity: "epic",      emoji: "📦",
    desc: "Consistent on-time delivery is your brand",
    condition: "Complete 30 tasks on time",
    progressType: "onTime", target: 30,
  },

  // ── XP ───────────────────────────────────────────────────────────────────────
  {
    name: "XP Rookie",           category: "xp",     rarity: "common",    emoji: "⭐",
    desc: "Your XP journey begins here",
    condition: "Earn 1,000 total XP",
    progressType: "xp", target: 1000,
  },
  {
    name: "XP Hunter",           category: "xp",     rarity: "rare",      emoji: "🌟",
    desc: "Accumulating power at scale",
    condition: "Earn 5,000 total XP",
    progressType: "xp", target: 5000,
  },
  {
    name: "10x Pioneer",         category: "xp",     rarity: "epic",      emoji: "💎",
    desc: "10,000 XP — elite territory",
    condition: "Earn 10,000 total XP",
    progressType: "xp", target: 10000,
  },
  {
    name: "XP Legend",           category: "xp",     rarity: "legendary", emoji: "🏅",
    desc: "50,000 XP — the rarest milestone",
    condition: "Earn 50,000 total XP",
    progressType: "xp", target: 50000,
  },
  {
    name: "Level Up!",           category: "xp",     rarity: "common",    emoji: "🎯",
    desc: "Progress is visible and accelerating",
    condition: "Reach Level 5",
    progressType: "level", target: 5,
  },
  {
    name: "Mid-Tier",            category: "xp",     rarity: "rare",      emoji: "🏆",
    desc: "You've earned your stripes at Level 10",
    condition: "Reach Level 10",
    progressType: "level", target: 10,
  },
  {
    name: "Elite",               category: "xp",     rarity: "epic",      emoji: "🔮",
    desc: "Level 20 — top-tier performer",
    condition: "Reach Level 20",
    progressType: "level", target: 20,
  },

  // ── SPECIAL ──────────────────────────────────────────────────────────────────
  {
    name: "Early Adopter",       category: "special", rarity: "epic",      emoji: "🚀",
    desc: "Among the first to join the platform",
    condition: "Founding member milestone — system awarded",
    progressType: "special", target: null,
  },
  {
    name: "Perfectionist",       category: "special", rarity: "legendary", emoji: "💪",
    desc: "Zero misses across an entire sprint — near impossible",
    condition: "All tasks on time in a single sprint",
    progressType: "special", target: null,
  },
  {
    name: "Code Reviewer",       category: "special", rarity: "common",    emoji: "🔍",
    desc: "You give back by reviewing others' work",
    condition: "Review your first submission",
    progressType: "reviews", target: 1,
  },
  {
    name: "Mentor",              category: "special", rarity: "rare",      emoji: "🤝",
    desc: "Leadership through knowledge sharing",
    condition: "Mentor a junior team member",
    progressType: "special", target: null,
  },
  {
    name: "Silent Killer",       category: "special", rarity: "epic",      emoji: "🎯",
    desc: "High output, zero noise — peak efficiency",
    condition: "Complete 20 tasks with 0 late submissions",
    progressType: "efficiency", target: 20,
  },
];

// ── GET /api/gamification/profile ────────────────────────────────────────────
export async function getProfile(req, res) {
  const { id: userId, orgId } = req.user;
  let profile = await GamificationProfile.findOne({ userId }).lean();

  // Auto-create profile on first access
  if (!profile) {
    // View as (D-109): show the defaults, do not create the profile.
    profile = isReadOnly() ? new GamificationProfile({ userId, orgId }).toObject() : await GamificationProfile.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, orgId } },
      { upsert: true, returnDocument: "after", lean: true, setDefaultsOnInsert: true }
    );
  }

  res.json({
    success: true,
    data: {
      level:     profile.level ?? 1,
      currentXp: profile.currentXp ?? 0,
      maxXp:     profile.maxXp ?? 100,
      totalXp:   profile.totalXp ?? 0,
      gold:      profile.gold ?? 0,
      hp:        profile.hp ?? 100,
      streak:    profile.streaks?.daily ?? 0,
      badges:    profile.badges ?? [],
      titles:    profile.titles ?? [],
    },
  });
}

// ── GET /api/gamification/leaderboard ─────────────────────────────────────────
// Query params:
//   scope     = org | team   (default: org)
//   timeRange = overall | monthly | weekly  (default: overall)
//
// Weighted performance score:
//   50% normalised total XP   (within current scope)
//   25% on-time completion rate
//   15% normalised daily streak   (30 days = 100)
//   10% badge boost (rarity-weighted, capped 100)
//
// Tie-breaker order: performanceScore → completionRate → streak → totalXp
export async function getLeaderboard(req, res) {
  // U-1 (D-133): one leaderboard for every portal (UC-13, FR05-05). Only XP roles are ranked, never Managers/Directors.
  const { id: userId, orgId, role } = req.user;
  const scopes = scopesFor(role);
  const asked  = req.query.scope === "org" ? "company" : req.query.scope;
  const scope  = scopes.includes(asked) ? asked : scopes[0];
  const period = { weekly: "week", monthly: "month", overall: "all" }[req.query.timeRange] ?? (["week", "month", "all"].includes(req.query.period) ? req.query.period : "all");

  // Projects this viewer may pick in "Project" scope (and whose people form their "Team").
  const pScope = await orgScope(orgId);
  if (!pScope) return res.status(404).json({ error: "Organization not found." });
  const pFilter = { ...pScope.filter, isDeleted: { $ne: true }, status: { $nin: ["Deleted", "Archived"] } };
  if (role === "Manager") pFilter.managerId = userId;
  else if (role !== "Director") pFilter.members = userId;
  const projects = await Project.find(pFilter, "_id title members").sort({ title: 1 }).lean();

  let people = null; // null = whole org
  let project = null;
  if (scope === "team") people = new Set(projects.flatMap((p) => (p.members ?? []).map(String)));
  if (scope === "project") {
    project = projects.find((p) => String(p._id) === String(req.query.projectId)) ?? projects[0] ?? null;
    people = new Set((project?.members ?? []).map(String));
  }

  const userFilter = { orgId, status: { $ne: "deleted" } };
  if (people) userFilter._id = { $in: [...people] };
  const users = (await User.find(userFilter, "_id name role avatarSeed").lean()).filter((u) => isRankable(u.role));
  const userIds = users.map((u) => u._id);
  const profiles = new Map((await GamificationProfile.find({ userId: { $in: userIds } }, "userId level totalXp monthlyXp streaks stats").lean()).map((p) => [String(p.userId), p]));

  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const since = period === "week" ? weekAgo : period === "month" ? monthStart : null;
  const [weekXp, doneAgg] = await Promise.all([
    XpLog.aggregate([{ $match: { userId: { $in: userIds }, createdAt: { $gte: weekAgo }, amount: { $gt: 0 } } }, { $group: { _id: "$userId", xp: { $sum: "$amount" } } }]),
    since ? Task.aggregate([
      { $match: { assignees: { $in: userIds }, status: "Done", completedAt: { $gte: since } } }, { $unwind: "$assignees" }, { $match: { assignees: { $in: userIds } } },
      { $group: { _id: "$assignees", done: { $sum: 1 }, judged: { $sum: { $cond: [{ $ifNull: ["$deadline", false] }, 1, 0] } },
        onTime: { $sum: { $cond: [{ $and: [{ $ifNull: ["$deadline", false] }, { $lte: ["$completedAt", "$deadline"] }] }, 1, 0] } } } },
    ]) : [],
  ]);
  const wk = new Map(weekXp.map((r) => [String(r._id), r.xp]));
  const done = new Map(doneAgg.map((r) => [String(r._id), r]));

  const rows = users.map((u) => {
    const uid = String(u._id), p = profiles.get(uid) ?? {};
    const totalXp = p.totalXp ?? 0, weeklyXp = wk.get(uid) ?? 0, monthlyXp = p.monthlyXp ?? 0;
    const xp = period === "week" ? weeklyXp : period === "month" ? monthlyXp : totalXp;
    const d = done.get(uid);
    const tasksCompleted = since ? (d?.done ?? 0) : (p.stats?.tasksCompleted ?? 0);
    const onTimePct = since ? (d?.judged ? Math.round((d.onTime / d.judged) * 100) : null)
      : (p.stats?.tasksCompleted ? Math.round(((p.stats?.onTimeDeliveries ?? 0) / p.stats.tasksCompleted) * 100) : null);
    return { userId: uid, name: u.name ?? "—", role: u.role ?? "", avatarSeed: u.avatarSeed ?? null, level: p.level ?? 1,
      xp, rankXp: xp, totalXp, monthlyXp, weeklyXp, tasksCompleted, onTimePct, completionRate: onTimePct ?? 0,
      streak: p.streaks?.daily ?? 0, isUser: uid === String(userId) };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const ranked = rankRows(rows, (r) => r.xp);
  // Rank change (all-time only): rank 7 days ago = rank by XP without this week's XP.
  if (period === "all") {
    const before = new Map(rankRows(rows, (r) => r.totalXp - r.weeklyXp).map((r) => [r.userId, r.rank]));
    for (const r of ranked) r.change = rankChange(before.get(r.userId), r.rank);
  }
  const avgXp = ranked.length ? Math.round(ranked.reduce((s, r) => s + r.xp, 0) / ranked.length) : 0;
  const top = ranked[0] && ranked[0].xp > 0 ? ranked[0] : null;
  res.json({
    success: true, rows: ranked, total: ranked.length, enough: ranked.length >= MIN_PEOPLE,
    scope, period, scopes, project: project ? { id: project._id, title: project.title } : null,
    projects: projects.map((p) => ({ id: p._id, title: p.title })),
    meta: { avgXp, activeContributors: ranked.filter((r) => r.weeklyXp > 0).length,
      topPerformer: top ? { name: top.name, xp: top.xp, role: top.role, userId: top.userId } : null },
  });
}

// ── Badge progress engine ─────────────────────────────────────────────────────
// Derives trackable progress from a GamificationProfile for a single badge.
// Returns null for special/non-trackable badge types.
function computeBadgeProgress(badge, profile) {
  if (!badge.progressType || badge.progressType === "special" || !badge.target) return null;
  const stats = profile.stats ?? {};
  let current = 0;

  switch (badge.progressType) {
    case "xp":         current = profile.totalXp         ?? 0; break;
    case "tasks":      current = stats.tasksCompleted     ?? 0; break;
    case "streak":     current = profile.streaks?.daily   ?? 0; break;
    case "onTime":     current = stats.onTimeDeliveries   ?? 0; break;
    case "level":      current = profile.level            ?? 1; break;
    case "reviews":    current = stats.reviewsGiven       ?? 0; break;
    case "efficiency":
      // Only counts if the user has zero late submissions
      current = (stats.lateSubmissions ?? 0) === 0 ? (stats.tasksCompleted ?? 0) : 0;
      break;
    default: return null;
  }

  const pct = Math.min(100, Math.round((current / badge.target) * 100));
  return { current, target: badge.target, pct };
}

// ── GET /api/gamification/badges ──────────────────────────────────────────────
// Returns the full badge catalog enriched with earned status, earnedAt date,
// badge state (locked | in_progress | unlocked), and live progress data.
export async function getBadges(req, res) {
  const { id: userId } = req.user;
  const profile = await GamificationProfile.findOne(
    { userId },
    "badges totalXp level streaks stats"
  ).lean();

  const earned    = profile?.badges ?? [];
  const earnedMap = Object.fromEntries(earned.map((b) => [b.name, b]));

  // Rarity breakdown for earned badges
  const rarityStats = { legendary: 0, epic: 0, rare: 0, common: 0 };
  earned.forEach((b) => {
    const cat = BADGE_CATALOG.find((c) => c.name === b.name);
    const r   = cat?.rarity ?? b.rarity ?? "common";
    if (rarityStats[r] !== undefined) rarityStats[r]++;
  });

  // Enrich each catalog entry with state + progress
  const catalog = BADGE_CATALOG.map((b) => {
    const earnedEntry = earnedMap[b.name];
    const isEarned    = !!earnedEntry;
    let state         = "locked";
    let progress      = null;

    if (isEarned) {
      state = "unlocked";
    } else if (profile) {
      progress = computeBadgeProgress(b, profile);
      if (progress && progress.pct > 0) state = "in_progress";
    }

    return {
      ...b,
      earned:   isEarned,
      earnedAt: earnedEntry?.earnedAt ?? null,
      state,
      progress,
    };
  });

  // Category counts for earned badges
  const catCount = (cat) =>
    earned.filter((b) => {
      const c = BADGE_CATALOG.find((x) => x.name === b.name);
      return c?.category === cat;
    }).length;

  const stats = {
    total:         earned.length,
    totalInCatalog: BADGE_CATALOG.length,
    inProgress:    catalog.filter((b) => b.state === "in_progress").length,
    streak:        catCount("streak"),
    tasks:         catCount("tasks"),
    xp:            catCount("xp"),
    special:       catCount("special"),
    rarity:        rarityStats,
  };

  res.json({ success: true, catalog, stats });
}

// ── GET /api/gamification/avatar ──────────────────────────────────────────────
export async function getAvatar(req, res) {
  try {
    let profile = await GamificationProfile.findOne({ userId: req.user.id }).lean();

    // Auto-create profile on first access
    if (!profile) {
      // View as (D-109): show the defaults, do not create the profile.
      profile = isReadOnly() ? new GamificationProfile({ userId: req.user.id, orgId: req.user.orgId }).toObject() : await GamificationProfile.findOneAndUpdate(
        { userId: req.user.id },
        { $setOnInsert: { userId: req.user.id, orgId: req.user.orgId } },
        { upsert: true, returnDocument: "after", lean: true, setDefaultsOnInsert: true }
      );
    }

    const cfg = profile.avatarConfig ?? {};
    return res.json({
      config: {
        style:           cfg.style           ?? "bottts",
        seed:            cfg.seed            ?? req.user.name ?? "Hero",
        background:      cfg.background      ?? "none",
        visualStyle:     cfg.visualStyle     ?? "minimal",
        preset:          cfg.preset          ?? null,
        effects:         cfg.effects         ?? [],
        themeAccentSync: cfg.themeAccentSync ?? false,
        lastUpdated:     cfg.lastUpdated     ?? null,
      },
      unlock: {
        level:  profile.level ?? 1,
        badges: (profile.badges ?? []).map((b) => b.id ?? b.name),
        streak: profile.streaks?.daily ?? 0,
      },
    });
  } catch (err) {
    console.error("getAvatar:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

// ── PUT /api/gamification/avatar ──────────────────────────────────────────────
const VALID_STYLES     = ["bottts","pixel-art","fun-emoji","identicon","shapes","adventurer","lorelei","thumbs","micah","avataaars","miniavs","notionists","croodles","open-peeps"];
const VALID_VS         = ["minimal","corporate","futuristic","gamer","shadow","neon"];
const VALID_PRESETS    = ["warrior","shadow","titan","nova","ghost","eclipse","zen","hacker",null];
const VALID_EFFECTS    = ["glow","pulse","aura","particle"];
const VALID_BACKGROUNDS= ["none","sky","lavender","peach","midnight","navy","abyss","dark-neon","corp-blue","gamer-red","cyber-purple","emerald","solar"];

export async function saveAvatar(req, res) {
  try {
    const { style, seed, background, visualStyle, preset, effects, themeAccentSync } = req.body;

    if (style       && !VALID_STYLES.includes(style))                            return res.status(400).json({ error: "Invalid style" });
    if (visualStyle && !VALID_VS.includes(visualStyle))                          return res.status(400).json({ error: "Invalid visual style" });
    if (preset      !== undefined && !VALID_PRESETS.includes(preset))            return res.status(400).json({ error: "Invalid preset" });
    if (background  && !VALID_BACKGROUNDS.includes(background))                  return res.status(400).json({ error: "Invalid background" });
    if (effects     && (!Array.isArray(effects) || effects.some((e) => !VALID_EFFECTS.includes(e)))) return res.status(400).json({ error: "Invalid effects" });

    // S9 (D-167): locked looks are refused here too, not only greyed out on the page.
    const p = await GamificationProfile.findOne({ userId: req.user.id }, "level badges streaks").lean();
    const locked = avatarLockError({ style, visualStyle, preset, effects }, { level: p?.level ?? 1, streak: p?.streaks?.daily ?? 0, badges: (p?.badges ?? []).map((b) => b.id ?? b.name) });
    if (locked) return res.status(403).json({ error: locked });

    const update = {
      "avatarConfig.style":           style           ?? "bottts",
      "avatarConfig.seed":            ((seed ?? "").trim() || (req.user.name ?? "Hero")),
      "avatarConfig.background":      background      ?? "none",
      "avatarConfig.visualStyle":     visualStyle     ?? "minimal",
      "avatarConfig.preset":          preset          ?? null,
      "avatarConfig.effects":         effects         ?? [],
      "avatarConfig.themeAccentSync": themeAccentSync ?? false,
      "avatarConfig.lastUpdated":     new Date(),
      avatarStyle: style ?? "bottts",
      avatarSeed:  ((seed ?? "").trim() || (req.user.name ?? "Hero")),
    };

    const profile = await GamificationProfile.findOneAndUpdate(
      { userId: req.user.id },
      { $set: update, $setOnInsert: { userId: req.user.id, orgId: req.user.orgId } },
      { upsert: true, returnDocument: "after", lean: true, setDefaultsOnInsert: true }
    );

    return res.json({ success: true, config: profile.avatarConfig });
  } catch (err) {
    console.error("saveAvatar:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

// ── Title catalog ─────────────────────────────────────────────────────────────
export const TITLE_CATALOG = [
  // ── GLOBAL ──────────────────────────────────────────────────────────────────
  { id: "newcomer",    label: "New Comer",          emoji: "🌱", rarity: "common",    category: "global",      desc: "Every legend starts somewhere.",                    unlock: { type: "always"  } },
  { id: "rising",      label: "Rising Star",         emoji: "⭐", rarity: "common",    category: "global",      desc: "Reach Level 3 to claim your place.",                unlock: { type: "level",  value: 3  } },
  { id: "apprentice",  label: "Apprentice",          emoji: "📚", rarity: "common",    category: "global",      desc: "Proven at Level 5. The journey begins.",            unlock: { type: "level",  value: 5  } },
  { id: "expert",      label: "Expert",              emoji: "💡", rarity: "rare",      category: "global",      desc: "Reach Level 10 — you know your craft.",             unlock: { type: "level",  value: 10 } },
  { id: "master",      label: "Master",              emoji: "🔮", rarity: "epic",      category: "global",      desc: "Level 20 — elite performer.",                       unlock: { type: "level",  value: 20 } },
  { id: "grandmaster", label: "Grand Master",        emoji: "👑", rarity: "legendary", category: "global",      desc: "Level 30 — top of the hierarchy.",                  unlock: { type: "level",  value: 30 } },

  // ── PROGRESSION — XP ─────────────────────────────────────────────────────────
  { id: "xp_hunter",   label: "XP Hunter",           emoji: "🌟", rarity: "rare",      category: "progression", desc: "Earn 10,000 total XP.",                             unlock: { type: "xp",    value: 10000 } },
  { id: "xp_legend",   label: "XP Legend",           emoji: "💎", rarity: "legendary", category: "progression", desc: "Earn 25,000 total XP — extraordinary grind.",       unlock: { type: "xp",    value: 25000 } },

  // ── PROGRESSION — STREAK ──────────────────────────────────────────────────────
  { id: "on_fire",     label: "On Fire",             emoji: "🔥", rarity: "rare",      category: "progression", desc: "Maintain a 7-day activity streak.",                  unlock: { type: "streak", value: 7   } },
  { id: "unstoppable", label: "Unstoppable",         emoji: "⚡", rarity: "epic",      category: "progression", desc: "Maintain a 30-day streak without breaking.",         unlock: { type: "streak", value: 30  } },
  { id: "the_legend",  label: "The Legend",          emoji: "🏆", rarity: "legendary", category: "progression", desc: "100-day streak — a feat few will ever achieve.",     unlock: { type: "streak", value: 100 } },

  // ── ROLE — DEVELOPER ─────────────────────────────────────────────────────────
  { id: "code_starter",   label: "Code Starter",     emoji: "💻", rarity: "common",    category: "role",        desc: "Complete 5 developer tasks.",                       unlock: { type: "role",   value: ["Developer","Senior Developer"] } },
  { id: "bug_slayer",     label: "Bug Slayer",        emoji: "🐛", rarity: "rare",      category: "role",        desc: "Fix 20 bugs. Silence the noise.",                   unlock: { type: "role",   value: ["Developer","Senior Developer"] } },
  { id: "api_architect",  label: "API Architect",     emoji: "⚙️", rarity: "epic",      category: "role",        desc: "Build and integrate 10 APIs.",                      unlock: { type: "role",   value: ["Developer","Senior Developer"] } },
  { id: "deploy_master",  label: "Deployment Master", emoji: "🚀", rarity: "legendary", category: "role",        desc: "5 successful deployments shipped.",                  unlock: { type: "role",   value: ["Developer","Senior Developer"] } },

  // ── ROLE — DESIGNER ──────────────────────────────────────────────────────────
  { id: "pixel_artist",   label: "Pixel Artist",      emoji: "🎨", rarity: "rare",      category: "role",        desc: "10 UI designs approved by stakeholders.",            unlock: { type: "role",   value: ["Designer","Senior Designer"] } },
  { id: "creative_flow",  label: "Creative Flow",     emoji: "✨", rarity: "epic",      category: "role",        desc: "Maintain a 7-day design streak.",                   unlock: { type: "role",   value: ["Designer","Senior Designer"] } },

  // ── ROLE — TESTER ────────────────────────────────────────────────────────────
  { id: "qa_hunter",     label: "QA Hunter",          emoji: "🔍", rarity: "rare",      category: "role",        desc: "Find 30 bugs before they reach production.",         unlock: { type: "role",   value: ["Tester","Senior Tester"] } },
  { id: "quality_guard", label: "Quality Guard",      emoji: "🛡️", rarity: "epic",      category: "role",        desc: "Zero critical misses across 3 full projects.",       unlock: { type: "role",   value: ["Tester","Senior Tester"] } },

  // ── ROLE — MANAGER ───────────────────────────────────────────────────────────
  { id: "project_cmd",   label: "Project Commander",  emoji: "📋", rarity: "rare",      category: "role",        desc: "Manage 5 projects to completion.",                   unlock: { type: "role",   value: ["Manager"] } },
  { id: "exec_leader",   label: "Execution Leader",   emoji: "📊", rarity: "epic",      category: "role",        desc: "90%+ delivery success rate across projects.",        unlock: { type: "role",   value: ["Manager"] } },

  // ── ROLE — TEAM LEAD ─────────────────────────────────────────────────────────
  { id: "team_anchor",   label: "Team Anchor",        emoji: "⚓", rarity: "rare",      category: "role",        desc: "Lead and support 3 full teams.",                     unlock: { type: "role",   value: ["Team Lead"] } },
  { id: "conflict_res",  label: "Conflict Resolver",  emoji: "🤝", rarity: "epic",      category: "role",        desc: "Mediate and resolve 10 team conflicts.",             unlock: { type: "role",   value: ["Team Lead"] } },

  // ── SPECIAL ──────────────────────────────────────────────────────────────────
  { id: "silent_killer", label: "Silent Killer",      emoji: "🎯", rarity: "epic",      category: "special",     desc: "High output with zero errors — peak efficiency.",    unlock: { type: "badge",  value: "Silent Killer" } },
  { id: "speed_runner",  label: "Speed Runner",       emoji: "⚡", rarity: "epic",      category: "special",     desc: "Fastest task completion streak on record.",          unlock: { type: "badge",  value: "speed_demon"   } },
  { id: "legend_mode",   label: "Legend Mode",        emoji: "🌌", rarity: "legendary", category: "special",     desc: "Top 1% ranking — you are in a class of your own.",  unlock: { type: "level",  value: 30              } },
];

// ── Helper: compute whether a title is unlocked for a given profile ───────────
function computeTitleUnlocked(title, profile, user) {
  const { type, value } = title.unlock;
  if (type === "always") return true;
  if (type === "level")  return (profile.level ?? 1) >= value;
  if (type === "xp")     return (profile.totalXp ?? 0) >= value;
  if (type === "streak") return (profile.streaks?.daily ?? 0) >= value;
  if (type === "badge")  return (profile.badges ?? []).some((b) => b.id === value || b.name === value);
  if (type === "role") {
    const role = user?.role ?? "";
    return Array.isArray(value)
      ? value.some((r) => role === r || role.toLowerCase().includes(r.toLowerCase()))
      : role === value || role.toLowerCase().includes(value.toLowerCase());
  }
  return false;
}

// ── GET /api/gamification/titles ─────────────────────────────────────────────
export async function getTitles(req, res) {
  try {
    const { id: userId, orgId } = req.user;
    let [profile, user] = await Promise.all([
      GamificationProfile.findOne({ userId }).lean(),
      User.findById(userId).select("name role level currentXp").lean(),
    ]);

    // Auto-create profile on first access
    if (!profile) {
      // View as (D-109): show the defaults, do not create the profile.
      profile = isReadOnly() ? new GamificationProfile({ userId: userId, orgId: orgId }).toObject() : await GamificationProfile.findOneAndUpdate(
        { userId },
        { $setOnInsert: { userId, orgId } },
        { upsert: true, returnDocument: "after", lean: true, setDefaultsOnInsert: true }
      );
    }

    const activeTitle = profile.activeTitle ?? "newcomer";

    const titles = TITLE_CATALOG.map((title) => ({
      ...title,
      isUnlocked: computeTitleUnlocked(title, profile, user),
      isActive:   title.id === activeTitle,
    }));

    return res.json({
      success: true,
      activeTitle,
      titles,
      stats: {
        level:     profile.level ?? 1,
        totalXp:   profile.totalXp ?? 0,
        streak:    profile.streaks?.daily ?? 0,
        badgeCount: (profile.badges ?? []).length,
        unlockedCount: titles.filter((t) => t.isUnlocked).length,
        totalCount:    titles.length,
      },
    });
  } catch (err) {
    console.error("getTitles:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

// ── PUT /api/gamification/titles/equip ───────────────────────────────────────
export async function equipTitle(req, res) {
  try {
    const { id: userId } = req.user;
    const { titleId } = req.body;

    const titleDef = TITLE_CATALOG.find((t) => t.id === titleId);
    if (!titleDef) return res.status(400).json({ error: "Unknown title" });

    const [profile, user] = await Promise.all([
      GamificationProfile.findOne({ userId }).lean(),
      User.findById(userId).select("role").lean(),
    ]);
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    if (!computeTitleUnlocked(titleDef, profile, user)) {
      return res.status(403).json({ error: "Title not yet unlocked" });
    }

    // Ensure the title is recorded in the profile.titles array
    const alreadyOwned = (profile.titles ?? []).some((t) => t.id === titleId);
    const titlesUpdate = alreadyOwned ? {} : {
      $addToSet: { titles: { id: titleId, name: titleDef.label, rarity: titleDef.rarity, unlockedAt: new Date() } },
    };

    await GamificationProfile.findOneAndUpdate(
      { userId },
      { $set: { activeTitle: titleId }, ...titlesUpdate },
      { returnDocument: "after" }
    );

    return res.json({ success: true, activeTitle: titleId });
  } catch (err) {
    console.error("equipTitle:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
