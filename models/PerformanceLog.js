import { Schema, model, Types } from "mongoose";

const performanceLogSchema = new Schema(
  {
    userId:     { type: Types.ObjectId, ref: "User", required: true, index: true },
    orgId:      { type: String, required: true, index: true },
    action:     { type: String, required: true, maxlength: 100 },
    durationMs: { type: Number, required: true, min: 0, max: 60000 },
    page:       { type: String, default: null, maxlength: 200 },
    userAgent:  { type: String, default: null, maxlength: 300 },
    seeded:     { type: Boolean, default: false },
  },
  { timestamps: true }
);

performanceLogSchema.index({ orgId: 1, action: 1, createdAt: -1 });

export default model("PerformanceLog", performanceLogSchema);
