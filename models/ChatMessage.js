import { Schema, model, Types } from "mongoose";

const attachmentSchema = new Schema({
  url:          { type: String, required: true },
  originalName: { type: String, required: true },
  mimeType:     { type: String, default: "application/octet-stream" },
  sizeBytes:    { type: Number, default: 0 },
  publicId:     { type: String, default: null }, // Cloudinary public_id
}, { _id: false });

const chatMessageSchema = new Schema(
  {
    orgId:     { type: Types.ObjectId, required: true, index: true },
    channelId: { type: Types.ObjectId, ref: "ChatChannel", required: true, index: true },
    sender:    { type: Types.ObjectId, ref: "User", required: true },
    content:   { type: String, default: "", maxlength: 2000 },
    // Mentions: array of user IDs mentioned with @
    mentions:  [{ type: Types.ObjectId, ref: "User" }],
    // Client-generated ID for dedup
    clientId:  { type: String, default: null, index: true, sparse: true },
    // Attachments
    attachments: [attachmentSchema],
    // Read tracking
    readBy:    [{ type: Types.ObjectId, ref: "User" }],
    // Edit history
    editedAt:  { type: Date, default: null },
    // Soft delete
    deletedAt: { type: Date, default: null },
    // V1 3.7 reactions: one per user (chatRules.toggleReaction)
    reactions: [{ _id: false, emoji: String, userId: { type: Types.ObjectId, ref: "User" } }],
    // For announcement channels: pinned
    isPinned:  { type: Boolean, default: false },
  },
  { timestamps: true }
);

chatMessageSchema.index({ channelId: 1, createdAt: -1 });
chatMessageSchema.index({ clientId: 1 }, { sparse: true });

export default model("ChatMessage", chatMessageSchema);
