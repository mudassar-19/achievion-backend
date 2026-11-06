import { Schema, model, Types } from "mongoose";

const milestoneSchema = new Schema(
  {
    title:       { type: String, required: [true, "Milestone title is required"], trim: true },
    description: { type: String, default: "" },
    notes:       { type: String, default: "" },

    projectId: { type: Types.ObjectId, ref: "Project", required: true, index: true },
    orgId:     { type: String, required: true, index: true },

    status: {
      type:    String,
      enum:    ["Pending", "In Progress", "Delayed", "Completed"],
      default: "Pending",
    },

    startDate:   { type: Date, default: null },
    dueDate:     { type: Date, default: null },
    endDate:     { type: Date, default: null },
    completedAt: { type: Date, default: null },

    progress: { type: Number, default: 0, min: 0, max: 100 },

    deliverables:  { type: [String], default: [] },
    activeRoles:   { type: [String], default: [] },
    assignedTeams: [{ type: Types.ObjectId, ref: "Team" }],
    teamLeadId:    { type: Types.ObjectId, ref: "User", default: null }, // M-2: one Team Lead per module
    tlAcceptedAt:  { type: Date, default: null },                         // T-1: the Team Lead accepted the module (D-115)
    qaReadyAt:     { type: Date, default: null },                         // T-2: the Team Lead marked it ready for QA sign-off (D-122)

    createdBy: { type: Types.ObjectId, ref: "User", default: null },
    order:     { type: Number, default: 0 },
  },
  { timestamps: true }
);

milestoneSchema.index({ projectId: 1, order: 1 });
milestoneSchema.index({ orgId: 1, status: 1 });

export default model("Milestone", milestoneSchema);
