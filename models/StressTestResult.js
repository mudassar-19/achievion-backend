import mongoose, { Schema } from "mongoose";

const StressTestResultSchema = new Schema({
  orgId:           { type: String,   required: true, index: true },
  runAt:           { type: Date,     required: true },
  durationMinutes: { type: Number,   required: true },
  virtualUsers:    { type: Number,   required: true },
  totalRequests:   { type: Number,   required: true },
  successCount:    { type: Number,   required: true },
  uptimePct:       { type: Number,   required: true },
  passed:          { type: Boolean,  required: true },
  logFileUrl:      { type: String,   default: "" },
  notes:           { type: String,   default: "" },
  runBy:           { type: Schema.Types.ObjectId, ref: "User" },
}, { timestamps: { createdAt: true, updatedAt: false } });

export default mongoose.model("StressTestResult", StressTestResultSchema);
