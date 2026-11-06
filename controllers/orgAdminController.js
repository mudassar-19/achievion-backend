import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import Organization      from "../models/Organization.js";
import User, { ROLE_CATEGORY_MAP, VALID_ROLES } from "../models/User.js";
import AuditLog          from "../models/AuditLog.js";
import Approval          from "../models/Approval.js";
import Notification      from "../models/Notification.js";
import Task              from "../models/Task.js";
import * as approvalSvc  from "../services/approvalService.js";

// ── Role promotion helper ─────────────────────────────────────────────────────
const ROLE_RANK = {
  "Junior Developer":  1, "Junior Designer":  1, "Junior Tester":  1,
  Developer:           2, Designer:           2, Tester:           2,
  "Senior Developer":  3, "Senior Designer":  3, "Senior Tester":  3,
  "Team Lead":         4,
  Manager:             5,
  Director:            6,
};

function isPromotion(oldRole, newRole) {
  return (ROLE_RANK[newRole] ?? 0) > (ROLE_RANK[oldRole] ?? 0);
}

const SALT_ROUNDS = 10;

// ── Helpers ───────────────────────────────────────────────────────────────────

function clientError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

/** Generate a random 10-char alphanumeric password for new accounts. */
function generatePassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/** Sanitize a User doc for API responses — no password. */
function sanitizeUser(user) {
  return {
    id:           user._id.toString(),
    name:         user.name,
    email:        user.email,
    role:         user.role,
    roleCategory: ROLE_CATEGORY_MAP[user.role] ?? "developer",
    department:   user.department ?? null,
    status:       user.status,
    orgId:        user.orgId,
    level:        user.level,
    currentXp:    user.currentXp,
    maxXp:        user.maxXp,
    gold:         user.gold,
    hp:           user.hp,
    createdAt:    user.createdAt,
  };
}

/** Verify that a user belongs to the requesting org. */
async function resolveOrgEmployee(userId, orgDbId, res) {
  const user = await User.findById(userId);
  if (!user) { clientError(res, 404, "Employee not found."); return null; }
  // user.orgId stores the MongoDB _id string of the org (orgDbId), not the short "ORG-XXX" string
  if (user.orgId !== orgDbId) { clientError(res, 403, "This employee does not belong to your organisation."); return null; }
  if (user.status === "deleted") { clientError(res, 410, "This employee account has been deleted."); return null; }
  return user;
}

// ── GET /api/org/dashboard ────────────────────────────────────────────────────
export async function getDashboard(req, res) {
  const { orgId, orgDbId } = req.org;

  const [org, members] = await Promise.all([
    Organization.findOne({ orgId }),
    // Users store orgId as the org's MongoDB _id string (orgDbId)
    User.find({ orgId: orgDbId, status: { $ne: "deleted" } })
      .select("name email role department status createdAt")
      .sort({ createdAt: -1 }),
  ]);

  if (!org) return clientError(res, 404, "Organisation not found.");

  const totalMembers  = members.length;
  const activeMembers = members.filter((m) => m.status === "active").length;
  const suspendedMembers = members.filter((m) => m.status === "suspended").length;

  // Count per roleCategory
  const membersByRole = {};
  members.forEach((m) => {
    const cat = ROLE_CATEGORY_MAP[m.role] ?? "developer";
    membersByRole[cat] = (membersByRole[cat] ?? 0) + 1;
  });

  const recentMembers = members.slice(0, 5).map(sanitizeUser);

  return res.json({
    success: true,
    data: {
      orgName:          org.name,
      orgId:            org.orgId,
      departments:      org.departments,
      companySize:      org.companySize,
      totalMembers,
      activeMembers,
      suspendedMembers,
      membersByRole,
      recentMembers,
    },
  });
}

