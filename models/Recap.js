import mongoose, { Schema } from "mongoose";

const RecapSchema = new Schema({
  orgId:       { type: String, required: true, index: true },
  type:        { type: String, enum: ["weekly","monthly","yearly"], required: true },
  periodLabel: { type: String, required: true },
  periodStart: { type: Date,   required: true },
  periodEnd:   { type: Date,   required: true },
  cards:       [{ title: String, body: String, metric: Schema.Types.Mixed, trend: Schema.Types.Mixed }],
  periodRange: { type: String, default: null }, // what the recap COVERS, e.g. "16 Nov – 22 Nov 2026" (createdAt is when it was generated)
  aiSummary:   { type: String, default: null }, // optional AI-generated sum-up of the numbers (advisory)
  seenBy:      [{ userId: Schema.Types.ObjectId, seenAt: Date }],
}, { timestamps: { createdAt: true, updatedAt: false } });

RecapSchema.index({ orgId: 1, type: 1, periodStart: -1 });

export default mongoose.model("Recap", RecapSchema);
