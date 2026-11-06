import User               from "../models/User.js";
import { createNotification } from "./notificationController.js";
import { firstLengthError } from "../services/textLimits.js";
import { validateProjectInput } from "../services/projectRules.js";
import Task               from "../models/Task.js";
import Project            from "../models/Project.js";
import Milestone          from "../models/Milestone.js";
import Submission         from "../models/Submission.js";
import GamificationProfile from "../models/GamificationProfile.js";
import AuditLog           from "../models/AuditLog.js";
import Organization       from "../models/Organization.js";
import ChatChannel        from "../models/ChatChannel.js";
import ChatCommunity     from "../models/ChatCommunity.js";
import { getBulkWorkloadSnapshots } from "../services/workloadService.js";
import { availabilityFor } from "../services/workloadRules.js";
import { healthForProjects } from "../services/projectHealthService.js";

const IS_OBJECT_ID_MGR = /^[0-9a-f]{24}$/i;
function orgFilterMgr(orgId) {
  return IS_OBJECT_ID_MGR.test(orgId ?? "") ? { _id: orgId } : { orgId };
}

async function orgMemberIds(orgId) {
  const docs = await User.find({ orgId, status: { $ne: "deleted" } }, "_id").lean();
  return docs.map((d) => d._id);
}

// ── GET /api/manager/dashboard ────────────────────────────────────────────────
export async function getDashboard(req, res) {
  const { orgId } = req.user;
  const memberIds  = await orgMemberIds(orgId);

  const [totalMembers, completedTasks, inProgressTasks, pendingApprovals, topPerformers] =
    await Promise.all([
      User.countDocuments({ orgId, status: "active" }),
      Task.countDocuments({ assignees: { $in: memberIds }, status: "Done" }),
      Task.countDocuments({ assignees: { $in: memberIds }, status: "In-Progress" }),
      Task.countDocuments({ assignees: { $in: memberIds }, status: "In-Review" }),
      GamificationProfile.find({ orgId })
        .sort({ currentXp: -1 })
        .limit(5)
        .populate("userId", "name role department")
        .lean(),
    ]);

  res.json({
    stats: { totalMembers, completedTasks, inProgressTasks, pendingApprovals },
    topPerformers: topPerformers.map((p) => ({
      id:         p.userId?._id,
      name:       p.userId?.name,
      role:       p.userId?.role,
      department: p.userId?.department,
      xp:         p.currentXp,
      level:      p.level,
      hp:         p.hp,
    })),
  });
}

// ── GET /api/manager/team ─────────────────────────────────────────────────────
export async function getTeam(req, res) {
  const { orgId } = req.user;

  const members = await User.find(
    { orgId, status: { $ne: "deleted" } },
    "name email role department status"
  )
    .sort({ role: 1 })
    .lean();

  const memberIds = members.map((m) => m._id);
  const profiles  = await GamificationProfile.find(
    { userId: { $in: memberIds } },
    "userId level currentXp hp"
  ).lean();

  const profileMap = Object.fromEntries(profiles.map((p) => [p.userId.toString(), p]));

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
    }))
  );
}

