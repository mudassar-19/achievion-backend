import User               from "../models/User.js";
import Project            from "../models/Project.js";
import Task               from "../models/Task.js";
import Risk               from "../models/Risk.js";
import Submission         from "../models/Submission.js";
import Approval           from "../models/Approval.js";
import GamificationProfile from "../models/GamificationProfile.js";
import AuditLog           from "../models/AuditLog.js";
import Organization       from "../models/Organization.js";
import Sprint             from "../models/Sprint.js";
import ChatChannel        from "../models/ChatChannel.js";
import ExtensionRequest   from "../models/ExtensionRequest.js";
import mongoose           from "mongoose";
import { VALID_ROLES }    from "../models/User.js";
import { awardXp }        from "../services/gamificationService.js";

// Map a role string to its category label (mirrors ROLE_CATEGORY_MAP)
function roleToCat(role) {
  if (!role) return "other";
  const r = role.toLowerCase();
  if (r === "director")                          return "Director";
  if (r === "manager")                           return "Manager";
  if (r === "team lead")                         return "Team Lead";
  if (r.includes("designer"))                    return "Designer";
  if (r.includes("tester"))                      return "Tester";
  if (r.includes("developer") || r === "developer") return "Developer";
  return "Other";
}

// AI bonus XP = ~20% of baseXp scaled by quality score
function calcBonusXp(baseXp, aiScore) {
  return Math.round((baseXp * (aiScore ?? 0)) / 500);
}

// IDs of all non-deleted members in the director's org
async function orgMemberIds(orgId) {
  const docs = await User.find({ orgId, status: { $ne: "deleted" } }, "_id").lean();
  return docs.map((d) => d._id);
}

// ── GET /api/director/profile ─────────────────────────────────────────────────
export async function getDirectorProfile(req, res) {
  const { orgId, id: directorId } = req.user;

  const org = await Organization.findOne(orgFilter(orgId), "name orgId createdAt _id").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });

  const director = await User.findById(directorId, "name email role department createdAt").lean();
  if (!director) return res.status(404).json({ error: "Director not found." });

  const memberIds = await orgMemberIds(orgId);

  const [
    subsApproved, subsRejected, subsPending,
    hrApproved, hrRejected, hrPending,
    roleChanges, activeProjects, memberCount,
    recentLogs,
  ] = await Promise.all([
    Submission.countDocuments({ status: "Approved", submitter: { $in: memberIds } }),
    Submission.countDocuments({ status: "Rejected", submitter: { $in: memberIds } }),
    Submission.countDocuments({ status: "Pending",  submitter: { $in: memberIds } }),
    Approval.countDocuments({ orgId: org._id, status: "APPROVED" }),
    Approval.countDocuments({ orgId: org._id, status: "REJECTED" }),
    Approval.countDocuments({ orgId: org._id, status: "PENDING"  }),
    AuditLog.countDocuments({ orgId: org._id, performedBy: directorId, action: "role_change" }),
    Project.countDocuments({ director: directorId }),
    User.countDocuments({ orgId: org._id.toString(), status: { $ne: "deleted" }, role: { $ne: "Director" } }),
    AuditLog.find({ $or: [{ orgId: org._id }, { performedBy: org.orgId }] })
      .sort({ createdAt: -1 })
      .limit(6)
      .populate("targetUserId", "name role")
      .lean(),
  ]);

  const subsTotal = subsApproved + subsRejected;

  res.json({
    name:       director.name,
    email:      director.email,
    role:       director.role,
    department: director.department ?? null,
    createdAt:  director.createdAt,
    org: {
      name:      org.name,
      orgId:     org.orgId,
      createdAt: org.createdAt,
    },
    stats: {
      subsApproved,
      subsRejected,
      subsPending,
      subsTotal,
      subsApprovalRate: subsTotal > 0 ? Math.round((subsApproved / subsTotal) * 100) : 0,
      hrApproved,
      hrRejected,
      hrPending,
      roleChanges,
      activeProjects,
      memberCount,
    },
    recentLogs: recentLogs.map((l) => ({
      id:         l._id,
      action:     l.action,
      targetName: l.targetUserId?.name ?? null,
      targetRole: l.targetUserId?.role ?? null,
      oldRole:    l.oldRole   ?? null,
      newRole:    l.newRole   ?? null,
      newStatus:  l.newStatus ?? null,
      detail:     l.detail    ?? null,
      createdAt:  l.createdAt,
    })),
  });
}

