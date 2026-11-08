import Team              from "../models/Team.js";
import User              from "../models/User.js";
import Project           from "../models/Project.js";
import Task              from "../models/Task.js";
import Notification      from "../models/Notification.js";
import GamificationProfile from "../models/GamificationProfile.js";
import ChatChannel       from "../models/ChatChannel.js";
import { getIo }         from "../utils/io.js";
import { isEmployee, isTeamMember } from "../services/accessRules.js";

// ── POST /api/teams ────────────────────────────────────────────────────────────
export async function createTeam(req, res) {
  if (!["Manager", "Director"].includes(req.user.role))
    return res.status(403).json({ error: "Only Manager or Director can create teams" });

  const { name, description, department, capacity, teamLeadId } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Team name required" });

  const exists = await Team.findOne({ orgId: req.user.orgId, name: name.trim() });
  if (exists) return res.status(400).json({ error: "Team name already exists in this organization" });

  if (teamLeadId) {
    const tl = await User.findOne({ _id: teamLeadId, orgId: req.user.orgId });
    if (!tl) return res.status(404).json({ error: "Team Lead not found" });
    if (tl.role !== "Team Lead")
      return res.status(400).json({ error: "Assigned user must have Team Lead role" });
  }

  const team = await Team.create({
    orgId:       req.user.orgId,
    name:        name.trim(),
    description: description || "",
    department:  department  || "",
    capacity:    capacity    || 10,
    teamLead:    teamLeadId  || null,
    members:     teamLeadId
      ? [{ userId: teamLeadId, role: "Team Lead", allocation: 100, isActive: true }]
      : [],
  });

  // Auto-create team chat channel
  const channelName = name.toLowerCase().trim().replace(/\s+/g, "-");
  await ChatChannel.findOneAndUpdate(
    { orgId: req.user.orgId, name: channelName },
    {
      $setOnInsert: {
        orgId:      req.user.orgId,
        name:       channelName,
        department: department || "",
        type:       "team",
        createdBy:  req.user._id,
      },
    },
    { upsert: true }
  );

  if (teamLeadId) {
    await Notification.create({
      userId:  teamLeadId,
      orgId:   req.user.orgId,
      type:    "system",
      message: `You have been assigned as Team Lead of "${team.name}"`,
    });
    const io = getIo();
    if (io) io.to(`user:${teamLeadId}`).emit("notification:new", { type: "system" });
  }

  res.status(201).json(team);
}

// ── GET /api/teams ─────────────────────────────────────────────────────────────
export async function getTeams(req, res) {
  const { role, _id: userId, orgId } = req.user;
  const query = { orgId, status: { $ne: "archived" } };

  if (!["Director", "Manager"].includes(role)) {
    query["members.userId"]   = userId;
    query["members.isActive"] = true;
  }

  const teams = await Team.find(query)
    .populate("teamLead", "name role avatarStyle")
    .sort({ createdAt: -1 });

  const enriched = teams.map((t) => ({
    ...t.toObject(),
    memberCount:  t.members.filter((m) => m.isActive).length,
    projectCount: t.projects.length,
  }));

  res.json(enriched);
}

// ── GET /api/teams/:id ─────────────────────────────────────────────────────────
export async function getTeam(req, res) {
  const team = await Team.findById(req.params.id)
    .populate("teamLead", "name role avatarStyle hp currentXp level")
    .populate("members.userId", "name role avatarStyle hp currentXp level department status")
    .populate("projects", "title status");

  if (!team || team.orgId !== req.user.orgId)
    return res.status(404).json({ error: "Team not found" });

  const { role, _id: userId } = req.user;
  if (!["Director", "Manager"].includes(role)) {
    const isMember = team.members.some(
      (m) => m.userId?._id?.toString() === userId?.toString() && m.isActive
    );
    if (!isMember) return res.status(403).json({ error: "Access denied" });
  }

  res.json(team);
}

// ── POST /api/teams/:id/members ────────────────────────────────────────────────
export async function addMember(req, res) {
  if (!["Manager", "Director"].includes(req.user.role))
    return res.status(403).json({ error: "Only Manager or Director can add members" });

  const { userId, allocation = 100 } = req.body;
  const team = await Team.findById(req.params.id);
  if (!team || team.orgId !== req.user.orgId)
    return res.status(404).json({ error: "Team not found" });

  const user = await User.findOne({ _id: userId, orgId: req.user.orgId, status: "active" });
  if (!user) return res.status(404).json({ error: "User not found or not active" });

  const alreadyMember = team.members.some(
    (m) => m.userId.toString() === userId && m.isActive
  );
  if (alreadyMember) return res.status(400).json({ error: "User is already a member of this team" });

  const activeCount = team.members.filter((m) => m.isActive).length;
  if (activeCount >= team.capacity)
    return res.status(400).json({ error: `Team is at capacity (${team.capacity} members)` });

  // Allocation check across all teams
  const allTeams = await Team.find({
    orgId:              req.user.orgId,
    "members.userId":   userId,
    "members.isActive": true,
    status:             "active",
  });
  const totalAlloc = allTeams.reduce((sum, t) => {
    const m = t.members.find((m) => m.userId.toString() === userId && m.isActive);
    return sum + (m?.allocation || 0);
  }, 0);
  if (totalAlloc + allocation > 100)
    return res.status(400).json({
      error: `Adding this member would exceed 100% allocation (currently at ${totalAlloc}%)`,
    });

  team.members.push({ userId, role: user.role, allocation, isActive: true });
  await team.save();

  await Notification.create({
    userId,
    orgId:   req.user.orgId,
    type:    "system",
    message: `You have been added to team "${team.name}"`,
  });
  const io = getIo();
  if (io) io.to(`user:${userId}`).emit("notification:new", { type: "system" });

  res.json({ message: "Member added", team });
}

