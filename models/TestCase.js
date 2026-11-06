import { Schema, model, Types } from "mongoose";
import { PRIORITIES, RUN_RESULTS } from "../services/qualityRules.js";

// E-4 (D-191): a test case on a project (optionally linked to a task), with its run history. Never deleted.
const runSchema = new Schema({
  at:     { type: Date, default: Date.now },
  by:     { type: Types.ObjectId, ref: "User", required: true },
  result: { type: String, enum: RUN_RESULTS, required: true },
  note:   { type: String, default: "", maxlength: 500 },
}, { _id: false });

const testCaseSchema = new Schema({
  orgId:      { type: String, required: true },
  projectId:  { type: Types.ObjectId, ref: "Project", required: true },
  taskId:     { type: Types.ObjectId, ref: "Task", default: null },
  createdBy:  { type: Types.ObjectId, ref: "User", required: true },
  updatedBy:  { type: Types.ObjectId, ref: "User", default: null },
  title:      { type: String, required: true, trim: true, minlength: 3, maxlength: 120 },
  steps:      { type: String, required: true, maxlength: 2000 },
  expected:   { type: String, required: true, maxlength: 1000 },
  priority:   { type: String, enum: PRIORITIES, default: "Medium" },
  lastResult: { type: String, enum: [...RUN_RESULTS, null], default: null },
  runs:       { type: [runSchema], default: [] },
}, { timestamps: true });

testCaseSchema.index({ orgId: 1, projectId: 1 });
testCaseSchema.index({ taskId: 1 });

export default model("TestCase", testCaseSchema);
