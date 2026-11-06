import { Schema, model, Types } from "mongoose";

const chatChannelSchema = new Schema(
  {
    orgId:        { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    // Parent community (null for DMs and legacy orphaned channels)
    communityId:  { type: Types.ObjectId, ref: "ChatCommunity", default: null, index: true },
    name:         { type: String, required: true, trim: true },
    description:  { type: String, default: "" },
    icon:         { type: String, default: "💬" }, // emoji icon
    type: {
      type:    String,
      enum:    ["general", "dm", "project", "department", "team", "announcement", "custom"],
      default: "general",
      index:   true,
    },
    // For DMs: exactly 2 member IDs; for others: all member IDs
    memberIds:   [{ type: Types.ObjectId, ref: "User" }],
    // Group administrators (subset of members)
    adminIds:    [{ type: Types.ObjectId, ref: "User" }],
    // Linked entity IDs
    projectId:   { type: Types.ObjectId, ref: "Project", default: null, index: true },
    teamId:      { type: Types.ObjectId, ref: "Team",    default: null },
    department:  { type: String, default: null },
    // WhatsApp-style permissions
    permissions: {
      sendMessages: { type: String, enum: ["everyone", "admins"], default: "everyone" },
      editInfo:     { type: String, enum: ["everyone", "admins"], default: "admins" },
      addMembers:   { type: String, enum: ["everyone", "admins"], default: "admins" },
    },
    // V2 Phase 2 (D-074): members allowed to post when sending is admins-only (e.g. Announcements)
    posterIds:    [{ type: Types.ObjectId, ref: "User" }],
    joinApproval: { type: Boolean, default: false },
    joinRequests: [{ type: Types.ObjectId, ref: "User" }],
    mutedBy:      [{ type: Types.ObjectId, ref: "User" }],
    // Deprecated: use permissions.sendMessages === "admins" instead
    postRoles:   [{ type: String }],
    isDefault:   { type: Boolean, default: false },
    isArchived:  { type: Boolean, default: false },
    createdBy:   { type: Types.ObjectId, ref: "User", default: null },
    pinnedMessages: [{ type: Types.ObjectId, ref: "ChatMessage" }],
    // Per-user conversation clear: stores userId + timestamp so messages before clearedAt are hidden
    clearedBy: [{
      _id:       false,
      userId:    { type: Types.ObjectId, ref: "User" },
      clearedAt: { type: Date },
    }],
  },
  { timestamps: true }
);

// Unique group name within a community; DMs (communityId=null) excluded via $type filter
chatChannelSchema.index({ communityId: 1, name: 1 }, { unique: true, partialFilterExpression: { communityId: { $exists: true, $type: "objectId" } } });
chatChannelSchema.index({ memberIds: 1 });
chatChannelSchema.index({ adminIds: 1 });
chatChannelSchema.index({ communityId: 1 });

export default model("ChatChannel", chatChannelSchema);