// ── DELETE /api/teams/:id/members/:userId ──────────────────────────────────────
export async function removeMember(req, res) {
  if (!["Manager", "Director"].includes(req.user.role))
    return res.status(403).json({ error: "Only Manager or Director can remove members" });

  const { id: teamId, userId } = req.params;
  const team = await Team.findById(teamId);
  if (!team || team.orgId !== req.user.orgId)
    return res.status(404).json({ error: "Team not found" });

  const activeTasks = await Task.countDocuments({
    assignees: userId,
    projectId: { $in: team.projects },
    status:    { $in: ["To-Do", "In-Progress", "In-Review"] },
  });
  if (activeTasks > 0)
    return res.status(400).json({
      error: `Cannot remove — user has ${activeTasks} active task(s) in this team's projects. Reassign first.`,
    });

  const memberIdx = team.members.findIndex(
    (m) => m.userId.toString() === userId && m.isActive
  );
  if (memberIdx === -1) return res.status(404).json({ error: "Member not found in team" });

  team.members[memberIdx].isActive = false;

  if (team.teamLead?.toString() === userId) {
    team.teamLead = null;
    const manager = await User.findOne({ orgId: req.user.orgId, role: "Manager" });
    if (manager) {
      await Notification.create({
        userId:  manager._id,
        orgId:   req.user.orgId,
        type:    "system",
        message: `Team Lead removed from "${team.name}". Please assign a new Team Lead.`,
      });
    }
  }
  await team.save();

  res.json({ message: "Member removed" });
}

// ── PATCH /api/teams/:id/lead ──────────────────────────────────────────────────
export async function assignTeamLead(req, res) {
  if (!["Manager", "Director"].includes(req.user.role))
    return res.status(403).json({ error: "Only Manager or Director can assign Team Lead" });

  const { userId } = req.body;
  const team = await Team.findById(req.params.id);
  if (!team || team.orgId !== req.user.orgId)
    return res.status(404).json({ error: "Team not found" });

  const user = await User.findOne({ _id: userId, orgId: req.user.orgId });
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.role !== "Team Lead")
    return res.status(400).json({ error: "User must have Team Lead role" });

  const isMember = team.members.some((m) => m.userId.toString() === userId && m.isActive);
  if (!isMember)
    return res.status(400).json({ error: "User must be a member of this team first" });

  const oldLeadId = team.teamLead;
  team.teamLead = userId;
  await team.save();

  const io = getIo();
  if (oldLeadId && oldLeadId.toString() !== userId) {
    await Notification.create({
      userId:  oldLeadId,
      orgId:   req.user.orgId,
      type:    "system",
      message: `You have been replaced as Team Lead of "${team.name}"`,
    });
  }
  await Notification.create({
    userId,
    orgId:   req.user.orgId,
    type:    "system",
    message: `You are now Team Lead of "${team.name}"`,
  });
  if (io) io.to(`user:${userId}`).emit("notification:new", { type: "system" });

  res.json({ message: "Team Lead assigned", team });
}

// ── GET /api/teams/:id/availability ───────────────────────────────────────────
export async function getTeamAvailability(req, res) {
  const team = await Team.findById(req.params.id).populate(
    "members.userId",
    "name role avatarStyle hp currentXp level"
  );
  if (!team || team.orgId !== req.user.orgId)
    return res.status(404).json({ error: "Team not found" });
  if (isEmployee(req.user) && !isTeamMember(team, req.user.id)) return res.status(403).json({ error: "Access denied" }); // S-1 (D-161)

  const activeMembers = team.members.filter((m) => m.isActive && m.userId);

  const availability = await Promise.all(
    activeMembers.map(async (m) => {
      const user = m.userId;
      const activeTasks = await Task.countDocuments({
        assignees: user._id,
        status:    { $in: ["To-Do", "In-Progress", "In-Review"] },
      });
      const status =
        activeTasks === 0 ? "free"
        : activeTasks <= 2 ? "available"
        : activeTasks <= 4 ? "busy"
        : "overloaded";
      return {
        user: {
          _id:         user._id,
          name:        user.name,
          role:        user.role,
          avatarStyle: user.avatarStyle,
          hp:          user.hp,
        },
        activeTasks,
        allocation: m.allocation,
        status,
      };
    })
  );

  availability.sort((a, b) => b.activeTasks - a.activeTasks);
  res.json(availability);
}

