import { Schema, model, Types } from "mongoose";

// Extension request lifecycle:
//   Manager submits → pending → Director approves/rejects/counter-proposes
//   OR auto-applied if the org's extension rules allow it (threshold check).

const extensionRequestSchema = new Schema(
  {
    orgId:      { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    taskId:     { type: Types.ObjectId, ref: "Task",         default: null }, // null = project deadline (M-2)
    projectId:  { type: Types.ObjectId, ref: "Project",      default: null },
    requestedBy: { type: Types.ObjectId, ref: "User",        required: true },

    reason:           { type: String, required: true, trim: true },
    originalDeadline: { type: Date,   default: null },
    requestedDays:    { type: Number, required: true, min: 1, max: 365 },

    status: {
      type:    String,
      enum:    ["pending", "approved", "rejected", "counter_proposed", "auto_applied"],
      default: "pending",
      index:   true,
    },

    // Director decision fields
    decidedBy:         { type: Types.ObjectId, ref: "User", default: null },
    decidedAt:         { type: Date,   default: null },
    directorNote:      { type: String, default: null },
    counterDays:       { type: Number, default: null },  // counter-propose: N days instead

    autoApplied: { type: Boolean, default: false },

    // Notification sent flag (avoids double-notify)
    notified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

extensionRequestSchema.index({ taskId: 1 });
extensionRequestSchema.index({ requestedBy: 1, createdAt: -1 });

export default model("ExtensionRequest", extensionRequestSchema);
