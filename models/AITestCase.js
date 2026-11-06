import mongoose, { Schema } from "mongoose";

const AITestCaseSchema = new Schema({
  orgId:             { type: String,   required: true, index: true },
  runId:             { type: String,   required: true, index: true },
  feature:           { type: String },                              // prompt feature key
  input:             { type: String,   required: true },
  expectedBehaviour: { type: String,   required: true },
  actualOutput:      { type: String,   default: "" },
  model:             { type: String },                              // model that produced actualOutput
  provider:          { type: String },
  faithfulness:      { type: Number,   min: 0, max: 1 },           // 0-1 automatic score (null = not run)
  pass:              { type: Boolean,  default: false },
  judgedBy:          [{ type: Schema.Types.ObjectId, ref: "User" }],
}, { timestamps: { createdAt: true, updatedAt: false } });

export default mongoose.model("AITestCase", AITestCaseSchema);