// ── POST /api/org/employees/create ────────────────────────────────────────────
export async function createEmployee(req, res) {
  const { orgId, orgDbId } = req.org;
  const { name, email, role = "Developer", department } = req.body ?? {};

  // Validation
  if (!name?.trim() || !email?.trim()) {
    return clientError(res, 400, "name and email are required.");
  }
  if (!/\S+@\S+\.\S+/.test(email)) {
    return clientError(res, 400, "Enter a valid email address.");
  }
  if (!VALID_ROLES.includes(role)) {
    return clientError(res, 400, `role must be one of: ${VALID_ROLES.join(", ")}.`);
  }

  // Verify org exists
  const org = await Organization.findOne({ orgId });
  if (!org) return clientError(res, 404, "Organisation not found.");

  const normalizedEmail = email.toLowerCase().trim();

  // Email uniqueness within the same org — check both active users and pending approvals
  const [existingUser, existingPending] = await Promise.all([
    User.findOne({ email: normalizedEmail, orgId: orgDbId }),
    Approval.findOne({
      orgId:      org._id,
      actionType: "CREATE_EMPLOYEE",
      status:     "PENDING",
      "payload.email": normalizedEmail,
    }),
  ]);
  if (existingUser)    return clientError(res, 400, "Email already used in this organisation.");
  if (existingPending) return clientError(res, 400, "An approval request for this email is already pending.");

  // Hash a generated password so it is ready for the Director to approve + create
  const plainPassword  = generatePassword();
  const hashedPassword = await bcrypt.hash(plainPassword, SALT_ROUNDS);

  await approvalSvc.createApprovalRequest({
    orgId:            org._id,
    actionType:       "CREATE_EMPLOYEE",
    requestedBy:      new Types.ObjectId(req.org.orgDbId),
    targetEmployeeId: null,
    payload: {
      name:       name.trim(),
      email:      normalizedEmail,
      password:   hashedPassword,
      role,
      department: department?.trim() || null,
      orgId:      orgDbId,
    },
  });

  return res.status(202).json({
    success:  true,
    message:  "Employee creation sent for Director approval",
    data: {
      name,
      email:    normalizedEmail,
      role,
      password: plainPassword,
    },
  });
}

