// Thumbs up / down on an AI answer or suggestion (V2 Phase 3 · M-7, D-105). Data for the 80 % criterion.
// One vote per user per item (changing the vote updates it).
import { Schema, model, Types } from "mongoose";

const aiFeedbackSchema = new Schema({
  orgId:   { type: String, required: true, index: true },
  userId:  { type: Types.ObjectId, ref: "User", required: true },
  feature: { type: String, required: true, maxlength: 40 }, // mgr_chat | mgr_insight | mgr_sprint_narrative | ...
  refId:   { type: String, required: true, maxlength: 200 }, // chat message id or the suggestion's cache key
  rating:  { type: String, enum: ["up", "down"], required: true },
  snippet: { type: String, maxlength: 500 },
}, { timestamps: true });

aiFeedbackSchema.index({ userId: 1, feature: 1, refId: 1 }, { unique: true });

export default model("AIFeedback", aiFeedbackSchema);
