import Approval      from "../models/Approval.js";
import Notification  from "../models/Notification.js";
import User          from "../models/User.js";
import Organization  from "../models/Organization.js";
import Task          from "../models/Task.js";
import AuditLog      from "../models/AuditLog.js";
import { getIo }     from "../utils/io.js";

// ── Human-readable label per action type ─────────────────────────────────────
function actionLabel(actionType, payload, target) {
  const name = target?.name ?? payload?.name ?? "employee";
  switch (actionType) {
    case "CREATE_EMPLOYEE":     return `Create account for ${payload?.name ?? "new employee"} (${payload?.role ?? ""})`;
    case "DELETE_EMPLOYEE":     return `Delete ${name}`;
    case "SUSPEND_EMPLOYEE":    return `Suspend ${name}`;
    case "REACTIVATE_EMPLOYEE": return `Reactivate ${name}`;
    case "ROLE_CHANGE":         return `Role change for ${name}: ${payload?.oldRole} → ${payload?.newRole}`;
    default:                    return actionType;
  }
}

// ── createApprovalRequest ─────────────────────────────────────────────────────
// Creates a PENDING approval record, notifies the org's Director via DB
// notification and socket event.
export async function createApprovalRequest({
  orgId,
  actionType,
  requestedBy,
  targetEmployeeId = null,
  payload,
}) {
  // Persist the approval; SUSPEND_EMPLOYEE approvals expire in 72h
  const expiresAt = actionType === "SUSPEND_EMPLOYEE"
    ? new Date(Date.now() + 72 * 60 * 60 * 1000)
    : null;

  const approval = await Approval.create({
    orgId,
    actionType,
    requestedBy,
    targetEmployeeId,
    payload,
    status: "PENDING",
    expiresAt,
  });

  // Locate the Director for this org
  const director = await User.findOne({ orgId, role: "Director" }).lean();

  if (director) {
    // Persist in-app notification for the Director
    await Notification.create({
      userId:  director._id,
      orgId:   String(orgId),
      type:    "approval_required",
      message: `New ${actionType} request pending your approval`,
      meta:    { approvalId: approval._id },
    });

    // Real-time push via Socket.IO
    const io = getIo();
    if (io) {
      io.to(`user:${director._id}`).emit("approval:new", {
        approvalId:  approval._id,
        actionType,
        description: actionLabel(actionType, payload, null),
      });
    }
  }

  return approval;
}

