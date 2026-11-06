import { Schema, model, Types } from "mongoose";

const chatCommunitySchema = new Schema(
  {
    orgId:       { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    name:        { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    icon:        { type: String, default: "💬" }, // emoji icon
    type: {
      type:    String,
      enum:    ["organization", "project", "department", "team", "custom"],
      default: "custom",
    },
    projectId:   { type: Types.ObjectId, ref: "Project",  default: null, index: true },
    department:  { type: String, default: null },
    teamId:      { type: Types.ObjectId, ref: "Team",     default: null },
    createdBy:   { type: Types.ObjectId, ref: "User",     required: true },
    // Users with admin rights over this community
    adminIds:    [{ type: Types.ObjectId, ref: "User" }],
    // All members (union of all group members)
    memberIds:   [{ type: Types.ObjectId, ref: "User" }],
    settings: {
      addMembers: { type: String, enum: ["everyone", "admins"], default: "admins" },
      editInfo:   { type: String, enum: ["everyone", "admins"], default: "admins" },
    },
    isArchived:  { type: Boolean, default: false },
    // V2 Phase 2 (D-074): employees ask for a group; Manager / Team Lead decide.
    groupRequests: [{
      requestedBy: { type: Types.ObjectId, ref: "User", required: true },
      name:        { type: String, required: true, trim: true, maxlength: 60 },
      description: { type: String, default: "", maxlength: 300 },
      status:      { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
      decidedBy:   { type: Types.ObjectId, ref: "User", default: null },
      decidedAt:   { type: Date, default: null },
      groupId:     { type: Types.ObjectId, ref: "ChatChannel", default: null },
      createdAt:   { type: Date, default: Date.now },
    }],
  },
  { timestamps: true }
);

chatCommunitySchema.index({ orgId: 1, name: 1 }, { unique: true });
chatCommunitySchema.index({ memberIds: 1 });
chatCommunitySchema.index({ adminIds: 1 });

export default model("ChatCommunity", chatCommunitySchema);
