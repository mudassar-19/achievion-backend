import { Schema, model, Types } from "mongoose";

const aiPromptLogSchema = new Schema(
  {
    orgId:           { type: String,  required: true, index: true },
    requestedBy:     { type: Types.ObjectId, ref: "User" },
    feature:         { type: String,  required: true },       // "weekly_summary" | "explain" | "rebalance"
    promptId:        { type: String },                        // prompt registry key
    promptVersion:   { type: Number },                        // prompt version
    promptScrubbed:  { type: String,  maxlength: 2000 },      // stored post-scrubbing, never raw
    responseSnippet: { type: String,  maxlength: 500 },
    inputTokens:     { type: Number,  default: 0 },
    outputTokens:    { type: Number,  default: 0 },
    costUsd:         { type: Number,  default: 0 },
    model:           { type: String },
    provider:        { type: String },                        // "groq" | "openrouter"
    modelUsed:       { type: String },                        // actual model ID used
    latencyMs:       { type: Number },
    chunks:          { type: Number, default: 1 },
    attempts: [{
      provider: String,
      model:    String,
      status:   Number,
      errorMsg: String,
      latencyMs: Number,
    }],
    configured:      { type: Boolean, default: true },        // false = not-configured mode, no call made
    fromCache:       { type: Boolean, default: false },
  },
  { timestamps: true }
);

aiPromptLogSchema.index({ orgId: 1, createdAt: -1 });

export default model("AIPromptLog", aiPromptLogSchema);
