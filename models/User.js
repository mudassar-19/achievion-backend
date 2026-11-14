import { Schema, model } from "mongoose";

// ── Role → category mapping ───────────────────────────────────────────────────
// Used by the virtual below and embedded in JWT by signToken().
// Keeping it exported so authController / middleware can import it directly.
export const ROLE_CATEGORY_MAP = {
  // Org-admin (Software House login — stored in Organization, not User, but
  // included here so JWT middleware can handle "org_admin" tokens uniformly)
  org_admin:            "org_admin",

  // Employee roles
  Director:             "director",
  Manager:              "manager",
  "Team Lead":          "team_lead",

  // Developer tier (legacy "Developer" kept for backward compat)
  Developer:            "developer",
  "Senior Developer":   "developer",
  "Junior Developer":   "developer",

  // Designer tier (legacy "Designer" kept for backward compat)
  Designer:             "designer",
  "Senior Designer":    "designer",
  "Junior Designer":    "designer",

  // Tester tier (legacy "Tester" kept for backward compat)
  Tester:               "tester",
  "Senior Tester":      "tester",
  "Junior Tester":      "tester",
};

export const VALID_ROLES = Object.keys(ROLE_CATEGORY_MAP).filter(
  (r) => r !== "org_admin"
);

// ── Schema ────────────────────────────────────────────────────────────────────
const userSchema = new Schema(
  {
    name: {
      type:     String,
      required: [true, "Name is required"],
      trim:     true,
    },

    email: {
      type:      String,
      required:  [true, "Email is required"],
      lowercase: true,
      trim:      true,
    },

    // Stored as a bcrypt hash.  select:false keeps it out of every default query;
    // controllers that need it must call .select("+password") explicitly.
    password: {
      type:     String,
      required: [true, "Password is required"],
      select:   false,
    },

    role: {
      type:     String,
      enum:     VALID_ROLES,
      required: [true, "Role is required"],
    },

    // D-294 IMPL-5 Part 4: custom role label set by Director (overrides role display name in UI).
    // The role enum stays unchanged; this is display-only.
    roleLabel: {
      type:    String,
      trim:    true,
      default: null,
    },

    // ObjectId string of the Organization this employee belongs to.
    // null for users created via the old direct-register flow.
    orgId: {
      type:    String,
      default: null,
      index:   true,
    },

    // e.g. "Development", "Design", "QA / Testing" — set by org admin on creation.
    department: {
      type:    String,
      trim:    true,
      default: null,
    },

    // Batch 5 (N4, FR01-06): technical skills and a contact phone, edited by the person (PATCH /api/auth/profile-details).
    skills: { type: [String], default: [] },
    phone:  { type: String, trim: true, default: null },
    // Batch 5 (X17, FR01-11): last authenticated activity, written at most once a minute (authMiddleware).
    lastSeenAt: { type: Date, default: null },

    // Account lifecycle state — managed by org admin.
    // M-4: a Manager's own workload limit for their team (null = Director default, FR11-03).
    workloadThresholdPct: { type: Number, default: null, min: 50, max: 150 },
    // T-2 (D-123): a Team Lead's saved task filters (name + query string), at most 10.
    savedTaskFilters: { type: [{ name: { type: String, maxlength: 40 }, query: { type: String, maxlength: 600 } }], default: [] },

    status: {
      type:    String,
      enum:    ["active", "suspended", "deleted", "under_review", "rejected", "pending_suspension"],
      default: "active",
    },

    // Emergency suspend fields (Slice 3f Part C)
    suspendConfirmBy:     { type: Date,   default: null }, // 72h deadline
    suspendConfirmStatus: { type: String, enum: ["pending", "confirmed", "flagged"], default: null },
    suspendedAt:          { type: Date,   default: null },
    suspendedBy:          { type: Schema.Types.ObjectId, ref: "User", default: null },

    level: {
      type:    Number,
      default: 1,
      min:     1,
    },

    currentXp: {
      type:    Number,
      default: 0,
      min:     0,
    },

    // Threshold that grows each time the player levels up.
    maxXp: {
      type:    Number,
      default: 1000,
      min:     100,
    },

    gold: {
      type:    Number,
      default: 0,
      min:     0,
    },

    hp: {
      type:    Number,
      default: 100,
      min:     0,
      max:     100,
    },

    tokenVersion: { type: Number, default: 0 },

    // Password reset (FE-020): only a SHA-256 of the 6-digit code is stored; it expires and is attempt-limited.
    resetCodeHash:    { type: String, select: false },
    resetCodeExpires: { type: Date,   select: false },
    resetAttempts:    { type: Number, default: 0, select: false },
    resetCodeIssuedAt: { type: Date, select: false }, // 4.12: 60 s resend cooldown
    resetLockedUntil:  { type: Date, select: false }, // 4.12: 15 min lock after 5 wrong codes

    // User-controlled preferences stored server-side for cross-device persistence.
    settings: {
      type:    Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── Virtual: roleCategory ─────────────────────────────────────────────────────
// Derived from role at read-time; never stored in the DB.
// Embedded in the JWT by signToken() so middleware never needs a DB lookup.
userSchema.virtual("roleCategory").get(function () {
  return ROLE_CATEGORY_MAP[this.role] ?? "developer";
});

userSchema.index({ orgId: 1, role: 1 });
userSchema.index({ orgId: 1, status: 1 });
userSchema.index({ orgId: 1, role: 1, status: 1 });
userSchema.index({ orgId: 1, department: 1 });
userSchema.index({ email: 1, orgId: 1 }, { unique: true, sparse: true });

export default model("User", userSchema);
