import mongoose, { Schema } from "mongoose";

const OrgHealthSnapshotSchema = new Schema({
  orgId:        { type: String, required: true, index: true },
  overall:      { type: Number, required: true, min: 0, max: 100 },
  subScores:    {
    delivery: { type: Number, default: null },
    capacity: { type: Number, default: null },
    risk:     { type: Number, default: null },
    quality:  { type: Number, default: null },
  },
  inputs:       { type: Schema.Types.Mixed },
  calculatedAt: { type: Date, default: Date.now },
}, { timestamps: false });

OrgHealthSnapshotSchema.index({ orgId: 1, calculatedAt: -1 });

export default mongoose.model("OrgHealthSnapshot", OrgHealthSnapshotSchema);
