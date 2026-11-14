import bcrypt from "bcryptjs";
import { selfUpdateError } from "../services/accessRules.js";
import { sanitizePrefs, validatePreferences } from "../services/notificationPrefs.js";
import crypto from "node:crypto";
import { sendResetCode, isMailConfigured } from "../utils/mailer.js";
import { canIssueCode, verifyResetCode, hashResetCode, RESET_TTL_MS, MAX_ATTEMPTS, LOCK_MS } from "../services/passwordReset.js";
import jwt    from "jsonwebtoken";
import User, { ROLE_CATEGORY_MAP, VALID_ROLES } from "../models/User.js";
import Organization       from "../models/Organization.js";
import GamificationProfile from "../models/GamificationProfile.js";
import Task               from "../models/Task.js";
import XpLog              from "../models/XpLog.js";
import Project            from "../models/Project.js";
import Approval           from "../models/Approval.js";
import AuditLog           from "../models/AuditLog.js";
import Session            from "../models/Session.js";
import { levelFromTotalXp } from "../services/xpEngine.js";

const SALT_ROUNDS  = 12;
const PASSWORD_MIN = 8;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Sign a JWT containing identity + role + roleCategory. */
function signToken(user) {
  return jwt.sign(
    {
      id:           user._id.toString(),
      email:        user.email,
      role:         user.role,
      roleCategory: user.roleCategory ?? ROLE_CATEGORY_MAP[user.role] ?? "developer",
      name:         user.name,
      orgId:        user.orgId ?? null,
      tokenVersion: user.tokenVersion ?? 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN ?? "7d" }
  );
}

// XP, level, gold and HP have one source: GamificationProfile (the User copies are stale).
// Level/progress come from totalXp with the engine curve (D-058).
const gamiOf = (userId) => GamificationProfile.findOne({ userId }, "totalXp gold hp").lean();
function gamiFields(gp) {
  const { level, currentXp, maxXp } = levelFromTotalXp(gp?.totalXp ?? 0);
  return { level, currentXp, maxXp, totalXp: gp?.totalXp ?? 0, gold: gp?.gold ?? 0, hp: gp?.hp ?? 100 };
}

/** Strip sensitive fields before sending a user object to the client. */
function sanitize(user, orgName = null, gp = null) {
  return {
    id:           user._id.toString(),
    name:         user.name,
    email:        user.email,
    role:         user.role,
    roleLabel:    user.roleLabel ?? null,
    roleCategory: user.roleCategory ?? ROLE_CATEGORY_MAP[user.role] ?? "developer",
    orgId:        user.orgId ?? null,
    orgName:      orgName ?? null,
    department:   user.department ?? null,
    ...gamiFields(gp),
    createdAt:    user.createdAt,
    settings:     user.settings ?? null,
  };
}

function clientError(res, status, message) {
  return res.status(status).json({ error: message });
}

// ── POST /api/auth/register ────────────────────────────────────────────────────
// Legacy direct-register (no org). Kept for dev/demo; employees should use
// POST /api/auth/register-employee instead.
export async function register(req, res) {
  const { name, email, password, role } = req.body ?? {};

  if (!name?.trim() || !email?.trim() || !password || !role) {
    return clientError(res, 400, "name, email, password, and role are all required.");
  }

  if (!VALID_ROLES.includes(role)) {
    return clientError(res, 400, `role must be one of: ${VALID_ROLES.join(", ")}.`);
  }

  if (password.length < PASSWORD_MIN) {
    return clientError(res, 400, `Password must be at least ${PASSWORD_MIN} characters.`);
  }

  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    return clientError(res, 409, "An account with this email already exists.");
  }

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await User.create({
    name:     name.trim(),
    email:    email.toLowerCase().trim(),
    password: hash,
    role,
  });

  const token = signToken(user);
  return res.status(201).json({ token, user: sanitize(user) });
}

