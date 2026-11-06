import { Schema, model, Types } from "mongoose";

// D-022b: Risk — Manager+Director only can create/edit.
// D-022c: AuditLog only on create, close, escalate, and when likelihood/impact/status changes.
// score = likelihood × impact (computed on save).

const riskSchema = new Schema(
  {
    orgId:     { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    projectId: { type: Types.ObjectId, ref: "Project",      default: null },

    title:       { type: String, required: true, trim: true },
    description: { type: String, default: "" },

    category: {
      type:    String,
      enum:    ["technical", "resource", "schedule", "budget", "external", "other"],
      default: "other",
    },

    likelihood: { type: Number, min: 1, max: 5, required: true },
    impact:     { type: Number, min: 1, max: 5, required: true },
    score:      { type: Number, default: 0 },  // computed = likelihood × impact

    status: {
      type:    String,
      enum:    ["open", "mitigated", "closed", "escalated"],
      default: "open",
      index:   true,
    },

    owner:      { type: Types.ObjectId, ref: "User", default: null },
    dueDate:    { type: Date, default: null },
    mitigation: { type: String, default: null },

    escalatedTo:  { type: Types.ObjectId, ref: "User", default: null },
    escalatedAt:  { type: Date, default: null },
    closedAt:     { type: Date, default: null },

    createdBy: { type: Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// Auto-compute score
riskSchema.pre("save", function () {
  this.score = this.likelihood * this.impact;
});

riskSchema.index({ orgId: 1, status: 1, score: -1 });

export default model("Risk", riskSchema);