// ── GET /api/director/dashboard ───────────────────────────────────────────────
export async function getDashboard(req, res) {
  const { orgId, id: directorUserId } = req.user;

  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();
  const orgObjectId = org?._id ?? null;

  const [activeProjects, pendingCount, burnoutProfiles] =
    await Promise.all([
      Project.countDocuments({ director: directorUserId, status: "Active" }),
      Approval.countDocuments({ orgId: orgObjectId, status: "PENDING" }),
      GamificationProfile.find({ orgId, hp: { $lt: 40 } })
        .populate("userId", "name role")
        .lean(),
    ]);

  res.json({
    activeProjects,
    pendingApprovals: pendingCount,
    burnoutRisk:      burnoutProfiles.length,
    burnoutUsers: burnoutProfiles.map((p) => ({
      id:   p.userId?._id,
      name: p.userId?.name,
      role: p.userId?.role,
      hp:   p.hp,
    })),
  });
}

// ── GET /api/director/approvals ───────────────────────────────────────────────
export async function getApprovals(req, res) {
  const memberIds = await orgMemberIds(req.user.orgId);

  const submissions = await Submission.find({
    status: "Pending",
    submitter: { $in: memberIds },
  })
    .sort({ createdAt: -1 })
    .populate({
      path:     "task",
      select:   "title baseXp projectId",
      populate: { path: "projectId", select: "title" },
    })
    .populate("submitter", "name email role")
    .lean();

  res.json(
    submissions.map((s) => ({
      id:          s._id,
      taskTitle:   s.task?.title,
      projectName: s.task?.projectId?.title,
      notes:       s.notes,
      url:         s.url,
      aiScore:     s.aiScore,
      baseXp:      s.task?.baseXp ?? 0,
      bonusXp:     calcBonusXp(s.task?.baseXp ?? 0, s.aiScore),
      user: {
        id:    s.submitter?._id,
        name:  s.submitter?.name,
        email: s.submitter?.email,
        role:  s.submitter?.role,
      },
      submittedAt: s.createdAt,
    }))
  );
}

// ── POST /api/director/approvals/:submissionId/approve ────────────────────────
export async function approveSubmission(req, res) {
  const { submissionId } = req.params;

  const submission = await Submission.findById(submissionId).populate("task", "title baseXp _id");
  if (!submission) return res.status(404).json({ error: "Submission not found." });
  if (submission.status !== "Pending")
    return res.status(400).json({ error: "Submission already reviewed." });

  const baseXp  = submission.task?.baseXp ?? 0;
  const totalXp = baseXp + calcBonusXp(baseXp, submission.aiScore);

  const [gamification] = await Promise.all([
    awardXp(submission.submitter, req.user.orgId, totalXp, "task_approval"),
    Submission.updateOne({ _id: submissionId }, { $set: { status: "Approved" } }),
    Task.updateOne({ _id: submission.task._id }, { $set: { status: "Done" } }),
  ]);

  res.json({ success: true, xpAwarded: totalXp, gamification });
}

// ── POST /api/director/approvals/:submissionId/reject ─────────────────────────
export async function rejectSubmission(req, res) {
  const { submissionId } = req.params;

  const submission = await Submission.findById(submissionId);
  if (!submission) return res.status(404).json({ error: "Submission not found." });
  if (submission.status !== "Pending")
    return res.status(400).json({ error: "Submission already reviewed." });

  await Promise.all([
    Submission.updateOne({ _id: submissionId }, { $set: { status: "Rejected" } }),
    Task.updateOne({ _id: submission.task }, { $set: { status: "In-Progress" } }),
  ]);

  res.json({ success: true });
}