// ── GET /api/org/employees ────────────────────────────────────────────────────
export async function listEmployees(req, res) {
  const { orgId, orgDbId } = req.org;
  const {
    role, department, status, search,
    page = 1, limit = 10,
  } = req.query;

  // When filtering to pending_approval only, skip the User query entirely
  const filteringPendingOnly = status === "pending_approval";
  const showPendingApprovals = !status || status === "" || status === "pending_approval";

  const query = { orgId: orgDbId, status: { $ne: "deleted" } };
  if (status && status !== "all" && !filteringPendingOnly) query.status = status;
  if (role)       query.role       = role;
  if (department) query.department = department;
  if (search?.trim()) {
    query.$or = [
      { name:  { $regex: search.trim(), $options: "i" } },
      { email: { $regex: search.trim(), $options: "i" } },
    ];
  }

  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 10));
  const skip     = (pageNum - 1) * limitNum;

  const [employees, total, pendingApprovals, pendingRoleChanges, pendingReactivateApprovals, pendingSuspendApprovals, pendingDeleteApprovals] = await Promise.all([
    filteringPendingOnly
      ? Promise.resolve([])
      : User.find(query)
          .select("name email role department status level currentXp maxXp createdAt")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum),
    filteringPendingOnly
      ? Promise.resolve(0)
      : User.countDocuments(query),
    showPendingApprovals
      ? Approval.find({
          orgId:      new Types.ObjectId(req.org.orgDbId),
          actionType: "CREATE_EMPLOYEE",
          status:     "PENDING",
        }).sort({ createdAt: -1 })
      : Promise.resolve([]),
    Approval.find({
      orgId:      new Types.ObjectId(req.org.orgDbId),
      actionType: "ROLE_CHANGE",
      status:     "PENDING",
    }).select("targetEmployeeId payload"),
    Approval.find({
      orgId:      new Types.ObjectId(req.org.orgDbId),
      actionType: "REACTIVATE_EMPLOYEE",
      status:     "PENDING",
    }).select("targetEmployeeId"),
    Approval.find({
      orgId:      new Types.ObjectId(req.org.orgDbId),
      actionType: "SUSPEND_EMPLOYEE",
      status:     "PENDING",
    }).select("targetEmployeeId"),
    Approval.find({
      orgId:      new Types.ObjectId(req.org.orgDbId),
      actionType: "DELETE_EMPLOYEE",
      status:     "PENDING",
    }).select("targetEmployeeId"),
  ]);

  // Build map: employeeId (string) → pending new role
  const pendingRoleMap = {};
  for (const a of pendingRoleChanges) {
    if (a.targetEmployeeId) {
      pendingRoleMap[a.targetEmployeeId.toString()] = a.payload.newRole;
    }
  }

  // Build set of employee IDs with a pending reactivation request
  const pendingReactivationIds = new Set(
    pendingReactivateApprovals
      .map((a) => a.targetEmployeeId?.toString())
      .filter(Boolean)
  );

  // Build set of employee IDs with a pending suspension request
  const pendingSuspensionIds = new Set(
    pendingSuspendApprovals
      .map((a) => a.targetEmployeeId?.toString())
      .filter(Boolean)
  );

  // Build set of employee IDs with a pending deletion request
  const pendingDeletionIds = new Set(
    pendingDeleteApprovals
      .map((a) => a.targetEmployeeId?.toString())
      .filter(Boolean)
  );

  // Filter pending approvals by role / search if those filters are active
  let filteredPending = pendingApprovals;
  if (role) filteredPending = filteredPending.filter((a) => a.payload.role === role);
  if (search?.trim()) {
    const re = new RegExp(search.trim(), "i");
    filteredPending = filteredPending.filter((a) => re.test(a.payload.name) || re.test(a.payload.email));
  }

  // Shape pending approvals as employee-like objects
  const pendingRows = filteredPending.map((a) => ({
    id:           a._id.toString(),
    name:         a.payload.name,
    email:        a.payload.email,
    role:         a.payload.role,
    roleCategory: ROLE_CATEGORY_MAP[a.payload.role] ?? "developer",
    department:   a.payload.department ?? null,
    status:       "pending_approval",
    orgId:        a.payload.orgId,
    level:        1,
    currentXp:    0,
    maxXp:        100,
    gold:         0,
    hp:           100,
    createdAt:    a.createdAt,
  }));

  const adjustedTotal = total + filteredPending.length;

  return res.json({
    success: true,
    data:    [...pendingRows, ...employees.map((emp) => {
      const s = sanitizeUser(emp);
      const pr = pendingRoleMap[s.id];
      if (pr) s.pendingRole = pr;
      if (pendingReactivationIds.has(s.id)) s.pendingReactivation = true;
      if (pendingSuspensionIds.has(s.id))   s.pendingSuspension   = true;
      if (pendingDeletionIds.has(s.id))     s.pendingDeletion     = true;
      return s;
    })],
    meta: {
      total:      adjustedTotal,
      page:       pageNum,
      limit:      limitNum,
      totalPages: Math.ceil(adjustedTotal / limitNum) || 1,
    },
  });
}
// ── GET /api/org/approvals ──────────────────────────────────────────────
export async function listOrgApprovals(req, res) {
  const { status } = req.query;
  const filter = { orgId: new Types.ObjectId(req.org.orgDbId) };
  if (status && ["PENDING", "APPROVED", "REJECTED"].includes(status.toUpperCase())) {
    filter.status = status.toUpperCase();
  }

  const approvals = await Approval.find(filter)
    .populate("targetEmployeeId", "name email role")
    .sort({ createdAt: -1 });

  return res.json({ success: true, data: approvals });
}
// ── GET /api/org/employees/:userId ────────────────────────────────────────────
export async function getEmployee(req, res) {
  const user = await resolveOrgEmployee(req.params.userId, req.org.orgDbId, res);
  if (!user) return;
  return res.json({ success: true, data: sanitizeUser(user) });
}

