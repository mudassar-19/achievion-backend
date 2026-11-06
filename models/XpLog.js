import { Schema, model, Types } from "mongoose";

const xpLogSchema = new Schema(
  {
    userId: {
      type:     Types.ObjectId,
      ref:      "User",
      required: [true, "XpLog must reference a user"],
    },

    orgId: { type: Types.ObjectId, ref: "Organization", default: null, index: true },

    amount: {
      type:     Number,
      required: [true, "XP amount is required"],
    },

    source: {
      type:     String,
      required: true,
      trim:     true,
      enum:     [
        "task_approved", "task_accepted", "task_rejected", "badge", "manual", "streak_bonus",
        // Team Lead leadership sources
        "tl_milestone_delivered", "tl_milestone_on_time",
        "tl_sprint_completed",    "tl_sprint_on_time",
        "tl_sprint_high_completion", "tl_sprint_perfect",
        "tl_review_efficiency",   "tl_team_stability",
        "tl_delivery_consistency",
        // M-5: challenge reward, and the negative row written when a Manager confirms an anomaly
        "quest", "flag_reversal",
        // T-6: the +5 given to whoever assigned a 5-star task (it had no ledger row before, D-148)
        "assigner_bonus",
      ],
    },

    // ── Optional task-event metadata ─────────────────────────────────────────
    taskId:         { type: Types.ObjectId, ref: "Task",   default: null },
    qualityScore:   { type: Number,  default: null },
    isLate:         { type: Boolean, default: false },
    warningIssued:  { type: Boolean, default: false },
    penaltyApplied: { type: Boolean, default: false },
    breakdown:      { type: Schema.Types.Mixed, default: null },
    questId:        { type: Types.ObjectId, ref: "Quest",  default: null },
    reversalOf:     { type: Types.ObjectId, ref: "XpLog",  default: null }, // flag_reversal: the award it cancels
    flagId:         { type: Types.ObjectId, default: null },
  },
  { timestamps: true }
);

xpLogSchema.index({ userId: 1, createdAt: -1 });

// Double-award guard (V1 1.2, FR05-08): one task_approved log per user per task.
xpLogSchema.index(
  { userId: 1, taskId: 1, source: 1 },
  { unique: true, partialFilterExpression: { source: "task_approved", taskId: { $type: "objectId" } } }
);
// T-6 (D-148): one review award per Team Lead per task, whichever route approved it.
xpLogSchema.index(
  { taskId: 1, userId: 1, source: 1 },
  { unique: true, partialFilterExpression: { source: "tl_review_efficiency", taskId: { $type: "objectId" } } }
);

// M-5: one quest reward per user per quest; one reversal per original award, ever.
xpLogSchema.index({ userId: 1, questId: 1 }, { unique: true, partialFilterExpression: { source: "quest", questId: { $type: "objectId" } } });
xpLogSchema.index({ reversalOf: 1 }, { unique: true, partialFilterExpression: { reversalOf: { $type: "objectId" } } });

// Append-only ledger (V1 1.3, X7): XP transactions are never edited or removed.
const appendOnly = () => { throw new Error("XpLog is append-only"); };
xpLogSchema.pre("save", function () { if (!this.isNew) appendOnly(); });
for (const op of ["updateOne", "updateMany", "replaceOne", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "deleteOne", "deleteMany"]) {
  xpLogSchema.pre(op, appendOnly);
}
xpLogSchema.pre("updateOne", { document: true, query: false }, appendOnly);
xpLogSchema.pre("deleteOne", { document: true, query: false }, appendOnly);

export default model("XpLog", xpLogSchema);