// ── GET /api/director/analytics ───────────────────────────────────────────────
export async function getAnalytics(req, res) {
  const { orgId } = req.user;
  const memberIds = await orgMemberIds(orgId);

  const [topEarnersRaw, deptAgg, taskAgg, profileAgg] = await Promise.all([
    GamificationProfile.find({ orgId })
      .sort({ currentXp: -1 })
      .limit(12)
      .populate("userId", "name role")
      .lean(),

    User.aggregate([
      { $match: { orgId, status: { $ne: "deleted" }, department: { $ne: null, $ne: "" } } },
      {
        $lookup: {
          from:         "gamificationprofiles",
          localField:   "_id",
          foreignField: "userId",
          as:           "profile",
        },
      },
      { $unwind: { path: "$profile", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id:     "$department",
          members: { $sum: 1 },
          avgXp:   { $avg: { $ifNull: ["$profile.currentXp", 0] } },
        },
      },
      { $sort: { avgXp: -1 } },
    ]),

    Task.aggregate([
      { $match: { assignees: { $in: memberIds } } },
      {
        $group: {
          _id:  null,
          total: { $sum: 1 },
          done:  { $sum: { $cond: [{ $eq: ["$status", "Done"] }, 1, 0] } },
        },
      },
    ]),

    GamificationProfile.aggregate([
      { $match: { orgId } },
      { $group: { _id: null, avgXp: { $avg: "$currentXp" }, atRisk: { $sum: { $cond: [{ $lt: ["$hp", 30] }, 1, 0] } } } },
    ]),
  ]);

  const total           = taskAgg[0]?.total ?? 0;
  const done            = taskAgg[0]?.done  ?? 0;
  const completionRate  = total > 0 ? Math.round((done / total) * 100) : 0;

  res.json({
    stats: {
      totalMembers:    memberIds.length,
      completionRate,
      pendingApprovals: await Submission.countDocuments({ status: "Pending", submitter: { $in: memberIds } }),
      atRisk:          profileAgg[0]?.atRisk ?? 0,
    },
    departments: deptAgg.map((d) => ({
      name:    d._id,
      members: d.members,
      avgXp:   Math.round(d.avgXp),
      score:   Math.min(100, Math.round(d.avgXp / 50)),
    })),
    topEarners: topEarnersRaw
      .filter((p) => p.userId?.role !== "Director")
      .slice(0, 10)
      .map((p, i) => ({
        rank:  i + 1,
        name:  p.userId?.name,
        role:  p.userId?.role,
        xp:    p.currentXp,
        level: p.level,
      })),
  });
}

// ── GET /api/director/team ────────────────────────────────────────────────────
export async function getTeam(req, res) {
  const { orgId, id: directorId } = req.user;

  // Resolve org to handle both hex and "ORG-XXX" orgId formats
  const org = await Organization.findOne(orgFilter(orgId), "_id orgId").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });

  const members = await User.find(
    {
      $or: [{ orgId: org._id.toString() }, { orgId: org.orgId }],
      status: { $ne: "deleted" },
      role:   { $ne: "Director" },   // Directors are not managed here
      _id:    { $ne: directorId },   // Exclude the requesting Director's own account
    },
    "name email role department status createdAt"
  )
    .sort({ createdAt: -1 })
    .lean();

  const memberIds = members.map((m) => m._id);

  const [profiles, taskCountAgg] = await Promise.all([
    GamificationProfile.find({ userId: { $in: memberIds } }, "userId level currentXp hp").lean(),
    Task.aggregate([
      { $match: { assignees: { $in: memberIds }, status: "Done" } },
      { $group: { _id: { $arrayElemAt: ["$assignees", 0] }, count: { $sum: 1 } } },
    ]),
  ]);

  const profileMap = Object.fromEntries(profiles.map((p) => [p.userId.toString(), p]));
  const taskMap    = Object.fromEntries(taskCountAgg.map((t) => [t._id.toString(), t.count]));

  res.json(
    members.map((m) => ({
      id:         m._id,
      name:       m.name,
      email:      m.email,
      role:       m.role,
      department: m.department,
      status:     m.status,
      level:      profileMap[m._id.toString()]?.level     ?? 1,
      xp:         profileMap[m._id.toString()]?.currentXp ?? 0,
      hp:         profileMap[m._id.toString()]?.hp        ?? 100,
      tasksDone:  taskMap[m._id.toString()] ?? 0,
    }))
  );
}