// ── POST /api/auth/login ───────────────────────────────────────────────────────
// Employee login via email + password + orgCode.
// orgCode identifies which org the user belongs to, allowing the same email
// to exist across multiple orgs.
export async function login(req, res) {
  const { email, password, orgCode } = req.body ?? {};

  if (!email?.trim() || !password) {
    return clientError(res, 400, "Email and password are required.");
  }
  if (!orgCode?.trim()) {
    return clientError(res, 400, "Organization code is required.");
  }

  const org = await Organization.findOne({
    orgCode: orgCode.trim().toUpperCase(),
  });
  if (!org) {
    return clientError(res, 401, "Invalid organization code.");
  }

  // Support both ObjectId and legacy string orgId on User
  const user = await User.findOne({
    email: email.toLowerCase().trim(),
    $or: [{ orgId: org._id.toString() }, { orgId: org.orgId ?? "__none__" }],
  }).select("+password");

  if (!user) return clientError(res, 401, "Invalid email or password.");

  const match = await bcrypt.compare(password, user.password);
  if (!match) return clientError(res, 401, "Invalid email or password.");

  if (user.status === "suspended") {
    return clientError(res, 403, "Account suspended. Contact your administrator.");
  }
  if (user.status === "under_review") {
    return clientError(res, 403, "Account pending Director approval.");
  }
  if (user.status === "rejected") {
    return clientError(res, 403, "Account creation was rejected. Contact your administrator.");
  }

  // Ensure gamification profile exists (non-blocking — login must not fail if this does)
  // Use org._id directly; user.orgId is stored as a string and may not cast to ObjectId
  GamificationProfile.findOneAndUpdate(
    { userId: user._id },
    { $setOnInsert: {
        userId:      user._id,
        orgId:       org._id,
        totalXp:     0,
        monthlyXp:   0,
        level:       1,
        hp:          100,
        gold:        0,
        activeTitle: "newcomer",
        stats:       {},
      }
    },
    { upsert: true }
  ).catch((err) => console.error("[Login] GamificationProfile upsert failed:", err.message));

  const token = signToken(user);

  // Create Session record (D-022e) — non-blocking
  Session.create({
    userId:       user._id,
    orgId:        org._id,
    tokenHash:    Session.hashToken(token),
    tokenVersion: user.tokenVersion ?? 0,
    device:       req.headers["user-agent"]?.slice(0, 200) ?? "Unknown",
    ip:           req.ip ?? null,
  }).catch((err) => console.error("[Login] Session create failed:", err.message));

  return res.json({
    token,
    user: { ...sanitize(user, org.name, await gamiOf(user._id)), orgCode: org.orgCode ?? null },
  });
}

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// Protected: requires verifyToken middleware upstream.
export async function getMe(req, res) {
  const user = await User.findById(req.user.id);

  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  let orgName = null;
  if (user.orgId) {
    const isObjectId = /^[0-9a-f]{24}$/i.test(user.orgId);
    const org = isObjectId
      ? await Organization.findById(user.orgId, "name").lean()
      : await Organization.findOne({ orgId: user.orgId }, "name").lean();
    orgName = org?.name ?? null;
  }

  const u = sanitize(user, orgName, await gamiOf(user._id));
  if (req.viewAs) { u.email = null; u.settings = null; u.hp = null; }
  return res.json({ user: u, viewAs: req.viewAs ?? null });
}

