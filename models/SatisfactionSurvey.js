import { Schema, model } from "mongoose";

const satisfactionSurveySchema = new Schema(
  {
    orgId:           { type: String,   required: true, index: true },
    respondentHash:  { type: String,   required: true },   // HMAC(secret, userId+period) — never plaintext
    period:          { type: String,   required: true },   // e.g. "2026-W43"
    role:            { type: String,   required: true },   // role category (not exact role)
    enjoyableScore:  { type: Number,   min: 1, max: 5, default: null },  // "I find this system enjoyable"
    easyScore:       { type: Number,   min: 1, max: 5, default: null },  // "This system is easy to use"
    susScores:       { type: [Number], default: [] },      // 10 items, 1–5
    susScore:        { type: Number,   default: null },    // computed 0–100
  },
  { timestamps: true }
);

// Unique per respondent per period per org (deduplication guard)
satisfactionSurveySchema.index({ orgId: 1, respondentHash: 1, period: 1 }, { unique: true });

export default model("SatisfactionSurvey", satisfactionSurveySchema);