// ── PATCH /api/org/employees/:userId/role ─────────────────────────────────────
export async function updateEmployeeRole(req, res) {
  const { role: newRole } = req.body ?? {};

  if (!newRole || !VALID_ROLES.includes(newRole)) {
    return clientError(res, 400, `role must be one of: ${VALID_ROLES.join(", ")}.`);
  }

  const user = await resolveOrgEmployee(req.params.userId, req.org.orgDbId, res);
  if (!user) return;

  // Director role can never be changed
  if (user.role === "Director") {
    return clientError(res, 403, "Director role cannot be changed.");
  }

  const oldRole = user.role;
  if (oldRole === newRole) {
    return clientError(res, 400, "User already has this role.");
  }

  // Any rank change (promotion or demotion) requires Director approval;
  // lateral moves (same rank, different title) are applied directly.
  const oldRank = ROLE_RANK[oldRole] ?? 0;
  const newRank = ROLE_RANK[newRole] ?? 0;

  if (oldRank !== newRank) {
    const org = await Organization.findOne({ orgId: req.org.orgId });
    if (!org) return clientError(res, 404, "Organisation not found.");

    const existingRoleChange = await Approval.findOne({
      orgId:            org._id,
      actionType:       "ROLE_CHANGE",
      status:           "PENDING",
      targetEmployeeId: user._id,
    });
    if (existingRoleChange) {
      return clientError(res, 400, "A role change request for this employee is already pending.");
    }

    await approvalSvc.createApprovalRequest({
      orgId:            org._id,
      actionType:       "ROLE_CHANGE",
      requestedBy:      new Types.ObjectId(req.org.orgDbId),
      targetEmployeeId: user._id,
      payload:          { employeeId: user._id, oldRole, newRole },
    });

    return res.status(202).json({
      success: true,
      message: "Role change request sent for Director approval",
    });
  }

  // Lateral move (same rank) — apply directly
  await User.findByIdAndUpdate(user._id, { role: newRole });
  await AuditLog.create({
    action:       "role_change",
    orgId:        new Types.ObjectId(req.org.orgDbId),
    targetUserId: user._id,
    performedBy:  req.org.orgId,
    oldRole,
    newRole,
  });
  return res.json({ success: true, message: `Role updated to ${newRole}` });
}

