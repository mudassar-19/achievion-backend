import { Schema, model, Types } from "mongoose";

const teamSchema = new Schema(
  {
    orgId:       { type: String, required: true, index: true },
    name:        { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    department:  { type: String, default: "" },

    teamLead: { type: Types.ObjectId, ref: "User", default: null },

    members: [
      {
        userId:     { type: Types.ObjectId, ref: "User", required: true },
        role:       String,
        joinedAt:   { type: Date, default: Date.now },
        isActive:   { type: Boolean, default: true },
        allocation: { type: Number, default: 100, min: 0, max: 100 },
      },
    ],

    projects: [{ type: Types.ObjectId, ref: "Project" }],
    capacity:  { type: Number, default: 10, min: 1, max: 50 },

    status: {
      type:    String,
      enum:    ["active", "on_hold", "archived"],
      default: "active",
    },

    teamXp: { type: Number, default: 0, min: 0 },

    stats: {
      tasksCompleted:   { type: Number, default: 0 },
      avgQualityScore:  { type: Number, default: 0 },
      sprintsCompleted: { type: Number, default: 0 },
      onTimeRate:       { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

teamSchema.index({ orgId: 1, status: 1 });
teamSchema.index({ orgId: 1, name: 1 }, { unique: true });

export default model("Team", teamSchema);
