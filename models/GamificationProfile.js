import { Schema, model, Types } from "mongoose";

const gpSchema = new Schema(
  {
    // Primary key — one profile per user
    userId: {
      type:     Types.ObjectId,
      ref:      "User",
      required: true,
      unique:   true,
    },

    orgId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },

    // ── Level + XP ───────────────────────────────────────────────────────────
    totalXp:   { type: Number, default: 0,   min: 0 }, // cumulative all-time
    monthlyXp: { type: Number, default: 0,   min: 0 }, // resets 1st of month
    level:     { type: Number, default: 1,   min: 1 },
    currentXp: { type: Number, default: 0,   min: 0 }, // XP within current level
    maxXp:     { type: Number, default: 100, min: 1 }, // cap for current level

    // ── Economy ──────────────────────────────────────────────────────────────
    hp:   { type: Number, default: 100, min: 0, max: 100 },
    gold: { type: Number, default: 0,   min: 0 },

    // ── Streaks ──────────────────────────────────────────────────────────────
    streaks: {
      daily:   { type: Number, default: 0, min: 0 },
      quality: { type: Number, default: 0, min: 0 },
      collab:  { type: Number, default: 0, min: 0 },
    },

    // ── Badges ───────────────────────────────────────────────────────────────
    badges: [
      {
        id:       String,
        name:     String,
        // `type: String` alone would make Mongoose read the whole element as [String]
        // (CastError on every badge award), so the field is declared explicitly.
        type:     { type: String },
        rarity:   String,
        earnedAt: { type: Date, default: Date.now },
      },
    ],

    // ── Titles ───────────────────────────────────────────────────────────────
    titles: [
      { id: String, name: String, rarity: String, unlockedAt: Date }
    ],
    activeTitle: { type: String, default: "newcomer" },

    // ── Avatar & cosmetics ───────────────────────────────────────────────────
    avatarStyle: { type: String, default: "bottts" },
    avatarSeed:  { type: String, default: null },
    equippedItems: {
      background: { type: String, default: null },
      outfit:     { type: String, default: null },
      weapon:     { type: String, default: null },
      pet:        { type: String, default: null },
    },

    // ── Avatar Customization Config ───────────────────────────────────────────
    avatarConfig: {
      style:           { type: String, default: "bottts" },
      seed:            { type: String, default: null },
      background:      { type: String, default: "none" },
      visualStyle:     { type: String, default: "minimal" },
      preset:          { type: String, default: null },
      effects:         [{ type: String }],
      themeAccentSync: { type: Boolean, default: false },
      lastUpdated:     { type: Date,    default: null },
    },

    // ── Stats ────────────────────────────────────────────────────────────────
    stats: {
      tasksCompleted:   { type: Number, default: 0, min: 0 },
      tasksRejected:    { type: Number, default: 0, min: 0 },
      onTimeDeliveries: { type: Number, default: 0, min: 0 },
      lateSubmissions:  { type: Number, default: 0, min: 0 },
      avgQualityScore:  { type: Number, default: 0, min: 0 },
      reviewsGiven:     { type: Number, default: 0, min: 0 },
      bugsFixed:        { type: Number, default: 0, min: 0 },
      isFoundingMember: { type: Boolean, default: false },
    },

    // ── Team Lead Stats (leadership-specific) ──────────────────────────────
    tlStats: {
      milestonesDelivered:   { type: Number, default: 0, min: 0 },
      milestonesOnTime:      { type: Number, default: 0, min: 0 },
      sprintsCompleted:      { type: Number, default: 0, min: 0 },
      sprintsOnTime:         { type: Number, default: 0, min: 0 },
      sprintsHighCompletion: { type: Number, default: 0, min: 0 }, // ≥80% completion
      reviewsApproved:       { type: Number, default: 0, min: 0 },
      reviewsRejected:       { type: Number, default: 0, min: 0 },
      overdueMilestones:     { type: Number, default: 0, min: 0 },
      perfectSprints:        { type: Number, default: 0, min: 0 }, // 100% completion
      consecutiveOnTime:     { type: Number, default: 0, min: 0 }, // running streak
      totalXpFromLeadership: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true }
);

gpSchema.index({ orgId: 1, totalXp: -1 });
gpSchema.index({ orgId: 1, level: -1 });

export default model("GamificationProfile", gpSchema);
