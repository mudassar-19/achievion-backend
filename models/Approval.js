import { Schema, model, Types } from "mongoose";

const approvalSchema = new Schema(
  {
    orgId: {
      type:     Types.ObjectId,
      ref:      "Organization",
      required: true,
      index:    true,
    },

    actionType: {
      type:     String,
      enum:     ["CREATE_EMPLOYEE", "DELETE_EMPLOYEE", "SUSPEND_EMPLOYEE", "REACTIVATE_EMPLOYEE", "ROLE_CHANGE", "TASK_ASSIGNMENT"],
      required: true,
    },

    requestedBy: {
      type:     Types.ObjectId,
      ref:      "User",
      required: true,
    },

    targetEmployeeId: {
      type:    Types.ObjectId,
      ref:     "User",
      default: null,
    },

    status: {
      type:    String,
      enum:    ["PENDING", "APPROVED", "REJECTED", "VOID"],
      default: "PENDING",
      index:   true,
    },

    // Stores action-specific data: name, email, role, reason, newRole, etc.
    payload: {
      type:     Schema.Types.Mixed,
      required: true,
    },

    rejectionReason: {
      type:    String,
      default: null,
    },

    resolvedAt: {
      type:    Date,
      default: null,
    },

    resolvedBy: {
      type:    Types.ObjectId,
      ref:     "User",
      default: null,
    },

    // Set by createApprovalRequest for SUSPEND_EMPLOYEE; cron flags after window
    expiresAt:    { type: Date,    default: null },
    staleFlagged: { type: Boolean, default: false },
  },
  { timestamps: true }
);

approvalSchema.index({ orgId: 1, status: 1, createdAt: -1 });

export default model("Approval", approvalSchema);
