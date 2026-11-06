import mongoose, { Schema } from "mongoose";

const RecapSchema = new Schema({
  orgId:       { type: String, required: true, index: true },
  type:        { type: String, enum: ["weekly","monthly","yearly"], required: true },
  periodLabel: { type: String, required: true },
  periodStart: { type: Date,   required: true },
  periodEnd:   { type: Date,   required: true },
  cards:       [{ title: String, body: String, metric: Schema.Types.Mixed }],
  seenBy:      [{ userId: Schema.Types.ObjectId, seenAt: Date }],
}, { timestamps: { createdAt: true, updatedAt: false } });

RecapSchema.index({ orgId: 1, type: 1, periodStart: -1 });

export default mongoose.model("Recap", RecapSchema);