// ── GET /api/teams/:id/analytics ──────────────────────────────────────────────
export async function getTeamAnalytics(req, res) {
  const team = await Team.findById(req.params.id);
  if (!team || team.orgId !== req.user.orgId)
    return res.status(404).json({ error: "Team not found" });
  if (isEmployee(req.user) && !isTeamMember(team, req.user.id)) return res.status(403).json({ error: "Access denied" }); // S-1 (D-161)

  const memberIds = team.members.filter((m) => m.isActive).map((m) => m.userId);

  const [taskStats] = await Task.aggregate([
    { $match: { teamId: team._id, orgId: req.user.orgId } },
    {
      $group: {
        _id:        null,
        total:      { $sum: 1 },
        completed:  { $sum: { $cond: [{ $eq: ["$status", "Done"] }, 1, 0] } },
        onTime:     {
          $sum: {
            $cond: [
              { $and: [{ $eq: ["$status", "Done"] }, { $ne: ["$isLate", true] }] },
              1, 0,
            ],
          },
        },
        avgQuality: { $avg: "$qualityScore" },
      },
    },
  ]);

  const profiles = await GamificationProfile.find({ userId: { $in: memberIds } })
    .select("userId totalXp monthlyXp level")
    .populate("userId", "name role avatarStyle");

  const totalTeamXp = profiles.reduce((s, p) => s + (p.totalXp || 0), 0);

  res.json({
    taskStats:   taskStats || { total: 0, completed: 0, onTime: 0, avgQuality: 0 },
    onTimeRate:
      taskStats?.completed > 0
        ? Math.round((taskStats.onTime / taskStats.completed) * 100)
        : 0,
    totalTeamXp,
    memberProfiles: profiles,
    teamCapacity: {
      current: team.members.filter((m) => m.isActive).length,
      max:     team.capacity,
    },
  });
}

// ── GET /api/teams/:id/leaderboard ────────────────────────────────────────────
export async function getTeamLeaderboard(req, res) {
  const team = await Team.findById(req.params.id);
  if (!team || team.orgId !== req.user.orgId)
    return res.status(404).json({ error: "Team not found" });
  if (isEmployee(req.user) && !isTeamMember(team, req.user.id)) return res.status(403).json({ error: "Access denied" }); // S-1 (D-161)

  const memberIds = team.members.filter((m) => m.isActive).map((m) => m.userId);

  const profiles = await GamificationProfile.find({ userId: { $in: memberIds } })
    .sort({ totalXp: -1 })
    .populate("userId", "name role avatarStyle level");

  const ranked = profiles.map((p, i) => ({
    rank:        i + 1,
    user:        p.userId,
    totalXp:     p.totalXp || 0,
    monthlyXp:   p.monthlyXp || 0,
    level:       p.level || p.userId?.level || 1,
    badgesCount: p.badges?.length || 0,
  }));

  res.json(ranked);
}

// ── PATCH /api/teams/:id ───────────────────────────────────────────────────────
export async function updateTeam(req, res) {
  if (!["Manager", "Director"].includes(req.user.role))
    return res.status(403).json({ error: "Only Manager or Director can update teams" });

  const { name, description, department, capacity, status } = req.body;

  // Build update object — only include defined fields
  const $set = {};
  if (name        !== undefined) $set.name        = name;
  if (description !== undefined) $set.description = description;
  if (department  !== undefined) $set.department  = department;
  if (capacity    !== undefined) $set.capacity    = capacity;
  if (status      !== undefined) $set.status      = status;

  const team = await Team.findOneAndUpdate(
    { _id: req.params.id, orgId: req.user.orgId },
    { $set },
    { returnDocument: "after", runValidators: true }
  );
  if (!team) return res.status(404).json({ error: "Team not found" });
  res.json(team);
}

// ── DELETE /api/teams/:id (archive) ───────────────────────────────────────────
export async function archiveTeam(req, res) {
  if (req.user.role !== "Director")
    return res.status(403).json({ error: "Only Director can archive teams" });

  const team = await Team.findOne({ _id: req.params.id, orgId: req.user.orgId });
  if (!team) return res.status(404).json({ error: "Team not found" });

  const activeProjects = await Project.countDocuments({
    _id:    { $in: team.projects },
    status: { $in: ["Active", "Planning"] },
  });
  if (activeProjects > 0)
    return res.status(400).json({
      error: `Cannot archive — team has ${activeProjects} active project(s). Complete or transfer them first.`,
    });

  team.status   = "archived";
  team.members  = team.members.map((m) => ({ ...m.toObject(), isActive: false }));
  team.teamLead = null;
  await team.save();

  res.json({ message: "Team archived" });
}