// ── PATCH /api/director/team/:userId/role ─────────────────────────────────────
export async function updateTeamMemberRole(req, res) {
  const { userId }         = req.params;
  const { role: newRole }  = req.body;
  const { orgId, id: directorId } = req.user;

  if (!newRole || !VALID_ROLES.includes(newRole))
    return res.status(400).json({ error: "Invalid role." });

  if (newRole === "Director")
    return res.status(400).json({ error: "Cannot assign Director role via this endpoint." });

  if (String(userId) === String(directorId))
    return res.status(400).json({ error: "Cannot modify your own account." });

  // Resolve org to handle both orgId formats
  const org = await Organization.findOne(orgFilter(orgId), "_id orgId").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });

  const member = await User.findOne({
    _id: userId,
    $or: [{ orgId: org._id.toString() }, { orgId: org.orgId }],
    role: { $ne: "Director" },
  });
  if (!member) return res.status(404).json({ error: "Team member not found." });

  const oldRole = member.role;
  member.role   = newRole;
  await member.save();

  // Log the change
  await AuditLog.create({
    action:       "role_change",
    orgId:        org._id,
    targetUserId: member._id,
    performedBy:  directorId,
    oldRole,
    newRole,
  });

  res.json({ success: true, role: newRole });
}

// ── GET /api/director/projects ────────────────────────────────────────────────
export async function getProjects(req, res) {
  const { orgId } = req.user;

  const directorIds = await User.find({ orgId, role: "Director" }, "_id").lean();
  const dirIds      = directorIds.map((d) => d._id);

  const projects = await Project.find({ director: { $in: dirIds } })
    .populate("director",  "name")
    .populate("managerId", "name")
    .sort({ createdAt: -1 })
    .lean();

  const projectIds    = projects.map((p) => p._id);
  const completionAgg = await Task.aggregate([
    { $match: { project: { $in: projectIds } } },
    {
      $group: {
        _id:   "$project",
        total: { $sum: 1 },
        done:  { $sum: { $cond: [{ $eq: ["$status", "Done"] }, 1, 0] } },
      },
    },
  ]);

  const completionMap = Object.fromEntries(
    completionAgg.map((c) => [
      c._id.toString(),
      c.total > 0 ? Math.round((c.done / c.total) * 100) : 0,
    ])
  );

  res.json(
    projects.map((p) => ({
      id:         p._id,
      title:      p.title,
      status:     p.status,
      xpPool:     p.xpPool,
      leadName:    p.managerId?.name ?? "Unassigned",
      completion:  completionMap[p._id.toString()] ?? 0,
      deadline:    p.deadline ?? null,
      managerId:   p.managerId?._id ?? p.managerId ?? null,
      managerName: p.managerId?.name ?? null,
    }))
  );
}