// ── PATCH /api/org/employees/:userId/status ───────────────────────────────────
export async function updateEmployeeStatus(req, res) {
  const { status, emergency } = req.body ?? {};

  if (!["active", "suspended"].includes(status)) {
    return clientError(res, 400, 'status must be "active" or "suspended".');
  }

  const user = await resolveOrgEmployee(req.params.userId, req.org.orgDbId, res);
  if (!user) return;

  if (user.status === status) {
    return clientError(res, 400, `User is already ${status}.`);
  }

  // Both suspension and reactivation require Director approval
  const org = await Organization.findOne({ orgId: req.org.orgId });
  if (!org) return clientError(res, 404, "Organisation not found.");

  // ── EMERGENCY SUSPEND: immediate lock + Director confirmation item ─────────
  if (status === "suspended" && emergency === true) {
    if (user.role === "Director") {
      return clientError(res, 403, "Director accounts cannot be emergency-suspended.");
    }
    await User.findByIdAndUpdate(user._id, { status: "suspended", $inc: { tokenVersion: 1 } });
    // Move orphan tasks to Backlog (same as normal suspend)
    const orphanCount = await Task.countDocuments({
      assignees: user._id,
      status:    { $in: ["To-Do", "In-Progress", "In-Review"] },
    });
    if (orphanCount > 0) {
      await Task.updateMany(
        { assignees: user._id, status: { $in: ["To-Do", "In-Progress", "In-Review"] } },
        { $pull: { assignees: user._id }, $set: { status: "Backlog", workloadWarning: false } }
      );
      const manager = await User.findOne({ orgId: String(org._id), role: "Manager" });
      if (manager) {
        await Notification.create({
          userId:  manager._id,
          orgId:   String(org._id),
          type:    "system",
          message: `${orphanCount} task(s) moved to Backlog — ${user.name} was emergency-suspended. Please reassign.`,
        }).catch(() => {});
      }
    }
    // Note: tasks are NOT restored on revert (document as known gap)
    await AuditLog.create({
      orgId:        org._id,
      action:       "member_suspend_initiated",
      performedBy:  req.org.orgDbId,
      targetUserId: user._id,
      detail:       `Emergency suspend by org admin — Director confirmation required (72h). ${orphanCount} task(s) moved to Backlog.`,
      scope:        "account",
    }).catch(() => {});
    await approvalSvc.createApprovalRequest({
      orgId:            org._id,
      actionType:       "SUSPEND_EMPLOYEE",
      requestedBy:      new Types.ObjectId(req.org.orgDbId),
      targetEmployeeId: user._id,
      payload:          { employeeId: user._id, name: user.name, emergency: true },
    });
    return res.status(202).json({
      success: true,
      message: "User suspended immediately. Director has 72h to confirm or revert.",
    });
  }

  const actionType = status === "active" ? "REACTIVATE_EMPLOYEE" : "SUSPEND_EMPLOYEE";
  const label      = status === "active" ? "reactivation"        : "suspension";

  const existingApproval = await Approval.findOne({
    orgId:            org._id,
    actionType,
    status:           "PENDING",
    targetEmployeeId: user._id,
  });
  if (existingApproval) {
    return clientError(res, 400, `A ${label} request for this employee is already pending.`);
  }

  await approvalSvc.createApprovalRequest({
    orgId:            org._id,
    actionType,
    requestedBy:      new Types.ObjectId(req.org.orgDbId),
    targetEmployeeId: user._id,
    payload:          { employeeId: user._id, name: user.name },
  });

  return res.status(202).json({
    success:  true,
    message:  `${label.charAt(0).toUpperCase() + label.slice(1)} request sent for Director approval`,
  });
}

// ── DELETE /api/org/employees/:userId ────────────────────────────────────────
export async function deleteEmployee(req, res) {
  const { orgId, orgDbId } = req.org;

  const user = await resolveOrgEmployee(req.params.userId, orgDbId, res);
  if (!user) return;

  // Suspended employees can be hard-deleted directly (already disabled)
  if (user.status === "suspended") {
    await User.findByIdAndDelete(user._id);
    await Organization.updateOne({ orgId }, { $pull: { members: user._id } });
    await AuditLog.create({
      action:       "account_deleted",
      orgId:        new Types.ObjectId(orgDbId),
      targetUserId: user._id,
      performedBy:  orgId,
    });
    return res.json({ success: true, message: "Suspended employee deleted successfully" });
  }

  // Active employees — send deletion request for Director approval
  const org = await Organization.findOne({ orgId });
  if (!org) return clientError(res, 404, "Organisation not found.");

  const existingDelete = await Approval.findOne({
    orgId:            org._id,
    actionType:       "DELETE_EMPLOYEE",
    status:           "PENDING",
    targetEmployeeId: user._id,
  });
  if (existingDelete) {
    return clientError(res, 400, "A deletion request for this employee is already pending.");
  }

  await approvalSvc.createApprovalRequest({
    orgId:            org._id,
    actionType:       "DELETE_EMPLOYEE",
    requestedBy:      new Types.ObjectId(req.org.orgDbId),
    targetEmployeeId: user._id,
    payload:          { employeeId: user._id, reason: req.body?.reason || "" },
  });

  return res.status(202).json({
    success: true,
    message: "Deletion request sent for Director approval",
  });
}