// ── executeApproval ───────────────────────────────────────────────────────────
// Carries out the action encoded in the approval record, marks it APPROVED,
// and notifies the original requester.
export async function executeApproval(approvalId, approverId = null) {
  const approval = await Approval.findById(approvalId);
  if (!approval) {
    const err = new Error("Approval not found.");
    err.status = 404;
    throw err;
  }

  if (approval.status !== "PENDING") {
    const err = new Error("Approval has already been resolved.");
    err.status = 409;
    throw err;
  }

  if (approverId && approval.requestedBy &&
      String(approval.requestedBy) === String(approverId)) {
    const err = new Error("You cannot approve a request you created (four-eyes rule).");
    err.status  = 403;
    err.expose  = true;
    throw err;
  }

  const { actionType, targetEmployeeId, payload, orgId } = approval;
  let result = null;

  switch (actionType) {
    case "CREATE_EMPLOYEE":
      // payload: { name, email, password (pre-hashed), role, orgId (string) }
      result = await User.create({
        name:     payload.name,
        email:    payload.email,
        password: payload.password,
        role:     payload.role,
        orgId:    payload.orgId,        // string e.g. "ORG-XXXXXX"
      });
      // Add to org members array
      await Organization.updateOne(
        { orgId: payload.orgId },
        { $addToSet: { members: result._id } }
      );
      break;

    case "DELETE_EMPLOYEE":
      result = await User.findByIdAndDelete(targetEmployeeId);
      break;

    case "SUSPEND_EMPLOYEE": {
      if (payload?.emergency) {
        // Emergency: user already suspended by org admin — just confirm
        result = await User.findById(targetEmployeeId).lean();
        await AuditLog.create({
          orgId, action: "member_suspend_confirmed",
          performedBy: approverId ?? orgId, targetUserId: targetEmployeeId,
          detail: "Emergency suspension confirmed by Director",
          scope: "account",
        }).catch(() => {});
      } else {
        result = await User.findByIdAndUpdate(
          targetEmployeeId,
          { status: "suspended", $inc: { tokenVersion: 1 } },
          { returnDocument: "after" }
        );
        // Move orphan tasks to Backlog
        const orphanCount = await Task.countDocuments({
          assignees: targetEmployeeId,
          status:    { $in: ["To-Do", "In-Progress", "In-Review"] },
        });
        if (orphanCount > 0) {
          await Task.updateMany(
            { assignees: targetEmployeeId, status: { $in: ["To-Do", "In-Progress", "In-Review"] } },
            { $pull: { assignees: targetEmployeeId }, $set: { status: "Backlog", workloadWarning: false } }
          );
          const manager = await User.findOne({ orgId: result?.orgId ?? orgId, role: "Manager" });
          if (manager) {
            await Notification.create({
              userId:  manager._id,
              orgId:   String(orgId),
              type:    "system",
              message: `${orphanCount} task(s) moved to Backlog — ${result?.name ?? "employee"} was suspended. Please reassign.`,
            });
          }
        }
      }
      break;
    }

    case "REACTIVATE_EMPLOYEE":
      result = await User.findByIdAndUpdate(
        targetEmployeeId,
        { status: "active" },
        { returnDocument: "after" }
      );
      break;

    case "ROLE_CHANGE":
      result = await User.findByIdAndUpdate(
        targetEmployeeId,
        { role: payload.newRole },
        { returnDocument: "after" }
      );
      break;

    case "TASK_ASSIGNMENT":
      await Task.findByIdAndUpdate(payload.taskId, { status: "To-Do" });
      await Notification.create({
        userId:  payload.assigneeId,
        orgId:   String(orgId),
        type:    "task_assigned",
        message: `Task "${payload.taskTitle}" has been assigned to you`,
        meta:    { taskId: payload.taskId },
      });
      result = { taskId: payload.taskId };
      break;

    default: {
      const err = new Error(`Unknown actionType: ${actionType}`);
      err.status = 400;
      throw err;
    }
  }

  // Write audit log for employee-affecting actions
  const auditMap = {
    CREATE_EMPLOYEE:     { action: "employee_created",      newRole:   payload?.role },
    DELETE_EMPLOYEE:     { action: "account_deleted" },
    SUSPEND_EMPLOYEE:    { action: "account_status_change", newStatus: "suspended" },
    REACTIVATE_EMPLOYEE: { action: "account_status_change", newStatus: "active" },
    ROLE_CHANGE:         { action: "role_change",           oldRole:   payload?.oldRole, newRole: payload?.newRole },
  };
  const auditEntry = auditMap[actionType];
  if (auditEntry) {
    await AuditLog.create({
      ...auditEntry,
      orgId:        orgId,
      targetUserId: targetEmployeeId ?? (actionType === "CREATE_EMPLOYEE" ? result?._id : null),
      performedBy:  approverId ?? orgId,
    }).catch(() => {}); // non-fatal — don't block the approval
  }

  // Mark approval as resolved
  approval.status     = "APPROVED";
  approval.resolvedAt = new Date();
  if (approverId) approval.resolvedBy = approverId;
  await approval.save();

  // Mark the Director's approval_required notification for this request as read
  await Notification.updateMany(
    { "meta.approvalId": approval._id, type: "approval_required", read: false },
    { $set: { read: true } }
  );

  // Notify the org admin via org room
  const resolvedApproval = await Approval.findById(approvalId)
    .populate("targetEmployeeId", "name")
    .lean();

  await Notification.create({
    userId:  approval.requestedBy,
    orgId:   String(orgId),
    type:    "approval_result",
    message: "Your request has been approved",
    meta:    { approvalId: approval._id, actionType },
  });

  const io = getIo();
  if (io) {
    io.to(`org:${orgId}`).emit("approval:resolved", {
      approvalId:   approval._id,
      status:       "APPROVED",
      actionType,
      description:  actionLabel(actionType, approval.payload, resolvedApproval?.targetEmployeeId),
    });
  }

  return result;
}

// ── rejectApproval ────────────────────────────────────────────────────────────
// Marks the approval as REJECTED and notifies the requester with the reason.
export async function rejectApproval(approvalId, rejectionReason = null, approverId = null) {
  const approval = await Approval.findById(approvalId);
  if (!approval) {
    const err = new Error("Approval not found.");
    err.status = 404;
    throw err;
  }

  if (approval.status !== "PENDING") {
    const err = new Error("Approval has already been resolved.");
    err.status = 409;
    throw err;
  }

  // Emergency suspend revert: restore user to active
  if (approval.actionType === "SUSPEND_EMPLOYEE" && approval.payload?.emergency) {
    await User.findByIdAndUpdate(
      approval.targetEmployeeId,
      { status: "active", $inc: { tokenVersion: 1 } }
    );
    await AuditLog.create({
      orgId: approval.orgId, action: "member_suspend_reverted",
      performedBy: approverId ?? approval.orgId, targetUserId: approval.targetEmployeeId,
      detail: "Emergency suspension reverted by Director — user restored to active",
      scope: "account",
    }).catch(() => {});
  }

  approval.status          = "REJECTED";
  approval.rejectionReason = rejectionReason ?? null;
  approval.resolvedAt      = new Date();
  if (approverId) approval.resolvedBy = approverId;
  await approval.save();

  // Mark the Director's approval_required notification for this request as read
  await Notification.updateMany(
    { "meta.approvalId": approval._id, type: "approval_required", read: false },
    { $set: { read: true } }
  );

  const reason  = rejectionReason ? `: ${rejectionReason}` : "";
  const message = `Your request was rejected${reason}`;

  await Notification.create({
    userId:  approval.requestedBy,
    orgId:   String(approval.orgId),
    type:    "approval_result",
    message,
    meta:    { approvalId: approval._id, actionType: approval.actionType },
  });

  const io = getIo();
  if (io) {
    io.to(`org:${approval.orgId}`).emit("approval:resolved", {
      approvalId:      approval._id,
      status:          "REJECTED",
      actionType:      approval.actionType,
      description:     actionLabel(approval.actionType, approval.payload, null),
      rejectionReason: rejectionReason ?? null,
    });
  }

  return approval;
}