// ── PATCH /api/director/projects/:projectId/xp-pool ──────────────────────────
export async function updateProjectXpPool(req, res) {
  const { projectId }      = req.params;
  const { xpPool }         = req.body;
  const { orgId, id: dirId } = req.user;

  if (typeof xpPool !== "number" || xpPool < 0)
    return res.status(400).json({ error: "xpPool must be a non-negative number." });

  const directorIds = await User.find({ orgId: req.user.orgId, role: "Director" }, "_id").lean();
  const project     = await Project.findOne({
    _id:      projectId,
    director: { $in: directorIds.map((d) => d._id) },
  });

  if (!project) return res.status(404).json({ error: "Project not found." });

  const oldPool  = project.xpPool;
  project.xpPool = xpPool;
  await project.save();

  // Audit log — resolve org then write
  Organization.findOne(orgFilter(orgId), "_id").lean()
    .then((org) => {
      if (!org) return;
      return AuditLog.create({
        action:          "project_xp_updated",
        orgId:           org._id,
        performedBy:     dirId,
        targetProjectId: project._id,
        projectTitle:    project.title,
        detail:          `XP pool changed from ${oldPool} to ${xpPool} on "${project.title}".`,
      });
    })
    .catch(() => {});

  res.json({ success: true, xpPool });
}

// Category → action list mapping (task-level events are deliberately excluded)
const CATEGORY_ACTIONS = {
  employee:     ["role_change", "account_status_change", "account_deleted", "employee_created", "DIRECTOR_SETUP"],
  organization: ["ORG_CREATED", "workspace_updated", "GAMIFICATION_RESET"],
  project:      ["project_created", "project_updated", "project_xp_updated", "project_status_changed"],
};

// ── GET /api/director/audit-log ───────────────────────────────────────────────
export async function getAuditLog(req, res) {
  const { orgId } = req.user;
  const page     = Math.max(1, parseInt(req.query.page)  || 1);
  const limit    = Math.min(50, parseInt(req.query.limit) || 20);
  const action   = req.query.action           || null;
  const category = req.query.category         || null;
  const search   = req.query.search?.trim()   || null;

  const org = await Organization.findOne(orgFilter(orgId), "_id orgId").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });

  const query = {
    $or: [
      { orgId: org._id },
      { performedBy: org.orgId },
    ],
  };

  // Prefer category filter over individual action filter
  if (category && CATEGORY_ACTIONS[category]) {
    query.action = { $in: CATEGORY_ACTIONS[category] };
  } else if (action) {
    query.action = action;
  }

  // Pre-filter search by member name (only for employee-category logs that have a targetUserId)
  if (search) {
    const matchingUsers = await User.find(
      {
        $or: [{ orgId: org._id.toString() }, { orgId: org.orgId }],
        name: { $regex: search, $options: "i" },
      },
      "_id"
    ).lean();
    if (matchingUsers.length === 0) {
      return res.json({ logs: [], total: 0, page: 1, pages: 1, limit });
    }
    query.targetUserId = { $in: matchingUsers.map((u) => u._id) };
  }

  const [logs, total] = await Promise.all([
    AuditLog.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("targetUserId",    "name role avatarSeed")
      .populate("targetProjectId", "title status")
      .populate("performedBy",     "name role")
      .lean(),
    AuditLog.countDocuments(query),
  ]);

  const mapped = logs.map((l) => ({
    id:            l._id,
    action:        l.action,
    targetName:    l.targetUserId?.name      ?? null,
    targetRole:    l.targetUserId?.role      ?? null,
    avatarSeed:    l.targetUserId?.avatarSeed ?? l.targetUserId?.name ?? null,
    projectTitle:  l.projectTitle ?? l.targetProjectId?.title ?? null,
    oldRole:       l.oldRole    ?? null,
    newRole:       l.newRole    ?? null,
    newStatus:     l.newStatus  ?? null,
    detail:        l.detail     ?? null,
    createdAt:     l.createdAt,
    // Slice 3a fields (D-022a)
    performerName: typeof l.performedBy === "object" ? l.performedBy?.name ?? null : null,
    performerRole: typeof l.performedBy === "object" ? l.performedBy?.role ?? null : null,
    before:        l.before     ?? null,
    after:         l.after      ?? null,
    actionHash:    l.actionHash ?? null,
    scope:         l.scope      ?? "org",
  }));

  res.json({ logs: mapped, total, page, pages: Math.ceil(total / limit), limit });
}