// ── GET /api/manager/tasks/overview ──────────────────────────────────────────
export async function getTaskOverview(req, res) {
  const memberIds = await orgMemberIds(req.user.orgId);

  const agg = await Task.aggregate([
    { $match: { assignees: { $in: memberIds } } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const byStatus = Object.fromEntries(agg.map((a) => [a._id, a.count]));

  res.json({
    backlog:    byStatus["Backlog"]      ?? 0,
    todo:       byStatus["To-Do"]        ?? 0,
    inProgress: byStatus["In-Progress"]  ?? 0,
    inReview:   byStatus["In-Review"]    ?? 0,
    done:       byStatus["Done"]         ?? 0,
  });
}

// ── GET /api/manager/overdue-tasks ────────────────────────────────────────────
export async function getOverdueTasks(req, res) {
  const memberIds = await orgMemberIds(req.user.orgId);
  const now       = new Date();

  const tasks = await Task.find({
    assignees: { $in: memberIds },
    status:    { $nin: ["Done"] },
    deadline:  { $lt: now, $ne: null },
  })
    .sort({ deadline: 1 })
    .limit(8)
    .populate("assignees", "name role")
    .lean();

  res.json(
    tasks.map((t) => ({
      id:        t._id,
      title:     t.title,
      priority:  t.priority,
      status:    t.status,
      deadline:  t.deadline,
      daysOver:  Math.ceil((now - new Date(t.deadline)) / 86_400_000),
      assignees: (t.assignees ?? []).map((a) => ({ id: a._id, name: a.name, role: a.role })),
    }))
  );
}

// ── GET /api/manager/team-workload ────────────────────────────────────────────
export async function getTeamWorkload(req, res) {
  const { orgId } = req.user;

  const members = await User.find(
    { orgId, status: "active" },
    "name role"
  ).lean();

  const memberIds = members.map((m) => m._id);

  const agg = await Task.aggregate([
    { $match: { assignees: { $in: memberIds }, status: { $nin: ["Done", "Backlog"] } } },
    { $unwind: "$assignees" },
    { $match: { assignees: { $in: memberIds } } },
    { $group: { _id: "$assignees", openTasks: { $sum: 1 } } },
  ]);

  const taskMap = Object.fromEntries(agg.map((a) => [a._id.toString(), a.openTasks]));

  const result = members
    .map((m) => ({
      id:        m._id,
      name:      m.name,
      role:      m.role,
      openTasks: taskMap[m._id.toString()] ?? 0,
    }))
    .sort((a, b) => b.openTasks - a.openTasks)
    .slice(0, 7);

  res.json(result);
}

// ── GET /api/manager/projects ─────────────────────────────────────────────────
export async function getProjects(req, res) {
  const { orgId } = req.user;
  const { search = "", status = "", priority = "", sort = "createdAt_desc" } = req.query;

  const org = await Organization.findOne(orgFilterMgr(orgId), "_id orgId").lean();
  if (!org) return res.json([]);

  const ids = [org._id.toString()];
  if (org.orgId) ids.push(org.orgId);
  const orgQuery = ids.length === 1
    ? { orgId: ids[0] }
    : { $or: ids.map((id) => ({ orgId: id })) };

  const projectFilter = { ...orgQuery, isDeleted: { $ne: true } };
  if (status)   projectFilter.status   = status;
  if (priority) projectFilter.priority = priority;
  if (search)   projectFilter.title    = { $regex: search, $options: "i" };

  const sortMap = {
    createdAt_desc: { createdAt: -1 },
    createdAt_asc:  { createdAt:  1 },
    deadline_asc:   { deadline:   1 },
    title_asc:      { title:      1 },
  };
  const sortOpt = sortMap[sort] ?? { createdAt: -1 };

  const projects = await Project.find(projectFilter)
    .populate("director",  "name email avatarSeed role")
    .populate("managerId", "name email avatarSeed role")
    .populate("members",   "name email avatarSeed role")
    .sort(sortOpt)
    .lean();

  if (projects.length === 0) return res.json([]);

  const projectIds = projects.map((p) => p._id);

  const now = new Date();
  const [milestoneAgg, healthMap] = await Promise.all([
    Milestone.aggregate([
      { $match: { projectId: { $in: projectIds } } },
      { $group: { _id: { projectId: "$projectId", status: "$status" }, count: { $sum: 1 } } },
    ]),
    healthForProjects(projects, now), // computed health + task counts by status (D-077)
  ]);
  const taskMap = Object.fromEntries([...healthMap].map(([pid, h]) => [pid, h.byStatus]));

  const msMap = {};
  for (const row of milestoneAgg) {
    const pid = row._id.projectId?.toString();
    if (!pid) continue;
    if (!msMap[pid]) msMap[pid] = { total: 0, completed: 0 };
    msMap[pid].total += row.count;
    if (row._id.status === "Completed") msMap[pid].completed += row.count;
  }

  res.json(projects.map((p) => {
    const pid = p._id.toString();
    const tc  = taskMap[pid] ?? {};
    const ms  = msMap[pid]   ?? { total: 0, completed: 0 };
    const total = Object.values(tc).reduce((s, n) => s + n, 0);
    const done  = tc["Done"] ?? 0;
    const health = healthMap.get(pid);
    return {
      id:              p._id,
      title:           p.title,
      description:     p.description     ?? "",
      category:        p.category        ?? "Other",
      status:          p.status,
      priority:        p.priority        ?? "Medium",
      clientName:      p.clientName      ?? "",
      startDate:       p.startDate       ?? null,
      deadline:        p.deadline        ?? null,
      xpPool:          p.xpPool          ?? 0,
      healthScore:     health.score,   // computed on read, never stored (D-077)
      healthBand:      health.band,
      riskLevel:       p.riskLevel       ?? "Low",
      techStack:       p.techStack       ?? [],
      visibility:      p.visibility      ?? "team_only",
      managerId:       p.managerId?._id  ?? null,
      managerName:     p.managerId?.name ?? "Unassigned",
      directorId:      p.director?._id   ?? null,
      directorName:    p.director?.name  ?? "Unassigned",
      members:         p.members         ?? [],
      milestones:      ms,
      completion:      total > 0 ? Math.round((done / total) * 100) : 0,
      taskCounts: {
        backlog:    tc["Backlog"]     ?? 0,
        todo:       tc["To-Do"]       ?? 0,
        inProgress: tc["In-Progress"] ?? 0,
        inReview:   tc["In-Review"]   ?? 0,
        done,
        total,
      },
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }));
}

// ── GET /api/manager/projects/:id/tasks ───────────────────────────────────────
export async function getProjectTasks(req, res) {
  const { id } = req.params;
  const { orgId } = req.user;

  const { milestoneId } = req.query;
  const taskFilter = { projectId: id, orgId };
  if (milestoneId) taskFilter.milestoneId = milestoneId;

  const tasks = await Task.find(taskFilter)
    .populate("assignees", "name role")
    .populate("assignee",  "name role")
    .populate("createdBy",  "name")
    .sort({ createdAt: -1 })
    .lean();

  res.json(tasks.map((t) => ({
    id:          t._id,
    title:       t.title,
    description: t.description ?? "",
    type:        t.type,
    priority:    t.priority,
    status:      t.status,
    xpValue:     t.xpValue,
    deadline:    t.deadline,
    milestoneId: t.milestoneId ?? null,
    labels:      t.labels ?? [],
    assignee:    t.assignee  ? { id: t.assignee._id,  name: t.assignee.name,  role: t.assignee.role  } : null,
    assignees:   (t.assignees ?? []).map((a) => ({ id: a._id, name: a.name, role: a.role })),
    createdBy:   t.createdBy?.name ?? "—",
  })));
}

// ── POST /api/manager/projects ────────────────────────────────────────────────
// Accepts multipart/form-data (because of file attachments).
// Array/object fields must be JSON-stringified when sent via FormData.
export async function createProject(req, res) {
  const { orgId, id: userId } = req.user;

  const title              = req.body.title              ?? "";
  const description        = req.body.description        ?? "";
  const businessContext    = req.body.businessContext    ?? "";
  const operationalNotes   = req.body.operationalNotes   ?? "";
  const category           = req.body.category           ?? "Other";
  const clientName         = req.body.clientName         ?? "";
  const internalRef        = req.body.internalRef        ?? "";
  const startDate          = req.body.startDate          ?? "";
  const deadline           = req.body.deadline           ?? "";
  const xpPool             = req.body.xpPool             ?? "0";
  const riskLevel          = req.body.riskLevel          ?? "Low";
  const visibility         = req.body.visibility         ?? "team_only";
  const workingHoursPerDay = req.body.workingHoursPerDay ?? "7";

  let techStack         = [];
  let memberIds         = [];
  let milestonesPayload = [];
  try { techStack         = JSON.parse(req.body.techStack  || "[]"); } catch {}
  try { memberIds         = JSON.parse(req.body.memberIds  || "[]"); } catch {}
  try { milestonesPayload = JSON.parse(req.body.milestones || "[]"); } catch {}

  // U-1 (D-130): description and module names have limits too.
  const tooLong = firstLengthError([["Description", description, "description"],
    ...(Array.isArray(milestonesPayload) ? milestonesPayload : []).map((m) => ["Module name", m?.title, "name"])]);
  if (tooLong) return res.status(400).json({ error: tooLong });
  const lateMod = (Array.isArray(milestonesPayload) ? milestonesPayload : []).find((m) => m?.dueDate && deadline && (Number.isNaN(+new Date(m.dueDate)) || new Date(m.dueDate) > new Date(deadline)));
  if (lateMod) return res.status(400).json({ error: "A module deadline cannot be after the project deadline.", fields: { modules: "A module deadline cannot be after the project deadline." } });
  // U-1 (D-132, D-016): each module brings its own Team Lead; the project-level Team Lead defaults to the first one.
  const modTL = (Array.isArray(milestonesPayload) ? milestonesPayload : []).map((m) => String(m?.teamLeadId ?? "")).filter((x) => /^[0-9a-f]{24}$/i.test(x));
  const projectTL = req.body.teamLeadId || modTL[0];
  // M-2: same rules as the wizard (title, priority, dates, Team Lead required).
  const { errors, value: valid } = validateProjectInput({
    title, priority: req.body.priority ?? "Medium", startDate, deadline, teamLeadId: projectTL,
    techStack, workingHoursPerDay,
  }, { mode: "create" });
  if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], fields: errors });

  const org = await Organization.findOne(orgFilterMgr(orgId), "_id orgId").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });

  // Members and the Team Lead must be people of this org (never Director/Manager).
  const wanted = [...new Set([...(Array.isArray(memberIds) ? memberIds : []), valid.teamLeadId, ...modTL].map(String))].filter((x) => /^[0-9a-f]{24}$/i.test(x));
  const people = await User.find({ _id: { $in: wanted }, orgId, status: { $ne: "deleted" }, role: { $nin: ["Director", "Manager"] } }, "_id role").lean();
  const isTL = (id) => people.some((u) => String(u._id) === String(id) && u.role === "Team Lead");
  if (!isTL(valid.teamLeadId) || !modTL.every(isTL))
    return res.status(400).json({ error: "Choose a Team Lead from your organisation.", fields: { teamLeadId: "Choose a Team Lead from your organisation." } });
  memberIds = people.map((u) => u._id);

  const director = await User.findOne({ orgId, role: "Director" }, "_id").lean();

  // Map uploaded files to attachment metadata
  const attachments = (req.files ?? []).map((f) => ({
    name:       f.originalname,
    filename:   f.filename,
    filePath:   `/uploads/attachments/${f.filename}`,
    size:       f.size,
    mimetype:   f.mimetype,
    uploadedBy: userId,
  }));

  const project = await Project.create({
    title:              valid.title,
    description,
    businessContext,
    operationalNotes,
    category,
    clientName:         clientName.trim(),
    internalRef:        internalRef.trim(),
    status:             "Planning",
    priority:           valid.priority,
    startDate:          valid.startDate,
    deadline:           valid.deadline,
    xpPool:             Number(xpPool)             || 0,
    healthScore:        100,
    riskLevel,
    workingHoursPerDay: Number(workingHoursPerDay) || 7,
    techStack:          valid.techStack ?? [],
    visibility,
    managerId:          userId,
    director:           director?._id ?? null,
    orgId:              org._id.toString(),
    members:            Array.isArray(memberIds) ? memberIds : [],
    attachments,
  });

  if (milestonesPayload.length > 0) {
    const docs = milestonesPayload.map((ms, i) => ({
      title:         (ms.title ?? "").trim() || `Phase ${i + 1}`,
      description:   (ms.description ?? "").trim(),
      projectId:     project._id,
      orgId:         org._id.toString(),
      startDate:     ms.startDate ? new Date(ms.startDate) : null,
      dueDate:       (ms.endDate || ms.dueDate) ? new Date(ms.endDate || ms.dueDate) : null,
      endDate:       (ms.endDate || ms.dueDate) ? new Date(ms.endDate || ms.dueDate) : null,
      teamLeadId:    /^[0-9a-f]{24}$/i.test(String(ms.teamLeadId ?? "")) ? ms.teamLeadId : null,
      deliverables:  Array.isArray(ms.deliverables) ? ms.deliverables : [],
      activeRoles:   Array.isArray(ms.activeRoles)  ? ms.activeRoles  : [],
      assignedTeams: Array.isArray(ms.assignedTeams)? ms.assignedTeams: [],
      order:         i,
      createdBy:     userId,
    }));
    const made = await Milestone.insertMany(docs, { ordered: false }).catch(() => []);
    for (const m of made) if (m.teamLeadId) createNotification({ userId: m.teamLeadId, orgId: req.user.orgId, type: "project_module_assigned", title: "New module for you",
      message: `You lead "${m.title}" in "${project.title}"${m.dueDate ? `, due ${m.dueDate.toDateString()}` : ""}.`, meta: { projectId: project._id, milestoneId: m._id } }).catch(() => {});
  }

  AuditLog.create({
    action:          "project_created",
    orgId:           org._id,
    performedBy:     userId,
    targetProjectId: project._id,
    projectTitle:    project.title,
    detail:          `Project "${project.title}" created with ${milestonesPayload.length} phase(s) and ${attachments.length} attachment(s).`,
  }).catch(() => {});

  // Auto-create Project Community + default groups (idempotent)
  const memberOids  = Array.isArray(project.members) ? project.members : [];
  const adminOids   = [userId];
  const projSlug    = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  (async () => {
    try {
      // Find or create the community for this project
      let community = await ChatCommunity.findOne({ orgId: org._id, projectId: project._id });
      if (!community) {
        community = await ChatCommunity.create({
          orgId:      org._id,
          name:       project.title,
          description: `Collaboration space for ${project.title}`,
          icon:        "📁",
          type:        "project",
          projectId:  project._id,
          createdBy:  userId,
          adminIds:   adminOids,
          memberIds:  [...new Set([userId, ...memberOids.map(String)])],
        });
      }

      // Default groups: announcements + general (others can be created by manager/team lead)
      const defaultGroups = [
        { name: `${projSlug}-announcements`, icon: "📢", type: "announcement",
          permissions: { sendMessages: "admins", editInfo: "admins", addMembers: "admins" }, isDefault: true },
        { name: `${projSlug}-general`,       icon: "💬", type: "project",
          permissions: { sendMessages: "everyone", editInfo: "admins", addMembers: "admins" } },
      ];
      await Promise.all(defaultGroups.map((def) =>
        ChatChannel.findOneAndUpdate(
          { orgId: org._id, communityId: community._id, name: def.name },
          { $setOnInsert: {
            orgId:       org._id,
            communityId: community._id,
            name:        def.name,
            icon:        def.icon,
            type:        def.type,
            description: def.name.endsWith("-announcements") ? `Announcements for ${project.title}` : `General discussion — ${project.title}`,
            projectId:   project._id,
            memberIds:   [...new Set([userId, ...memberOids.map(String)])],
            adminIds:    adminOids,
            permissions: def.permissions,
            isDefault:   def.isDefault ?? false,
            createdBy:   userId,
          }},
          { upsert: true, new: true }
        )
      ));
    } catch (e) {
      console.error("[ProjectCommunity]", e.message);
    }
  })();

  res.status(201).json({
    id:                  project._id,
    title:               project.title,
    description:         project.description,
    category:            project.category,
    status:              project.status,
    priority:            project.priority,
    clientName:          project.clientName,
    internalRef:         project.internalRef,
    startDate:           project.startDate,
    deadline:            project.deadline,
    xpPool:              project.xpPool,
    healthScore:         project.healthScore,
    riskLevel:           project.riskLevel,
    techStack:           project.techStack,
    visibility:          project.visibility,
    workingHoursPerDay:  project.workingHoursPerDay,
    milestones:          { total: milestonesPayload.length, completed: 0 },
    attachments:         attachments.length,
    completion:          0,
    taskCounts:          { backlog: 0, todo: 0, inProgress: 0, inReview: 0, done: 0, total: 0 },
    members:             memberIds,
    createdAt:           project.createdAt,
  });
}

