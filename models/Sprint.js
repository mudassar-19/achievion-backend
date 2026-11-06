import { Schema, model, Types } from "mongoose";

const sprintSchema = new Schema(
  {
    name:      { type: String, required: true, trim: true },
    goal:      { type: String, default: "" },
    goals:     [{ type: String }],
    status: {
      type:    String,
      enum:    ["Planning", "Active", "Under Review", "Completed", "Delayed"],
      default: "Planning",
    },
    startDate: { type: Date, default: null },
    endDate:   { type: Date, default: null },
    orgId:     { type: String, required: true, index: true },
    projectId: { type: Types.ObjectId, ref: "Project", default: null },
    tasks:     [{ type: Types.ObjectId, ref: "Task" }],
    milestones:[{ type: Types.ObjectId, ref: "Milestone" }],
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    completedAt: { type: Date, default: null },
    velocity:  { type: Number, default: null },   // M-3: XP of the Done tasks, stored at close
    // M-3: numbers frozen at close (planned/done/on-time/AI avg/contributors/delays), so moving
    // unfinished tasks out does not change the summary.
    closeSummary: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

sprintSchema.index({ orgId: 1, status: 1 });
sprintSchema.index({ projectId: 1, status: 1 });

export default model("Sprint", sprintSchema);