// ── GET /api/director/xp-distribution ────────────────────────────────────────
export async function getXpDistribution(req, res) {
  const { orgId } = req.user;

  const profiles = await GamificationProfile.find({ orgId })
    .populate("userId", "role")
    .lean();

  const groups = {};
  for (const p of profiles) {
    const cat = roleToCat(p.userId?.role);
    if (!groups[cat]) groups[cat] = { category: cat, totalXp: 0, memberCount: 0 };
    groups[cat].totalXp    += p.currentXp ?? 0;
    groups[cat].memberCount += 1;
  }

  const result = Object.values(groups)
    .map((g) => ({ ...g, avgXp: g.memberCount ? Math.round(g.totalXp / g.memberCount) : 0 }))
    .sort((a, b) => b.totalXp - a.totalXp);

  res.json(result);
}

// ── Org lookup helper: Director's orgId may be a MongoDB ObjectId string ─────
// (Director was created with orgId = org._id.toString(), not the "ORG-XXX" code)
const IS_OBJECT_ID = /^[0-9a-f]{24}$/i;

function orgFilter(orgId) {
  return IS_OBJECT_ID.test(orgId ?? "") ? { _id: orgId } : { orgId };
}

const DEFAULT_GAMIFICATION_RULES = {
  xpMultipliers: {
    Feature:       1.0,
    Bug:           0.8,
    Design:        0.9,
    Testing:       0.7,
    DevOps:        0.9,
    Documentation: 0.5,
  },
  streakBonus:      1.1,
  badgeThresholds:  { firstTask: 1, tenTasks: 10, streak7: 7, streak30: 30 },
};

// ── GET /api/director/workspace-settings ──────────────────────────────────────
export async function getWorkspaceSettings(req, res) {
  const { orgId } = req.user;

  const org = await Organization.findOne(orgFilter(orgId), "-passwordHash -members").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });

  const memberCount = await User.countDocuments({ orgId: org._id.toString(), status: { $ne: "deleted" } });

  res.json({
    name:              org.name,
    orgId:             org.orgId,
    adminEmail:        org.adminEmail,
    departments:       org.departments ?? [],
    companySize:       org.companySize ?? "",
    status:            org.status,
    createdAt:         org.createdAt,
    memberCount,
    gamificationRules: org.gamificationRules ?? DEFAULT_GAMIFICATION_RULES,
  });
}

// ── PATCH /api/director/workspace-settings ────────────────────────────────────
export async function updateWorkspaceSettings(req, res) {
  const { orgId, id: directorId } = req.user;
  const { name, companySize, gamificationRules } = req.body;

  const update = {};
  const changedFields = [];
  if (name?.trim())                                                { update.name             = name.trim();    changedFields.push("name"); }
  if (companySize)                                                 { update.companySize       = companySize;   changedFields.push("companySize"); }
  if (gamificationRules && typeof gamificationRules === "object") { update.gamificationRules = gamificationRules; changedFields.push("gamificationRules"); }

  if (Object.keys(update).length === 0) return res.status(400).json({ error: "Nothing to update." });

  const org = await Organization.findOneAndUpdate(
    orgFilter(orgId),
    { $set: update },
    { returnDocument: "after", runValidators: true }
  ).lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });

  await AuditLog.create({
    action:      "workspace_updated",
    orgId:       org._id,
    performedBy: directorId,
    detail:      `Workspace settings updated: ${changedFields.join(", ")}.`,
  }).catch(() => {});

  res.json({
    ok:                true,
    name:              org.name,
    companySize:       org.companySize,
    gamificationRules: org.gamificationRules ?? DEFAULT_GAMIFICATION_RULES,
  });
}

