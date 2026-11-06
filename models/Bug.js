import { Schema, model, Types } from "mongoose";
import { SEVERITIES, BUG_STATUSES } from "../services/qualityRules.js";

// E-4 (D-188): a bug reported by a Tester on a project (optionally on one task). Board: Open → Fixed → Verified → Closed.
// The project's Team Lead checks it once (valid / invalid / duplicate). Every step is in history. Never deleted.
const fileSchema = new Schema({ name: { type: String, maxlength: 200 }, url: { type: String, required: true }, size: { type: Number, default: 0 } }, { _id: false });
const historySchema = new Schema({
  at:     { type: Date, default: Date.now },
  by:     { type: Types.ObjectId, ref: "User", required: true },
  action: { type: String, enum: ["reported", "valid", "invalid", "duplicate", "fixed", "verified", "reopened", "closed"], required: true },
  from:   { type: String, default: null },
  to:     { type: String, default: null },
  note:   { type: String, default: "", maxlength: 500 },
}, { _id: false });

const bugSchema = new Schema({
  orgId:       { type: String, required: true },
  projectId:   { type: Types.ObjectId, ref: "Project", required: true },
  taskId:      { type: Types.ObjectId, ref: "Task", default: null },
  createdBy:   { type: Types.ObjectId, ref: "User", required: true },
  title:       { type: String, required: true, trim: true, minlength: 3, maxlength: 120 },
  steps:       { type: String, required: true, maxlength: 2000 },
  expected:    { type: String, required: true, maxlength: 1000 },
  actual:      { type: String, required: true, maxlength: 1000 },
  environment: { type: String, default: "", maxlength: 300 },
  severity:    { type: String, enum: SEVERITIES, required: true },
  status:      { type: String, enum: BUG_STATUSES, default: "Open" },
  validity:    { type: String, enum: ["pending", "valid", "invalid", "duplicate"], default: "pending" },
  duplicateOf: { type: Types.ObjectId, ref: "Bug", default: null },
  files:       { type: [fileSchema], validate: [(v) => v.length <= 5, "At most 5 files"] },
  fixedBy:     { type: Types.ObjectId, ref: "User", default: null },
  xpAwardedAt: { type: Date, default: null }, // Q2: set once, atomically, when the reporter's +15 XP is paid
  xpSlot:      { type: String, default: undefined }, // E-4b (D-196): "reporter:day:n", unique, n = 1..5 → the daily cap cannot be passed
  history:     { type: [historySchema], default: [] },
}, { timestamps: true });

bugSchema.index({ orgId: 1, projectId: 1, status: 1 });
bugSchema.index({ taskId: 1 });
bugSchema.index({ createdBy: 1, xpAwardedAt: 1 });
bugSchema.index({ "files.url": 1 });
bugSchema.index({ xpSlot: 1 }, { unique: true, partialFilterExpression: { xpSlot: { $type: "string" } } });

export default model("Bug", bugSchema);