// ── POST /api/auth/register-employee ─────────────────────────────────────────
// Called from MemberStep2.  Employee joins an existing org via invite code (orgId).
// On success: creates User, pushes _id into Organization.members, returns JWT.
export async function registerEmployee(req, res) {
  const { orgId, email, name, password, role = "Developer" } = req.body ?? {};

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!orgId?.trim() || !email?.trim() || !name?.trim() || !password) {
    return clientError(res, 400, "orgId, email, name, and password are all required.");
  }

  if (!/\S+@\S+\.\S+/.test(email)) {
    return clientError(res, 400, "Enter a valid email address.");
  }

  if (password.length < PASSWORD_MIN) {
    return clientError(res, 400, `Password must be at least ${PASSWORD_MIN} characters.`);
  }

  if (!VALID_ROLES.includes(role)) {
    return clientError(res, 400, `role must be one of: ${VALID_ROLES.join(", ")}.`);
  }

  // ── Verify org exists and is active ────────────────────────────────────────
  const org = await Organization.findOne({ orgId: orgId.trim().toUpperCase() });

  if (!org) {
    return clientError(res, 404, "No organization found with that invite code.");
  }

  if (org.status === "suspended") {
    return clientError(res, 403, "This organization account has been suspended.");
  }

  // ── Duplicate email check (across all users, not just this org) ─────────────
  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    return clientError(res, 409, "An account with this email already exists.");
  }

  // ── Create user ────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await User.create({
    name:     name.trim(),
    email:    email.toLowerCase().trim(),
    password: hash,
    role,
    orgId:    org._id.toString(),
  });

  // ── Add to org's member list ───────────────────────────────────────────────
  await Organization.updateOne(
    { _id: org._id },
    { $addToSet: { members: user._id } }
  );

  const token = signToken(user);
  return res.status(201).json({ token, user: sanitize(user, org.name) });
}