// ── GET /api/manager/team-full ────────────────────────────────────────────────
export async function getTeamFull(req, res) {
  const { orgId } = req.user;

  const members = await User.find(
    { orgId, status: { $ne: "deleted" } },
    "name email role department status avatarSeed"
  )
    .sort({ role: 1, name: 1 })
    .lean();

  const memberIds = members.map((m) => m._id);

  const [profiles, taskAgg] = await Promise.all([
    GamificationProfile.find({ userId: { $in: memberIds } }, "userId level currentXp maxXp hp streak badges").lean(),
    Task.aggregate([
      { $match: { assignees: { $in: memberIds } } },
      { $unwind: "$assignees" },
      { $match: { assignees: { $in: memberIds } } },
      { $group: {
          _id:        "$assignees",
          open:       { $sum: { $cond: [{ $in: ["$status", ["Backlog", "To-Do", "In-Progress", "In-Review"]] }, 1, 0] } },
          inProgress: { $sum: { $cond: [{ $eq:  ["$status", "In-Progress"] }, 1, 0] } },
          done:       { $sum: { $cond: [{ $eq:  ["$status", "Done"]        }, 1, 0] } },
          overdue:    { $sum: { $cond: [{ $and: [{ $lt: ["$deadline", new Date()] }, { $ne: ["$status", "Done"] }, { $ne: ["$deadline", null] }] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const profileMap = Object.fromEntries(profiles.map((p) => [p.userId.toString(), p]));
  const taskMap    = Object.fromEntries(taskAgg.map((t) => [t._id.toString(), t]));

  res.json(members.map((m) => {
    const p  = profileMap[m._id.toString()] ?? {};
    const t  = taskMap[m._id.toString()]    ?? {};
    return {
      id:         m._id,
      name:       m.name,
      email:      m.email,
      role:       m.role,
      department: m.department ?? "",
      status:     m.status,
      avatarSeed: m.avatarSeed ?? m.name,
      level:      p.level      ?? 1,
      currentXp:  p.currentXp  ?? 0,
      maxXp:      p.maxXp      ?? 1000,
      hp:         p.hp         ?? 100,
      streak:     p.streak     ?? 0,
      badgeCount: (p.badges ?? []).length,
      tasks: {
        open:       t.open       ?? 0,
        inProgress: t.inProgress ?? 0,
        done:       t.done       ?? 0,
        overdue:    t.overdue    ?? 0,
      },
    };
  }));
}

// ── GET /api/manager/timeline ─────────────────────────────────────────────────
// Returns tasks with deadlines for the Gantt/Timeline view.
// Query: ?mode=project|assignee   (default: project)
//        ?weeks=N                 (default: 8)
export async function getTimeline(req, res) {
  const { orgId } = req.user;
  const weeks = Math.min(52, Math.max(1, parseInt(req.query.weeks ?? "8", 10)));

  const since = new Date();
  since.setDate(since.getDate() - 7);            // 1 week back
  const until = new Date();
  until.setDate(until.getDate() + weeks * 7);   // N weeks forward

  const tasks = await Task.find({
    orgId,
    deadline: { $gte: since, $lte: until },
  })
    .populate("assignees",  "name role")
    .populate("projectId",  "title")
    .sort({ deadline: 1 })
    .lean();

  // Group by project
  const byProject = {};
  for (const t of tasks) {
    const key   = t.projectId ? String(t.projectId._id) : "__none__";
    const label = t.projectId?.title ?? "No Project";
    if (!byProject[key]) byProject[key] = { id: key, label, tasks: [] };
    byProject[key].tasks.push({
      id:        t._id,
      title:     t.title,
      type:      t.type,
      priority:  t.priority,
      status:    t.status,
      xpValue:   t.xpValue,
      deadline:  t.deadline,
      assignees: (t.assignees ?? []).map((a) => ({ id: a._id, name: a.name, role: a.role })),
    });
  }

  res.json({
    since:    since.toISOString(),
    until:    until.toISOString(),
    weeks,
    groups:   Object.values(byProject),
  });
}

// ── GET /api/manager/workforce ────────────────────────────────────────────────
export async function getWorkforce(req, res) {
  const { orgId } = req.user;
  const now = new Date();
  const weekAgo = new Date(now - 7 * 86_400_000);

  // Resolve org for project queries
  const [org, members] = await Promise.all([ // one round instead of two (D-078)
    Organization.findOne(orgFilterMgr(orgId), "_id orgId").lean(),
    User.find({ orgId, status: { $ne: "deleted" } }, "name email role department status avatarSeed joinedAt").lean(),
  ]);
  const orgIds = org ? [org._id.toString(), ...(org.orgId ? [org.orgId] : [])] : [orgId];
  const projectOrgFilter = orgIds.length === 1
    ? { orgId: orgIds[0] }
    : { $or: orgIds.map((id) => ({ orgId: id })) };

  const memberIds = members.map((m) => m._id);

  const [openTasks, doneCounts, weeklyDone, profiles, projectAssignments, workloadSnapshots] = await Promise.all([
    Task.find({
      orgId,
      assignees: { $in: memberIds },
      status:    { $nin: ["Done"] },
    }, "title status priority deadline assignees").lean(),

    Task.aggregate([
      { $match: { orgId, assignees: { $in: memberIds }, status: "Done" } },
      { $unwind: "$assignees" },
      { $group: { _id: "$assignees", count: { $sum: 1 } } },
    ]),

    Task.aggregate([
      { $match: { orgId, assignees: { $in: memberIds }, status: "Done", updatedAt: { $gte: weekAgo } } },
      { $unwind: "$assignees" },
      { $group: { _id: "$assignees", count: { $sum: 1 } } },
    ]),

    GamificationProfile.find(
      { userId: { $in: memberIds } },
      "userId level currentXp maxXp hp currentStreak badges"
    ).lean(),

    Project.find(
      { ...projectOrgFilter, members: { $in: memberIds }, status: { $nin: ["Archived"] } },
      "title status members"
    ).lean(),

    getBulkWorkloadSnapshots(memberIds),
  ]);

  const doneMap    = Object.fromEntries(doneCounts.map((r) => [String(r._id), r.count]));
  const weeklyMap  = Object.fromEntries(weeklyDone.map((r) => [String(r._id), r.count]));
  const profileMap = Object.fromEntries(profiles.map((p) => [String(p.userId), p]));

  // Phase 7: workload engine snapshots (hours-based capacity), loaded in the parallel round above
  const workloadMap = Object.fromEntries(workloadSnapshots.map((s) => [String(s.userId), s]));

  // Build per-member project list
  const projectsByMember = {};
  for (const p of projectAssignments) {
    for (const mid of (p.members ?? [])) {
      const key = String(mid);
      if (!projectsByMember[key]) projectsByMember[key] = [];
      projectsByMember[key].push({ id: p._id, title: p.title, status: p.status });
    }
  }

  // Build per-member task buckets
  const taskBuckets = {};
  for (const t of openTasks) {
    for (const aid of (t.assignees ?? [])) {
      const key = String(aid);
      if (!taskBuckets[key]) taskBuckets[key] = { inProgress: 0, overdue: 0, dueToday: 0, blocked: 0, total: 0, list: [] };
      taskBuckets[key].total++;
      if (t.status === "In-Progress") taskBuckets[key].inProgress++;
      if (t.status === "Blocked")     taskBuckets[key].blocked++;
      if (t.deadline) {
        if (new Date(t.deadline) < now)         taskBuckets[key].overdue++;
        else if (new Date(t.deadline) - now < 86_400_000) taskBuckets[key].dueToday++;
      }
      if (taskBuckets[key].list.length < 4) {
        taskBuckets[key].list.push({ id: t._id, title: t.title, status: t.status, priority: t.priority, deadline: t.deadline ?? null });
      }
    }
  }

  const result = members.map((m) => {
    const uid    = String(m._id);
    const gp     = profileMap[uid] ?? {};
    const bucket = taskBuckets[uid] ?? { inProgress: 0, overdue: 0, dueToday: 0, blocked: 0, total: 0, list: [] };
    const hp     = gp.hp ?? 100;
    const projs  = projectsByMember[uid] ?? [];

    // Phase 7: use workload engine data if available
    const wl       = workloadMap[uid];
    const allocated = wl?.allocatedHours ?? null;
    const available = wl?.availableHours ?? null;
    const utilization = wl?.utilisation
      ?? Math.min(100, Math.round((bucket.inProgress / 5) * 100));
    const workloadTier  = wl?.workloadTier  ?? null;
    const workloadColor = wl?.workloadColor ?? null;
    const burnoutRiskLabel = wl?.burnoutRisk ?? null;

    let availability;
    if (workloadTier === "Critical Overload" || bucket.inProgress >= 4 || hp < 30 || bucket.overdue >= 3) availability = "Overloaded";
    else if (workloadTier === "Busy" || bucket.inProgress >= 2 || hp < 60 || bucket.overdue >= 1) availability = "Busy";
    else availability = "Available";

    // Burnout risk 0-100
    const burnoutRisk = Math.min(100, Math.round(
      (bucket.overdue / 3) * 50 + ((100 - hp) / 100) * 30 + (utilization / 100) * 20
    ));

    return {
      id:          uid,
      name:        m.name,
      email:       m.email,
      role:        m.role,
      department:  m.department ?? null,
      status:      m.status,
      avatarSeed:  m.avatarSeed ?? m.name,
      level:       gp.level        ?? 1,
      currentXp:   gp.currentXp    ?? 0,
      maxXp:       gp.maxXp        ?? 1000,
      hp,
      streak:      gp.currentStreak ?? 0,
      availability,
      utilization,
      // Phase 7: workload engine fields
      allocatedHours:  allocated,
      availableHours:  available,
      workloadTier,
      workloadColor,
      burnoutRiskLabel,
      burnoutRisk,
      projects: projs,
      tasks: {
        total:      bucket.total,
        inProgress: bucket.inProgress,
        overdue:    bucket.overdue,
        dueToday:   bucket.dueToday,
        blocked:    bucket.blocked,
        done:       doneMap[uid] ?? 0,
        weeklyDone: weeklyMap[uid] ?? 0,
        list:       bucket.list,
      },
    };
  });

  const ORDER = { Overloaded: 0, Busy: 1, Available: 2 };
  result.sort((a, b) => ORDER[a.availability] - ORDER[b.availability]);

  const counts = result.reduce((acc, m) => {
    acc[m.availability] = (acc[m.availability] ?? 0) + 1;
    return acc;
  }, {});

  res.json({
    members: result,
    total:   result.length,
    counts:  {
      available:  counts.Available  ?? 0,
      busy:       counts.Busy       ?? 0,
      overloaded: counts.Overloaded ?? 0,
      burnoutRisk: result.filter((m) => m.burnoutRisk >= 60).length,
    },
    // Phase 7: workload engine summary
    workloadSummary: {
      avgUtilisation: result.length
        ? Math.round(result.reduce((s, m) => s + m.utilization, 0) / result.length) : 0,
      critical:  result.filter((m) => m.workloadTier === "Critical Overload").length,
      high:      result.filter((m) => m.workloadTier === "Busy").length,
      moderate:  result.filter((m) => m.workloadTier === "Moderate Load").length,
      free:      result.filter((m) => m.workloadTier === "Free").length,
      burnoutRiskCount: result.filter((m) => ["High", "Critical"].includes(m.burnoutRiskLabel)).length,
    },
  });
}

// ── GET /api/manager/team-availability ────────────────────────────────────────
export async function getTeamAvailability(req, res) {
  const { orgId } = req.user;
  const now       = new Date();
  const todayEnd  = new Date(now); todayEnd.setHours(23, 59, 59, 999);

  // All active org members
  const members = await User.find(
    { orgId, status: { $ne: "deleted" } },
    "name email role department status avatarSeed"
  ).lean();

  const memberIds = members.map((m) => m._id);

  // Load open tasks for each member (not Done)
  const openTasks = await Task.find({
    orgId,
    assignees: { $in: memberIds },
    status:    { $nin: ["Done"] },
  }, "title status priority deadline assignees").lean();

  // Load gamification profiles
  const profiles = await GamificationProfile.find(
    { userId: { $in: memberIds } },
    "userId level currentXp maxXp hp currentStreak"
  ).lean();

  const profileMap = {};
  for (const p of profiles) profileMap[String(p.userId)] = p;

  // 4.2a: one formula — the workload engine's tiers (same as Workforce / TL pages)
  const snapshots = await getBulkWorkloadSnapshots(memberIds);
  const snapMap   = Object.fromEntries(snapshots.map((s) => [String(s.userId), s]));

  // Build per-member task buckets
  const taskBuckets = {};
  for (const t of openTasks) {
    for (const aid of (t.assignees ?? [])) {
      const key = String(aid);
      if (!taskBuckets[key]) taskBuckets[key] = { inProgress: 0, overdue: 0, dueToday: 0, total: 0, tasks: [] };
      taskBuckets[key].total++;
      if (t.status === "In-Progress") taskBuckets[key].inProgress++;
      if (t.deadline) {
        if (new Date(t.deadline) < now)         taskBuckets[key].overdue++;
        else if (new Date(t.deadline) <= todayEnd) taskBuckets[key].dueToday++;
      }
      taskBuckets[key].tasks.push({
        id:       t._id,
        title:    t.title,
        status:   t.status,
        priority: t.priority,
        deadline: t.deadline ?? null,
      });
    }
  }

  const result = members.map((m) => {
    const uid    = String(m._id);
    const gp     = profileMap[uid] ?? {};
    const bucket = taskBuckets[uid] ?? { inProgress: 0, overdue: 0, dueToday: 0, total: 0, tasks: [] };
    const hp     = gp.hp ?? 100;

    const snap         = snapMap[uid];
    const availability = availabilityFor({ workloadTier: snap?.workloadTier ?? "Free", hp });
    // Capacity % used today (engine utilisation, capped for the bar)
    const capacityScore = Math.min(100, snap?.utilisation ?? 0);

    return {
      id:           uid,
      name:         m.name,
      email:        m.email,
      role:         m.role,
      department:   m.department ?? null,
      status:       m.status,
      avatarSeed:   m.avatarSeed ?? m.name,
      level:        gp.level        ?? 1,
      currentXp:    gp.currentXp    ?? 0,
      maxXp:        gp.maxXp        ?? 1000,
      hp,
      streak:       gp.currentStreak ?? 0,
      availability,
      capacityScore,
      workloadTier: snap?.workloadTier ?? null,
      utilisation:  snap?.utilisation  ?? 0,
      tasks: {
        total:      bucket.total,
        inProgress: bucket.inProgress,
        overdue:    bucket.overdue,
        dueToday:   bucket.dueToday,
        list:       bucket.tasks.slice(0, 5),
      },
    };
  });

  // Sort: Overloaded first, then Busy, then Available
  const ORDER = { Overloaded: 0, Busy: 1, Available: 2 };
  result.sort((a, b) => ORDER[a.availability] - ORDER[b.availability]);

  const counts = result.reduce(
    (acc, m) => { acc[m.availability] = (acc[m.availability] ?? 0) + 1; return acc; },
    {}
  );

  res.json({
    members: result,
    total:   result.length,
    counts:  { available: counts.Available ?? 0, busy: counts.Busy ?? 0, overloaded: counts.Overloaded ?? 0 },
  });
}

// ── GET /api/manager/project-timeline ─────────────────────────────────────────
export async function getProjectTimeline(req, res) {
  const { orgId } = req.user;
  const months = Math.min(12, Math.max(1, parseInt(req.query.months ?? "3", 10)));
  const now    = new Date();

  const org    = await Organization.findOne(orgFilterMgr(orgId), "_id orgId").lean();
  const orgIds = org ? [org._id.toString(), ...(org.orgId ? [org.orgId] : [])] : [orgId];
  const pFilter = orgIds.length === 1
    ? { orgId: orgIds[0], status: { $ne: "Archived" } }
    : { $and: [{ $or: orgIds.map((id) => ({ orgId: id })) }, { status: { $ne: "Archived" } }] };

  const projects = await Project.find(pFilter)
    .select("title status priority riskLevel healthScore startDate deadline")
    .lean();

  const rangeStart = new Date(now); rangeStart.setMonth(rangeStart.getMonth() - 1);
  const rangeEnd   = new Date(now); rangeEnd.setMonth(rangeEnd.getMonth() + months);

  if (projects.length === 0) {
    return res.json({ since: rangeStart.toISOString(), until: rangeEnd.toISOString(), projects: [] });
  }

  const projectIds = projects.map((p) => p._id);

  const [milestones, taskCounts] = await Promise.all([
    Milestone.find({ projectId: { $in: projectIds } })
      .select("title projectId startDate dueDate endDate status progress")
      .lean(),
    Task.aggregate([
      { $match: { projectId: { $in: projectIds } } },
      { $group: {
          _id:   "$projectId",
          total: { $sum: 1 },
          done:  { $sum: { $cond: [{ $eq: ["$status", "Done"] }, 1, 0] } },
      }},
    ]),
  ]);

  const taskMap    = Object.fromEntries(taskCounts.map((t) => [t._id.toString(), t]));
  const msByProj   = {};
  for (const ms of milestones) {
    const key = ms.projectId.toString();
    if (!msByProj[key]) msByProj[key] = [];
    msByProj[key].push(ms);
  }

  // Compute timeline bounds
  let since = rangeStart, until = rangeEnd;
  for (const p of projects) {
    if (p.startDate && new Date(p.startDate) < since) since = new Date(p.startDate);
    if (p.deadline  && new Date(p.deadline)  > until) until = new Date(p.deadline);
  }

  res.json({
    since:    since.toISOString(),
    until:    until.toISOString(),
    months,
    projects: projects.map((p) => {
      const tc       = taskMap[p._id.toString()] ?? { total: 0, done: 0 };
      const progress = tc.total > 0 ? Math.round((tc.done / tc.total) * 100) : 0;
      const isDelayed = p.deadline && new Date(p.deadline) < now
                        && !["Completed", "Archived"].includes(p.status);
      return {
        id:          p._id,
        title:       p.title,
        status:      p.status,
        priority:    p.priority,
        riskLevel:   p.riskLevel,
        healthScore: p.healthScore,
        startDate:   p.startDate,
        deadline:    p.deadline,
        progress,
        isDelayed:   !!isDelayed,
        milestones:  (msByProj[p._id.toString()] ?? []).map((ms) => {
          const endDate = ms.endDate ?? ms.dueDate;
          return {
            id:        ms._id,
            title:     ms.title,
            startDate: ms.startDate,
            endDate,
            status:    ms.status,
            progress:  ms.progress ?? 0,
            isDelayed: !!(endDate && new Date(endDate) < now && ms.status !== "Completed"),
          };
        }),
      };
    }),
  });
}

// ── GET /api/manager/reports ──────────────────────────────────────────────────
export async function getReports(req, res) {
  const { orgId } = req.user;
  const now           = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 86_400_000);

  const org    = await Organization.findOne(orgFilterMgr(orgId), "_id orgId").lean();
  const orgIds = org ? [org._id.toString(), ...(org.orgId ? [org.orgId] : [])] : [orgId];
  const pFilter = orgIds.length === 1
    ? { orgId: orgIds[0] }
    : { $or: orgIds.map((id) => ({ orgId: id })) };

  const [members, projects] = await Promise.all([
    User.find({ orgId, status: "active" }, "_id name role department avatarSeed").lean(),
    Project.find(pFilter).select("title status priority riskLevel healthScore deadline startDate").lean(),
  ]);

  const memberIds  = members.map((m) => m._id);
  const projectIds = projects.map((p) => p._id);

  const [msArr, taskAgg, completedRecent, profiles] = await Promise.all([
    Milestone.find({ projectId: { $in: projectIds } }).select("status endDate dueDate").lean(),
    Task.aggregate([
      { $match: { assignees: { $in: memberIds } } },
      { $unwind: "$assignees" },
      { $match: { assignees: { $in: memberIds } } },
      { $group: {
          _id:        "$assignees",
          total:      { $sum: 1 },
          done:       { $sum: { $cond: [{ $eq:  ["$status", "Done"] },        1, 0] } },
          inProgress: { $sum: { $cond: [{ $eq:  ["$status", "In-Progress"] }, 1, 0] } },
          overdue:    { $sum: { $cond: [{ $and: [
            { $lt: ["$deadline", now] },
            { $ne: ["$status",   "Done"] },
            { $ne: ["$deadline", null]  },
          ]}, 1, 0] } },
      }},
    ]),
    Task.countDocuments({ assignees: { $in: memberIds }, status: "Done", updatedAt: { $gte: thirtyDaysAgo } }),
    GamificationProfile.find({ orgId }, "userId level currentXp maxXp hp currentStreak").lean(),
  ]);

  // ── Project stats ──
  const byStatus = {}, byPriority = {};
  let delayed = 0, highRiskCount = 0;
  for (const p of projects) {
    byStatus[p.status]     = (byStatus[p.status]     ?? 0) + 1;
    byPriority[p.priority] = (byPriority[p.priority] ?? 0) + 1;
    if (p.deadline && new Date(p.deadline) < now && !["Completed","Archived"].includes(p.status)) delayed++;
    if (["High","Critical"].includes(p.riskLevel)) highRiskCount++;
  }
  const completed   = byStatus["Completed"] ?? 0;
  const total       = projects.length;
  const active      = (byStatus["Active"] ?? 0) + (byStatus["In Review"] ?? 0);
  const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  // ── Milestone stats ──
  const msCompleted      = msArr.filter((m) => m.status === "Completed").length;
  const msDelayed        = msArr.filter((m) =>
    (m.endDate ?? m.dueDate) && new Date(m.endDate ?? m.dueDate) < now && m.status !== "Completed"
  ).length;
  const msCompletionRate = msArr.length > 0 ? Math.round((msCompleted / msArr.length) * 100) : 0;

  // ── Employee stats ──
  const profileMap = Object.fromEntries(profiles.map((p) => [p.userId.toString(), p]));
  const taskMap    = Object.fromEntries(taskAgg.map((t) => [t._id.toString(), t]));

  const employeeStats = members.map((m) => {
    const uid = m._id.toString();
    const gp  = profileMap[uid] ?? {};
    const t   = taskMap[uid]    ?? {};
    const hp  = gp.hp ?? 100;
    const completionRate = (t.total ?? 0) > 0 ? Math.round(((t.done ?? 0) / t.total) * 100) : 0;
    const utilization    = Math.min(100, Math.round(((t.inProgress ?? 0) / 5) * 100));
    const burnoutRisk    = Math.min(100, Math.round(
      ((t.overdue ?? 0) / 3) * 50 + ((100 - hp) / 100) * 30 + ((t.inProgress ?? 0) / 5) * 20
    ));
    return {
      id: uid, name: m.name, role: m.role,
      department:  m.department  ?? "",
      avatarSeed:  m.avatarSeed  ?? m.name,
      level:       gp.level      ?? 1,
      completionRate, utilization, burnoutRisk,
      tasks: {
        total:      t.total      ?? 0,
        done:       t.done       ?? 0,
        inProgress: t.inProgress ?? 0,
        overdue:    t.overdue    ?? 0,
      },
    };
  });

  const overloaded    = employeeStats.filter((e) => e.utilization >= 80).length;
  const avgCompletion = Math.round(employeeStats.reduce((s, e) => s + e.completionRate, 0) / (employeeStats.length || 1));
  const topPerformers = [...employeeStats].sort((a, b) => b.completionRate - a.completionRate).slice(0, 6);
  const burnoutRisks  = [...employeeStats].filter((e) => e.burnoutRisk >= 40)
    .sort((a, b) => b.burnoutRisk - a.burnoutRisk).slice(0, 5);

  res.json({
    projectStats: {
      total, active, completed, delayed,
      onHold:          byStatus["On Hold"]  ?? 0,
      planning:        byStatus["Planning"] ?? 0,
      highRisk:        highRiskCount,
      successRate,     completedRecent,
      byStatus:        Object.entries(byStatus).map(([status, count])     => ({ status, count })),
      byPriority:      Object.entries(byPriority).map(([priority, count]) => ({ priority, count })),
    },
    milestoneStats: {
      total:          msArr.length,
      completed:      msCompleted,
      delayed:        msDelayed,
      completionRate: msCompletionRate,
    },
    employeeStats: {
      total: members.length, overloaded, avgCompletion,
      topPerformers, burnoutRisks, all: employeeStats,
    },
  });
}

// ── GET /api/manager/activity-feed ────────────────────────────────────────────
export async function getActivityFeed(req, res) {
  const { orgId } = req.user;
  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit ?? "25", 10)));

  const org = await Organization.findOne(orgFilterMgr(orgId), "_id").lean();
  if (!org) return res.json([]);

  const logs = await AuditLog.find({ orgId: org._id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  res.json(
    logs.map((l) => ({
      id:           l._id,
      action:       l.action,
      detail:       l.detail,
      projectTitle: l.projectTitle ?? null,
      projectId:    l.targetProjectId ?? null,
      oldRole:      l.oldRole ?? null,
      newRole:      l.newRole ?? null,
      createdAt:    l.createdAt,
    }))
  );
}
