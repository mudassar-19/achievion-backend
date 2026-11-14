// Challenges (V2 Phase 3 · M-5, UX §8, FR07). Progress is read from the XP ledger; rewards go through
// gamificationService.applyQuestReward (XpLog source "quest", one per user per quest).
import { Schema, model, Types } from "mongoose";

const questSchema = new Schema(
  {
    orgId:       { type: String, required: true, index: true },
    title:       { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: "", maxlength: 500 },
    type:        { type: String, enum: ["daily", "weekly", "sprint", "custom"], default: "custom" },
    repeat:      { type: Boolean, default: false },            // daily / weekly only
    sprintId:    { type: Types.ObjectId, ref: "Sprint", default: null },
    metric:      { type: String, enum: ["tasks_completed", "on_time_tasks", "avg_quality", "streak_days"], required: true },
    target:      { type: Number, required: true, min: 1 },
    scope:       { type: String, enum: ["individual", "team", "organisation"], required: true },
    scopeRef:    { kind: { type: String, enum: ["user", "project", "team"] }, id: { type: Types.ObjectId } },
    rewardXp:      { type: Number, required: true, min: 1 },
    rewardGold:    { type: Number, default: 0, min: 0 },
    rewardBadgeId: { type: String, default: null },
    startDate:   { type: Date, default: null },
    deadline:    { type: Date, default: null },
    status:      { type: String, enum: ["draft", "active", "completed", "expired"], default: "draft", index: true },
    endedEarly:  { type: Boolean, default: false },
    participants: [{ type: Types.ObjectId, ref: "User" }],     // entry "auto": fixed at publish from the scope · "join": the people who joined
    // Batch 3 (E13, UC-17): set at publish by questJoinRules.entryFor. Old quests have no value = "auto".
    aiDraft:     { type: Boolean, default: false },            // the form was pre-filled by the AI draft (FR07-02)
    entry:       { type: String, enum: ["auto", "join"], default: "auto" },
    progress: [{
      _id: false,
      userId:      { type: Types.ObjectId, ref: "User" },
      value:       { type: Number, default: 0 },
      tasks:       { type: Number, default: 0 },
      completedAt: { type: Date, default: null },              // reward given (ledger row exists)
    }],
    seriesId:    { type: Types.ObjectId, default: null },      // repeat: first quest of the series
    previousId:  { type: Types.ObjectId, default: null },
    createdBy:   { type: Types.ObjectId, ref: "User", required: true },
    publishedAt: { type: Date, default: null },
    closedAt:    { type: Date, default: null },
  },
  { timestamps: true }
);
questSchema.index({ orgId: 1, status: 1, deadline: 1 });
questSchema.index({ participants: 1, status: 1 });
// Repeat is issued once per period.
questSchema.index({ seriesId: 1, startDate: 1 }, { unique: true, partialFilterExpression: { seriesId: { $type: "objectId" } } });

export default model("Quest", questSchema);