// ── POST /api/director/reset-gamification ─────────────────────────────────────
// Blocked: Danger Zone UI removed; re-enable only after owner approval +
// maker-checker second-Director confirm. When re-enabled, GAMIFICATION_RESET
// must be logged to AuditLog with orgId, performedBy, and confirmedBy fields.
export async function resetGamification(_req, res) {
  return res.status(403).json({
    error: "Gamification reset is disabled. Requires owner approval and maker-checker confirmation.",
  });
}

// ── GET /api/director/workspace-members ───────────────────────────────────────
export async function getWorkspaceMembers(req, res) {
  const { orgId } = req.user;

  const members = await User.find(
    { orgId, status: { $ne: "deleted" } },
    "name email role department status avatarSeed createdAt"
  )
    .sort({ role: 1, name: 1 })
    .lean();

  res.json(members.map((m) => ({
    id:         m._id,
    name:       m.name,
    email:      m.email,
    role:       m.role,
    department: m.department ?? "",
    status:     m.status,
    avatarSeed: m.avatarSeed ?? m.name,
    joinedAt:   m.createdAt,
  })));
}

// ── PATCH /api/director/workspace-members/:userId/status ──────────────────────
export async function updateMemberStatus(req, res) {
  const { userId } = req.params;
  const { orgId }  = req.user;
  const { status } = req.body;

  const VALID = ["active", "inactive", "suspended"];
  if (!VALID.includes(status)) return res.status(400).json({ error: "Invalid status." });

  const member = await User.findOneAndUpdate(
    { _id: userId, orgId },
    { $set: { status } },
    { returnDocument: "after", select: "name email role status" }
  ).lean();

  if (!member) return res.status(404).json({ error: "Member not found." });

  res.json({ id: member._id, name: member.name, status: member.status });
}

// ── GET /api/director/reports/xp-by-role ─────────────────────────────────────
export async function getXpByRole(req, res) {
  const { orgId } = req.user;

  // Get all member IDs in this org (exclude Directors — D-025: they don't earn XP)
  const members = await User.find({ orgId, status: { $ne: "deleted" }, role: { $ne: "Director" } }, "_id role").lean();
  const roleMap = {};
  members.forEach((m) => { roleMap[String(m._id)] = m.role ?? "Unknown"; });

  const memberIds = members.map((m) => m._id);

  // Aggregate currentXp grouped by user, then group by role
  const profiles = await GamificationProfile.find(
    { userId: { $in: memberIds } },
    "userId currentXp"
  ).lean();

  const roleTotals = {};
  profiles.forEach((p) => {
    const role = roleMap[String(p.userId)] ?? "Unknown";
    roleTotals[role] = (roleTotals[role] ?? 0) + (p.currentXp ?? 0);
  });

  const data = Object.entries(roleTotals)
    .map(([role, totalXp]) => ({ role, totalXp }))
    .sort((a, b) => b.totalXp - a.totalXp);

  res.json({ data });
}

// ── GET /api/director/reports/task-stats ─────────────────────────────────────
export async function getTaskStats(req, res) {
  const { orgId } = req.user;

  const [total, completed, inReview, overdue] = await Promise.all([
    Task.countDocuments({ orgId }),
    Task.countDocuments({ orgId, status: "Done" }),
    Task.countDocuments({ orgId, status: "In-Review" }),
    Task.countDocuments({
      orgId,
      status: { $nin: ["Done"] },
      deadline: { $lt: new Date() },
    }),
  ]);

  res.json({ total, completed, inReview, overdue });
}

