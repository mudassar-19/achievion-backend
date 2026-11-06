// Daily team well-being aggregate (V2 Phase 3 · M-6). Counts only — no names or user ids — so the
// Reports trend never exposes one person's HP. Written by the midnight cron and on Reports read.
import { Schema, model } from "mongoose";

const wellbeingSnapshotSchema = new Schema({
  orgId:  { type: String, required: true },
  day:    { type: String, required: true },          // YYYY-MM-DD (UTC)
  members: { type: Number, default: 0 },
  tiers:  { Healthy: { type: Number, default: 0 }, Tired: { type: Number, default: 0 }, Low: { type: Number, default: 0 } },
  avgHp:  { type: Number, default: null },
  activeStreaks: { type: Number, default: 0 },
  avgStreak: { type: Number, default: null },
}, { timestamps: true });

wellbeingSnapshotSchema.index({ orgId: 1, day: 1 }, { unique: true });

export default model("WellbeingSnapshot", wellbeingSnapshotSchema);
