import { Schema, model, Types } from "mongoose";

const REQUEST_TYPES = [
  "API Access Required",
  "Client Assets Missing",
  "Dependency Blocked",
  "Review Required",
  "Clarification Needed",
  "Milestone Issue",
  "Technical Blocker",
  "Deployment Concern",
  "Resource Reallocation",
  "Deadline Extension",
  "QA Escalation",
  "Resubmission limit reached", // T-5 (D-142)
  "Other",
];

const requestSchema = new Schema(
  {
    orgId: { type: String, required: true, index: true },

    type: { type: String, enum: REQUEST_TYPES, default: "Other" },

    priority: {
      type:    String,
      enum:    ["Low", "Medium", "High", "Critical"],
      default: "Medium",
      index:   true,
    },

    status: {
      type:    String,
      enum:    ["Pending", "In Progress", "Resolved", "Rejected"],
      default: "Pending",
      index:   true,
    },

    title:       { type: String, required: true, trim: true, maxlength: 200 },
    message:     { type: String, default: "", maxlength: 2000 },
    managerNote: { type: String, default: "", maxlength: 1000 },

    projectId:   { type: Types.ObjectId, ref: "Project",   default: null },
    milestoneId: { type: Types.ObjectId, ref: "Milestone",  default: null },
    requesterId: { type: Types.ObjectId, ref: "User", required: true },
    // T-5 (D-142): the task and attempt count of a resubmission limit request.
    taskId:      { type: Types.ObjectId, ref: "Task", default: null },
    attempts:    { type: Number, default: null },
    resolvedBy:  { type: Types.ObjectId, ref: "User", default: null },
    resolvedAt:  { type: Date, default: null },
  },
  { timestamps: true }
);

requestSchema.index({ orgId: 1, status: 1, createdAt: -1 });
requestSchema.index({ requesterId: 1, createdAt: -1 });

export default model("OperationalRequest", requestSchema);