// ── GET /api/director/reports/sprint-velocity ────────────────────────────────
export async function getSprintVelocity(req, res) {
  const { orgId } = req.user;

  const sprints = await Sprint.find({ orgId })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  const rows = await Promise.all(
    sprints.map(async (s) => {
      const planned   = s.tasks?.length ?? 0;
      const completed = planned > 0
        ? await Task.countDocuments({ _id: { $in: s.tasks }, status: "Done" })
        : 0;
      return {
        id:          String(s._id),
        name:        s.name,
        startDate:   s.startDate,
        status:      s.status,
        planned,
        completed,
        pct:         planned > 0 ? Math.round((completed / planned) * 100) : 0,
      };
    })
  );

  res.json({ rows });
}

// ── GET /api/director/approvals/reviewed ─────────────────────────────────────
// Returns last N submissions with status Approved or Rejected.
export async function getRecentlyReviewed(req, res) {
  const limit      = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const memberIds  = await orgMemberIds(req.user.orgId);

  const submissions = await Submission.find({
    status:    { $in: ["Approved", "Rejected"] },
    submitter: { $in: memberIds },
  })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .populate({
      path:     "task",
      select:   "title project",
      populate: { path: "project", select: "title" },
    })
    .populate("submitter", "name role")
    .lean();

  res.json(
    submissions.map((s) => ({
      id:          String(s._id),
      taskTitle:   s.task?.title ?? "—",
      projectName: s.task?.project?.title ?? "—",
      status:      s.status,
      user: {
        id:   String(s.submitter?._id ?? ""),
        name: s.submitter?.name ?? "Unknown",
        role: s.submitter?.role ?? "—",
      },
      reviewedAt: s.updatedAt,
    }))
  );
}

// ── GET /api/director/projects/:id  — full project detail (DIR-02.2) ──────────
// D-027: NO individual performance scores.
export async function getProjectDetail(req, res) {
  const { orgId } = req.user;
  const { id }    = req.params;

  if (!mongoose.Types.ObjectId.isValid(id))
    return res.status(400).json({ error: "Invalid project id." });

  const dirIds = (await User.find({ orgId, role: "Director" }, "_id").lean()).map(d => d._id);
  const project = await Project.findOne({ _id: id, director: { $in: dirIds } })
    .populate("managerId", "name email role")
    .populate("director",  "name")
    .lean();

  if (!project) return res.status(404).json({ error: "Project not found." });

  const [taskAgg, risks, extensions] = await Promise.all([
    Task.aggregate([
      { $match: { projectId: project._id } },
      { $group: {
        _id:   null,
        total: { $sum: 1 },
        done:  { $sum: { $cond: [{ $eq: ["$status", "Done"] }, 1, 0] } },
        plannedHours: { $sum: { $ifNull: ["$estimatedHours", 0] } },
        openHours:    { $sum: { $cond: [{ $in: ["$status", ["To-Do", "In-Progress", "In-Review"]] }, { $ifNull: ["$estimatedHours", 0] }, 0] } },
      } },
    ]),
    Risk.find({ projectId: project._id, status: "open" })
      .sort({ score: -1 })
      .limit(10)
      .select("title severity score status createdAt")
      .lean(),
    ExtensionRequest.find({ projectId: project._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate("taskId", "title")
      .lean(),
  ]);

  const stats = taskAgg[0] ?? { total: 0, done: 0, plannedHours: 0, openHours: 0 };
  const progress = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

  res.json({
    id:          project._id,
    title:       project.title,
    description: project.description,
    status:      project.status,
    priority:    project.priority,
    category:    project.category,
    startDate:   project.startDate ?? null,
    deadline:    project.deadline ?? null,
    manager:     project.managerId ? { id: project.managerId._id, name: project.managerId.name, role: project.managerId.role } : null,
    progress,
    taskStats:   { total: stats.total, done: stats.done, plannedHours: stats.plannedHours, openHours: stats.openHours },
    risks:       risks.map(r => ({ id: r._id, title: r.title, severity: r.severity, score: r.score })),
    extensions:  extensions.map(e => ({ taskTitle: e.taskId?.title ?? "—", reason: e.reason, requestedDays: e.requestedDays, originalDeadline: e.originalDeadline, status: e.status })),
  });
}
