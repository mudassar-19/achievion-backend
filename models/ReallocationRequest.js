import { Schema, model, Types } from "mongoose";

// QA4 Y-7 (D-QA4-3): the Manager does not reassign. They ask the module's Team Lead ("reallocation") or remind them ("nudge").
// The Team Lead accepts (by doing the reassign, requestId) or declines with a reason. One request or nudge per task per 24 hours.
const reallocationRequestSchema = new Schema({
  orgId:      { type: String, required: true, index: true },
  kind:       { type: String, enum: ["reallocation", "nudge"], default: "reallocation" },
  status:     { type: String, enum: ["pending", "accepted", "declined"], default: "pending", index: true },
  taskId:     { type: Types.ObjectId, ref: "Task", required: true },
  projectId:  { type: Types.ObjectId, ref: "Project", required: true },
  milestoneId:{ type: Types.ObjectId, ref: "Milestone", default: null },
  fromUserId: { type: Types.ObjectId, ref: "User", default: null },   // the current assignee when it was asked
  suggestedUserId: { type: Types.ObjectId, ref: "User", default: null },
  requestedBy:{ type: Types.ObjectId, ref: "User", required: true },
  teamLeadId: { type: Types.ObjectId, ref: "User", required: true },
  reason:     { type: String, default: "", maxlength: 1000 },
  declineReason: { type: String, default: null, maxlength: 1000 },
  decidedAt:  { type: Date, default: null },
}, { timestamps: true });
reallocationRequestSchema.index({ taskId: 1, requestedBy: 1, createdAt: -1 });
reallocationRequestSchema.index({ teamLeadId: 1, status: 1, createdAt: -1 });
export default model("ReallocationRequest", reallocationRequestSchema);
