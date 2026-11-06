import { Schema, model, Types } from "mongoose";

// VoiceReport: a complaint/concern raised by any employee.
// Routing: complaint against Manager → Director; against Director → escalationContactId.
// VoiceMessage: threaded messages within a report (like a ticket thread).

const voiceMessageSchema = new Schema(
  {
    reportId:   { type: Types.ObjectId, ref: "VoiceReport", required: true, index: true },
    senderId:   { type: Types.ObjectId, ref: "User",        required: true },
    senderRole: { type: String, default: null },
    content:    { type: String, required: true, trim: true },
    isSystem:   { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const VoiceMessage = model("VoiceMessage", voiceMessageSchema);

// ── VoiceReport ──────────────────────────────────────────────────────────────

const voiceReportSchema = new Schema(
  {
    orgId:      { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    reporterId: { type: Types.ObjectId, ref: "User",         required: true },
    anonymous:  { type: Boolean, default: false },

    // Who the report is about (optional — a "general feedback" may have no target)
    targetId:   { type: Types.ObjectId, ref: "User", default: null },
    targetRole: { type: String, default: null },

    category: {
      type:    String,
      enum:    ["complaint", "feedback", "concern", "suggestion"],
      default: "concern",
    },

    subject:     { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },

    status: {
      type:    String,
      enum:    ["open", "in_progress", "awaiting_response", "resolved", "escalated", "closed"],
      default: "open",
      index:   true,
    },

    priority: {
      type:    String,
      enum:    ["low", "medium", "high", "critical"],
      default: "medium",
    },

    // The user who handles this report (Director by default, escalationContact if escalated)
    assignedTo:   { type: Types.ObjectId, ref: "User", default: null },
    escalatedTo:  { type: Types.ObjectId, ref: "User", default: null },
    escalatedAt:  { type: Date, default: null },
    closedAt:     { type: Date, default: null },
    resolution:   { type: String, default: null },
  },
  { timestamps: true }
);

voiceReportSchema.index({ orgId: 1, status: 1, createdAt: -1 });
voiceReportSchema.index({ reporterId: 1 });

export default model("VoiceReport", voiceReportSchema);
