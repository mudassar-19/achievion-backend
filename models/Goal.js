import mongoose, { Schema } from "mongoose";

const GoalSchema = new Schema({
  orgId:            { type: String,             required: true, index: true },
  title:            { type: String,             required: true, maxlength: 200 },
  metric:           { type: String,             enum: ["on_time_pct","projects_done","quality"], required: true },
  targetValue:      { type: Number,             required: true },
  currentValue:     { type: Number,             default: 0 },
  period:           { type: String,             required: true },   // "YYYY" | "YYYY-Qn" | "YYYY-MM"
  linkedProjectIds: [{ type: Schema.Types.ObjectId, ref: "Project" }],
  visibleTo:        { type: String,             enum: ["managers","all"], default: "managers" },
  status:           { type: String,             enum: ["on_track","behind","achieved","archived"], default: "on_track" },
  createdBy:        { type: Schema.Types.ObjectId, ref: "User", required: true },
  archivedAt:       { type: Date,               default: null },
  isTeamQuest:      { type: Boolean,            default: false },
}, { timestamps: true });

export default mongoose.model("Goal", GoalSchema);
