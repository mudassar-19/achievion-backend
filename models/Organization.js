import { Schema, model, Types } from "mongoose";

// ── orgId generator ───────────────────────────────────────────────────────────
// Produces "ORG-XXXXXXXX" using an unambiguous charset (no 0/O, 1/I/L).
// Called by the controller, not the schema, so it can retry on collision.
const ORG_ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateOrgId() {
  const suffix = Array.from(
    { length: 8 },
    () => ORG_ID_CHARS[Math.floor(Math.random() * ORG_ID_CHARS.length)]
  ).join("");
  return `ORG-${suffix}`;
}

// ── Schema ────────────────────────────────────────────────────────────────────
const organizationSchema = new Schema(
  {
    name: {
      type:     String,
      required: [true, "Organization name is required"],
      trim:     true,
    },

    // The Software House admin's login email — unique across all orgs.
    adminEmail: {
      type:      String,
      required:  [true, "Admin email is required"],
      unique:    true,
      lowercase: true,
      trim:      true,
    },

    // bcrypt hash of the admin password.  Never returned to the client.
    passwordHash: {
      type:     String,
      required: [true, "Password hash is required"],
      select:   false,
    },

    // "ORG-XXXXXXXX" — generated on registration, shared with employees as invite code.
    orgId: {
      type:     String,
      required: true,
      unique:   true,
      trim:     true,
    },

    // "TECHCO-4821" — human-friendly code derived from org name, used for employee login.
    orgCode: {
      type:      String,
      unique:    true,
      uppercase: true,
      trim:      true,
      index:     true,
    },

    industry: { type: String, trim: true, default: null },

    size: { type: String, trim: true, default: null },

    // e.g. ["Development", "Design", "QA / Testing"]
    departments: {
      type:    [String],
      default: [],
    },
    // Batch 5 (D4): archived departments keep their members but nobody new can be put in them.
    archivedDepartments: { type: [String], default: [] },
    // Batch 5 (D7): organization logo. `file` = name inside uploads/branding (disk) or `url` (Cloudinary).
    logo: {
      file:      { type: String, default: null },
      url:       { type: String, default: null },
      type:      { type: String, enum: ["png", "jpg", "webp"] },
      size:      { type: Number, default: 0 },
      updatedAt: { type: Date, default: null },
      updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    },

    companySize: {
      type: String,
      enum: ["1-10", "11-50", "51-200", "201-500", "500+"],
    },

    status: {
      type:    String,
      enum:    ["active", "suspended"],
      default: "active",
    },

    // True once the org admin has registered the first Director user via the setup popup.
    directorSetupComplete: {
      type:    Boolean,
      default: false,
    },

    // Director-configurable gamification rules for this org.
    gamificationRules: {
      type:    Schema.Types.Mixed,
      default: null,
    },

    // ── Slice 3a settings fields ──────────────────────────────────────────────
    workingTime: {
      hoursPerDay:  { type: Number, default: 7,       min: 1, max: 24 },
      workingDays:  { type: [Number], default: [1,2,3,4,5] }, // 0=Sun…6=Sat
    },

    // M-4: Director default workload limit (% of daily capacity); above it a person is "Overloaded".
    workloadThresholdPct: { type: Number, default: 100, min: 50, max: 150 },

    // M-5: most a Manager may offer per challenge (Director default; no Director screen yet).
    questRewardCap: {
      xp:   { type: Number, default: 500, min: 0 },
      gold: { type: Number, default: 250, min: 0 },
    },

    extensionRules: {
      extensionMaxDays:   { type: Number, default: 3,  min: 0, max: 30  },
      extensionMaxPct:    { type: Number, default: 20, min: 0, max: 100 },
      extensionCumCapPct: { type: Number, default: 20, min: 0, max: 100 },
    },

    alertSettings: { type: Schema.Types.Mixed, default: {} },

    aiSettings: {
      weeklySummaryEnabled:      { type: Boolean, default: false },
      summaryDay:                { type: Number,  default: 1, min: 0, max: 6 },
      summaryTime:               { type: String,  default: "09:00" },
      costCapUsdPerDay:          { type: Number,  default: 1.0, min: 0 },
      managerDailyLimit:         { type: Number,  default: 30, min: 0, max: 1000 }, // M-7: Manager AI calls per user per day
      weeklySummaryLastRunAt:    { type: Date,    default: null },
    },

    gamificationSettings: { type: Schema.Types.Mixed, default: null },

    escalationContactId: { type: Types.ObjectId, ref: "User", default: null },

    // D-294 IMPL-5 Part 4: Director-managed custom role labels (max 20).
    // key = slug (auto-generated), label = display name, category = one of developer|designer|tester,
    // active = false means deactivated (never hard-deleted). No User.role enum change.
    customRoles: {
      type: [{
        key:      { type: String, required: true },
        label:    { type: String, required: true, minlength: 2, maxlength: 40 },
        category: { type: String, required: true, enum: ["developer", "designer", "tester"] },
        active:   { type: Boolean, default: true },
      }],
      default: [],
    },

    // Employee User._id references for this org.
    members: [
      {
        type: Types.ObjectId,
        ref:  "User",
      },
    ],
  },
  { timestamps: true }
);

organizationSchema.index({ status: 1 });

export default model("Organization", organizationSchema);
