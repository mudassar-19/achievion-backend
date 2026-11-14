import { createHash }          from "crypto";
import { Schema, model, Types } from "mongoose";

const auditLogSchema = new Schema(
  {
    action: {
      type:     String,
      required: [true, "Action is required"],
      enum:     [
        // ── Employee & HR ───────────────────────────────────────────────────
        "role_change", "account_status_change", "account_deleted",
        "employee_created", "DIRECTOR_CREATED", "DIRECTOR_SETUP",
        // ── Organization ────────────────────────────────────────────────────
        "ORG_CREATED", "workspace_updated", "settings_updated", "GAMIFICATION_RESET",
        // ── Project lifecycle ────────────────────────────────────────────────
        "project_created", "project_updated",
        "project_xp_updated", "project_status_changed",
        "project_frozen", "project_unfrozen", "project_deleted",
        "project_archived", "project_restored", "project_member_added", "project_member_removed", "module_lead_assigned",
        "sprint_created", "sprint_started", "sprint_closed", "sprint_updated", "sprint_deleted", "sprint_tasks_changed",
        "resubmission_allowed", "resubmission_declined",
        "task_reassigned", "workload_threshold_changed", "asset_created", "asset_updated", "asset_deleted",
        "quest_created", "quest_updated", "quest_deleted", "quest_published", "quest_ended", "quest_completed", "quest_repeated", "quest_joined",
        // ── Batch 5: departments, member department, logo ──
        "department_created", "department_renamed", "department_archived", "department_restored", "member_department_changed", "org_logo_updated", "org_logo_removed",
        "flag_raised", "flag_dismissed", "flag_reopened", "flag_confirmed",
        // ── Manager Reports (M-6) ──
        "lesson_created", "lesson_updated", "lesson_deleted", "report_exported",
        // ── Slice 3b: Extensions ─────────────────────────────────────────────
        "extension_requested", "extension_approved", "extension_rejected", "extension_counter_proposed",
        // ── Slice 3b: Sessions ───────────────────────────────────────────────
        "session_revoked",
        // ── Slice 3b: Voice ──────────────────────────────────────────────────
        "voice_report_created", "voice_report_escalated", "voice_report_closed",
        // ── Slice 3b: Risks ──────────────────────────────────────────────────
        "risk_created", "risk_closed", "risk_escalated", "risk_updated",
        // ── Slice 3d/3e: Goals, Recaps, Reports ─────────────────────────────
        "goal_created", "goal_updated", "goal_achieved",
        "recap_generated",
        "report_exported",
        // ── Slice 3f Part C ──────────────────────────────────────────────────
        "portfolio_view_saved", "portfolio_view_updated", "portfolio_view_deleted",
        "member_suspend_initiated", "member_suspend_confirmed", "member_suspend_flagged",
        // ── V2 Phase 1: XP ledger (X7) ──────────────────────────────────────
        "xp_awarded", "xp_adjusted",
        // ── V2 Phase 2: communities / groups admin actions (D-074) ─────────
        "community_created", "community_updated", "community_archived", "community_restored",
        "community_member_added", "community_member_removed",
        "group_created", "group_updated", "group_member_added", "group_member_removed",
        "group_admin_added", "group_admin_removed", "group_poster_added", "group_poster_removed",
        "group_request_approved", "group_request_rejected", "group_join_approved", "group_join_rejected",
        "chat_message_removed", "chat_message_pinned", "chat_message_unpinned",
        // ── V2 Phase 3 · M-8: View as (D-109) ──
        "view_as_started", "view_as_ended", "view_as_blocked",
        // ── V2 Phase 4 · T-1: Team Lead modules (D-115) ──
        "module_accepted", "module_qa_ready", "breakdown_applied",
        "task_review_approved", "task_conditional_approved", "task_review_revision", "task_qa_signoff",
        // ── IMPL-5 Part 4: Custom roles ──────────────────────────────────────
        "custom_role_added", "custom_role_updated", "custom_role_deactivated", "user_role_label_set",
        // ── IMPL-5 Part 5: Asset booking ─────────────────────────────────────
        "asset_booked", "asset_booking_cancelled",
      ],
      trim: true,
    },

    orgId:           { type: Types.ObjectId, ref: "Organization",  default: null },
    targetUserId:    { type: Types.ObjectId, ref: "User",          default: null },
    targetProjectId: { type: Types.ObjectId, ref: "Project",       default: null },

    // User _id, org ObjectId, or "ORG-XXXXXXXX" string that performed the action.
    performedBy: { type: Schema.Types.Mixed, required: true },

    // Human-readable description of what changed.
    detail:    { type: String, default: null },

    // Role-change fields
    oldRole:   { type: String, default: null },
    newRole:   { type: String, default: null },

    // Status-change field
    newStatus: { type: String, default: null },

    // Stored at log time so project name is preserved after deletion
    projectTitle: { type: String, default: null },

    // ── Slice 3a new fields (non-breaking, default null — D-022a) ─────────────
    before:     { type: Schema.Types.Mixed, default: null },
    after:      { type: Schema.Types.Mixed, default: null },
    ip:         { type: String, default: null },
    device:     { type: String, default: null },
    scope:      { type: String, enum: ["org","project","account","settings","voice","risk","goal","report","extension","session","chat"], default: "org" },
    actionHash: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

// Combined pre-save: guard existing docs (append-only) + compute actionHash on new docs
auditLogSchema.pre("save", async function() {
  if (!this.isNew) throw new Error("AuditLog is append-only");
  if (!this.actionHash) {
    this.actionHash = createHash("sha256")
      .update(this._id.toString() + Date.now())
      .digest("hex")
      .slice(0, 6);
  }
});
// Query-level: blocks Model.updateOne/updateMany/replaceOne/findOneAnd* /deleteOne/deleteMany
// Also covers doc.updateOne() and doc.deleteOne() because those delegate to the query layer.
auditLogSchema.pre("updateOne",          function() { throw new Error("AuditLog is append-only"); });
auditLogSchema.pre("updateMany",         function() { throw new Error("AuditLog is append-only"); });
auditLogSchema.pre("replaceOne",         function() { throw new Error("AuditLog is append-only"); });
auditLogSchema.pre("findOneAndUpdate",   function() { throw new Error("AuditLog is append-only"); });
auditLogSchema.pre("findOneAndReplace",  function() { throw new Error("AuditLog is append-only"); });
auditLogSchema.pre("findOneAndDelete",   function() { throw new Error("AuditLog is append-only"); });
auditLogSchema.pre("deleteOne",          function() { throw new Error("AuditLog is append-only"); });
auditLogSchema.pre("deleteMany",         function() { throw new Error("AuditLog is append-only"); });
// Document-level hooks (defense-in-depth; query-level hooks above already cover doc.updateOne/deleteOne
// because they delegate to Model.updateOne/deleteOne internally in Mongoose 9).
auditLogSchema.pre("updateOne", { document: true, query: false }, function() { throw new Error("AuditLog is append-only"); });
auditLogSchema.pre("deleteOne", { document: true, query: false }, function() { throw new Error("AuditLog is append-only"); });
// ponytail: Model.collection.bulkWrite and Model.collection.insertMany bypass Mongoose hooks
// entirely and cannot be blocked here. Avoid both in application code; insertMany (via AuditLog.create)
// is safe because it only inserts new documents.

auditLogSchema.index({ orgId: 1, createdAt: -1 });
auditLogSchema.index({ performedBy: 1, createdAt: -1 });
auditLogSchema.index({ targetUserId: 1 });
auditLogSchema.index({ targetProjectId: 1 });

export default model("AuditLog", auditLogSchema);