// ── GET /api/auth/profile ─────────────────────────────────────────────────────
// Returns extended profile: user fields + gamification data + task stats + XP log.
export async function getProfile(req, res) {
  const { id: userId, orgId } = req.user;

  const [user, gp, tasks, recentXp] = await Promise.all([
    User.findById(userId).lean(),
    GamificationProfile.findOne({ userId }).lean(),
    Task.find({ orgId, assignees: userId }).lean(),
    XpLog.find({ userId }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);

  if (!user) return res.status(404).json({ error: "User not found." });

  const doneTasks   = tasks.filter((t) => t.status === "Done");
  const onTimeCount = doneTasks.filter(
    (t) => t.deadline && new Date(t.completedAt ?? t.updatedAt) <= new Date(t.deadline)
  ).length;
  const onTimePct   = doneTasks.length > 0
    ? Math.round((onTimeCount / doneTasks.length) * 100)
    : 0;

  res.json({
    success: true,
    profile: {
      ...sanitize(user, null, gp),
      department:    user.department    ?? null,
      badges:        gp?.badges         ?? [],
      currentStreak: gp?.currentStreak  ?? 0,
      longestStreak: gp?.longestStreak  ?? 0,
      tasksDone:     doneTasks.length,
      totalTasks:    tasks.length,
      onTimePct,
      recentXpLog:   recentXp.map((l) => ({ source: l.source, amount: l.amount, createdAt: l.createdAt })),
    },
  });
}

// ── PATCH /api/auth/me ────────────────────────────────────────────────────────
// Allows updating name and department.
export async function updateMe(req, res) {
  const { name } = req.body ?? {};
  const locked = selfUpdateError(req.body, req.user.role); // S8 (D-167)
  if (locked) return res.status(403).json({ error: locked });
  const updates = {};

  if (name !== undefined) {
    const trimmed = name?.trim();
    if (!trimmed) return res.status(400).json({ error: "Name cannot be empty." });
    updates.name = trimmed;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update." });
  }

  const user = await User.findByIdAndUpdate(req.user.id, { $set: updates }, { returnDocument: "after" });
  if (!user) return res.status(404).json({ error: "User not found." });

  res.json({ success: true, user: sanitize(user, null, await gamiOf(user._id)) });
}

// ── PATCH /api/auth/password ──────────────────────────────────────────────────
// Verifies current password then sets a new one.
export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body ?? {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword and newPassword are required." });
  }
  if (newPassword.length < PASSWORD_MIN) {
    return res.status(400).json({ error: `New password must be at least ${PASSWORD_MIN} characters.` });
  }

  const user = await User.findById(req.user.id).select("+password");
  if (!user) return res.status(404).json({ error: "User not found." });

  const match = await bcrypt.compare(currentPassword, user.password);
  if (!match) return res.status(401).json({ error: "Current password is incorrect." });

  user.password = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await user.save();

  res.json({ success: true, message: "Password updated successfully." });
}

// ── PATCH /api/auth/settings ──────────────────────────────────────────────────
// Persists notification and appearance preferences for the logged-in user.
export async function updateSettings(req, res) {
  const { notifications, appearance, preferences, emailNotificationsEnabled } = req.body ?? {};

  const patch = {};
  // U-1 (D-131): only this role's switchable groups are stored; locked "needs action" groups stay on.
  if (notifications && typeof notifications === "object") patch.notifications = sanitizePrefs(notifications, req.user.role);
  if (appearance && typeof appearance === "object") patch.appearance = appearance;
  if (preferences !== undefined) {
    const { error, value } = validatePreferences(preferences, req.user.role);
    if (error) return res.status(400).json({ error });
    patch.preferences = value;
  }
  // D-296 IMPL-5 Part 6: offline email toggle
  if (emailNotificationsEnabled !== undefined) patch.emailNotificationsEnabled = emailNotificationsEnabled !== false;

  if (Object.keys(patch).length === 0)
    return res.status(400).json({ error: "No valid settings provided." });

  // `settings` starts as null, and Mongo cannot $set a field inside null: merge and write the whole object.
  const current = await User.findById(req.user.id, "settings").lean();
  if (!current) return res.status(404).json({ error: "User not found." });
  const old = current.settings ?? {};
  const merged = { ...old, ...patch, ...(patch.preferences && { preferences: { ...old.preferences, ...patch.preferences } }) };
  const user = await User.findByIdAndUpdate(req.user.id, { $set: { settings: merged } }, { returnDocument: "after", upsert: false });
  if (!user) return res.status(404).json({ error: "User not found." });

  res.json({ success: true, settings: user.settings ?? null });
}

// ── Password reset (FE-020 / FE-R002) ─────────────────────────────────────────
// Step 1: POST /api/auth/forgot-password {email}  → a 6-digit code is delivered out of band.
// Step 2: POST /api/auth/reset-password {email, code, newPassword}.
// Both answer the same way whether or not the account exists.
// V1 4.12 / D-073: 6-digit code by email, 10 min, single use, 5 wrong tries → 15 min lock, 60 s resend cooldown.
// The /forgot-password and /reset-password routes also sit behind the global authLimiter (server.js).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_SENT = { success: true, message: "If that account exists, a reset code has been sent. It expires in 10 minutes." };

export async function forgotPassword(req, res) {
  if (!isMailConfigured()) return res.status(503).json({ error: "Email service is not configured" });

  const email = String(req.body?.email ?? "").toLowerCase().trim();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address." });

  const user = await User.findOne({ email }).select("_id email +resetCodeIssuedAt +resetLockedUntil");
  // Same answer whether or not the account exists, and while locked/cooling down (no account probing).
  if (!user || !canIssueCode(user, new Date()).ok) return res.json(GENERIC_SENT);

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const now  = new Date();
  await User.updateOne(
    { _id: user._id },
    { $set: { resetCodeHash: hashResetCode(code), resetCodeExpires: new Date(now.getTime() + RESET_TTL_MS), resetAttempts: 0, resetCodeIssuedAt: now } }
  );
  try {
    await sendResetCode(user.email, code);
  } catch (err) {
    console.error("[auth] reset email failed:", err.message);
    await User.updateOne({ _id: user._id }, { $unset: { resetCodeHash: 1, resetCodeExpires: 1 } }); // a code nobody received is useless
    return res.status(err.status === 503 ? 503 : 502).json({ error: err.status === 503 ? err.message : "Could not send the email right now. Try again in a few minutes." });
  }
  res.json(GENERIC_SENT);
}

export async function resetPassword(req, res) {
  const { email, code, newPassword } = req.body ?? {};

  if (!email?.trim() || !code || !newPassword) {
    return res.status(400).json({ error: "email, code and newPassword are required." });
  }
  if (String(newPassword).length < PASSWORD_MIN) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN} characters.` });
  }

  const bad  = () => res.status(400).json({ error: "Invalid or expired reset code." });
  const user = await User.findOne({ email: String(email).toLowerCase().trim() })
    .select("+password +resetCodeHash +resetCodeExpires +resetAttempts +resetLockedUntil");
  if (!user) return bad();

  const verdict = verifyResetCode(user, code, new Date());
  if (verdict === "locked") {
    return res.status(429).json({ error: "Too many wrong codes. Wait 15 minutes, then request a new code." });
  }
  if (verdict === "invalid") {
    const attempts = (user.resetAttempts ?? 0) + 1;
    const lock = attempts >= MAX_ATTEMPTS
      ? { $set: { resetLockedUntil: new Date(Date.now() + LOCK_MS) }, $unset: { resetCodeHash: 1, resetCodeExpires: 1 } }
      : {};
    await User.updateOne({ _id: user._id }, { $inc: { resetAttempts: 1 }, ...lock });
    if (attempts >= MAX_ATTEMPTS) return res.status(429).json({ error: "Too many wrong codes. Wait 15 minutes, then request a new code." });
    return bad();
  }
  if (verdict !== "ok") return bad(); // expired or no live code

  // Single use, atomically: only the request that still sees this code hash can spend it.
  const spent = await User.updateOne(
    { _id: user._id, resetCodeHash: user.resetCodeHash },
    {
      $set:   { password: await bcrypt.hash(newPassword, SALT_ROUNDS), resetAttempts: 0, tokenVersion: (user.tokenVersion ?? 0) + 1 },
      $unset: { resetCodeHash: 1, resetCodeExpires: 1, resetLockedUntil: 1 },
    }
  );
  if (!spent.modifiedCount) return bad();

  res.json({ success: true, message: "Password reset successfully. You can now log in." });
}

// ── GET /api/auth/manager-profile-summary ────────────────────────────────────
// Aggregated intelligence profile for Manager role.
export async function getManagerProfileSummary(req, res) {
  const { id: userId, orgId } = req.user;

  // Parallelise all heavy lookups
  const [user, gp, recentXp, projects, allTeamTasks, approvals, auditLogs] = await Promise.all([
    User.findById(userId).lean(),
    GamificationProfile.findOne({ userId }).lean(),
    XpLog.find({ userId }).sort({ createdAt: -1 }).limit(20).lean(),
    Project.find({ orgId, managerId: userId }).lean(),
    Task.find({ orgId }).lean(),
    Approval.find({ orgId, requestedBy: userId }).sort({ createdAt: -1 }).limit(100).lean(),
    AuditLog.find({ orgId, performedBy: userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  ]);

  if (!user) return res.status(404).json({ error: "User not found." });

  // ── Identity ──────────────────────────────────────────────────────────────
  const identity = {
    name:       user.name,
    email:      user.email,
    role:       user.role,
    department: user.department ?? null,
    createdAt:  user.createdAt,
    level:      gp?.level       ?? 1,
    currentXp:  gp?.currentXp   ?? 0,
    maxXp:      gp?.maxXp       ?? 1000,
    totalXp:    gp?.totalXp     ?? 0,
    hp:         gp?.hp          ?? 100,
    gold:       gp?.gold        ?? 0,
    currentStreak: gp?.currentStreak ?? 0,
    longestStreak: gp?.longestStreak ?? 0,
    activeTitle:   (gp?.titles ?? []).find((t) => t.active) ?? null,
    badges:        gp?.badges        ?? [],
    avatarStyle:   gp?.avatarStyle   ?? null,
    avatarSeed:    gp?.avatarSeed    ?? null,
  };

  // ── Project stats ─────────────────────────────────────────────────────────
  const now = Date.now();
  const activeProjects    = projects.filter((p) => !["Completed", "Deleted"].includes(p.status));
  const completedProjects = projects.filter((p) => p.status === "Completed");
  const frozenProjects    = projects.filter((p) => p.status === "Frozen");
  const delayedProjects   = projects.filter(
    (p) => p.deadline && new Date(p.deadline).getTime() < now && p.status !== "Completed"
  );
  const projectOverview = {
    total:     projects.length,
    active:    activeProjects.length,
    completed: completedProjects.length,
    frozen:    frozenProjects.length,
    delayed:   delayedProjects.length,
    recentList: activeProjects.slice(0, 6).map((p) => ({
      _id:       p._id,
      title:     p.title,
      status:    p.status,
      riskLevel: p.riskLevel ?? "Low",
      deadline:  p.deadline  ?? null,
    })),
  };

  // ── Team task stats (tasks in manager's projects) ─────────────────────────
  const myProjectIds = new Set(projects.map((p) => p._id.toString()));
  const teamTasks = allTeamTasks.filter((t) => myProjectIds.has(t.projectId?.toString()));
  const doneTasks = teamTasks.filter((t) => t.status === "Done");
  const blockedTasks = teamTasks.filter((t) => t.status === "Blocked");
  const onTimeTasks = doneTasks.filter(
    (t) => t.deadline && new Date(t.completedAt ?? t.updatedAt) <= new Date(t.deadline)
  );
  const taskCompletionRatio = teamTasks.length > 0
    ? Math.round((doneTasks.length / teamTasks.length) * 100)
    : 0;
  const onTimePct = doneTasks.length > 0
    ? Math.round((onTimeTasks.length / doneTasks.length) * 100)
    : 0;

  const teamPerformance = {
    totalTasks:         teamTasks.length,
    completedTasks:     doneTasks.length,
    blockedTasks:       blockedTasks.length,
    taskCompletionRatio,
    onTimePct,
  };

  // ── Approval stats (response time) ───────────────────────────────────────
  const resolvedApprovals = approvals.filter((a) => a.resolvedAt && a.createdAt);
  const avgResponseMs = resolvedApprovals.length > 0
    ? resolvedApprovals.reduce((acc, a) =>
        acc + (new Date(a.resolvedAt).getTime() - new Date(a.createdAt).getTime()), 0
      ) / resolvedApprovals.length
    : null;
  const avgResponseHours = avgResponseMs !== null
    ? Math.round(avgResponseMs / 3_600_000 * 10) / 10
    : null;
  const pendingApprovals  = approvals.filter((a) => a.status === "PENDING");
  const approvedCount     = approvals.filter((a) => a.status === "APPROVED").length;
  const rejectedCount     = approvals.filter((a) => a.status === "REJECTED").length;
  const approvalDelayRate = approvals.length > 0
    ? Math.round((pendingApprovals.length / approvals.length) * 100)
    : 0;

  const approvalStats = {
    total:            approvals.length,
    pending:          pendingApprovals.length,
    approved:         approvedCount,
    rejected:         rejectedCount,
    avgResponseHours,
    approvalDelayRate,
  };

  // ── Operational efficiency ─────────────────────────────────────────────────
  // Score out of 100: weights — on-time project delivery, task completion, approval delay
  const efficiencyScore = Math.round(
    0.40 * onTimePct +
    0.35 * taskCompletionRatio +
    0.25 * Math.max(0, 100 - approvalDelayRate)
  );

  // ── Activity feed (most recent audit logs) ────────────────────────────────
  const activityFeed = auditLogs.map((l) => ({
    _id:          l._id,
    action:       l.action,
    detail:       l.detail,
    projectTitle: l.projectTitle ?? null,
    newStatus:    l.newStatus    ?? null,
    createdAt:    l.createdAt,
  }));

  // ── Recent XP ─────────────────────────────────────────────────────────────
  const recentXpActivity = recentXp.map((l) => ({
    source:    l.source,
    amount:    l.amount,
    createdAt: l.createdAt,
  }));

  res.json({
    success: true,
    data: {
      identity,
      projectOverview,
      teamPerformance,
      approvalStats,
      efficiencyScore,
      activityFeed,
      recentXpActivity,
    },
  });
}
