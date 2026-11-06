import { Schema, model, Types } from "mongoose";

const statusHistorySchema = new Schema(
  {
    status:    { type: String },
    changedAt: { type: Date, default: Date.now },
    changedBy: { type: Types.ObjectId, ref: "User", default: null },
    note:      { type: String, default: "" },
  },
  { _id: false }
);

const projectSchema = new Schema(
  {
    // ── Core identity ─────────────────────────────────────────────────────────
    title: {
      type:     String,
      required: [true, "Project title is required"],
      trim:     true,
    },
    description:      { type: String, default: "" },
    businessContext:  { type: String, default: "" },
    clientName:       { type: String, default: "", trim: true },
    operationalNotes: { type: String, default: "" },

    category: {
      type:    String,
      enum:    [
        "Web Application", "Mobile App", "API / Backend",
        "Design", "QA / Testing", "DevOps", "Data / Analytics", "Other",
      ],
      default: "Other",
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    [
        "Planning",  "Scheduled", "Active",
        "On Hold",   "Delayed",   "In Review",
        "Completed", "Archived",  "Frozen",   "Deleted",
      ],
      default: "Planning",
    },

    priority: {
      type:    String,
      enum:    ["Critical", "High", "Medium", "Low"],
      default: "Medium",
    },

    statusHistory: { type: [statusHistorySchema], default: [] },

    // ── Timeline ──────────────────────────────────────────────────────────────
    startDate:  { type: Date, default: null },
    deadline:   { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    statusBeforeArchive: { type: String, default: null }, // M-2: Restore puts this status back

    internalRef: { type: String, default: "", trim: true },

    // ── Freeze system ─────────────────────────────────────────────────────────
    isFrozen:       { type: Boolean, default: false },
    frozenAt:       { type: Date,    default: null },
    frozenBy:       { type: Types.ObjectId, ref: "User", default: null },
    freezeReason:   { type: String, default: "" },
    unfrozenAt:     { type: Date,    default: null },
    // Cumulative freeze duration (ms) — used to extend deadlines on unfreeze
    totalFrozenMs:  { type: Number, default: 0 },

    // ── Soft delete ───────────────────────────────────────────────────────────
    isDeleted:      { type: Boolean, default: false },
    deletedAt:      { type: Date,    default: null },
    deletedBy:      { type: Types.ObjectId, ref: "User", default: null },
    deleteReason:   { type: String, default: "" },

    // ── Attachments ───────────────────────────────────────────────────────────
    attachments: [{
      name:       { type: String },
      filename:   { type: String },
      filePath:   { type: String },
      size:       { type: Number },
      mimetype:   { type: String },
      uploadedAt: { type: Date, default: Date.now },
      uploadedBy: { type: Types.ObjectId, ref: "User", default: null },
    }],

    // ── Working time ──────────────────────────────────────────────────────────
    workingHoursPerDay: { type: Number, default: 7, min: 1, max: 24 },

    // ── Gamification ─────────────────────────────────────────────────────────
    xpPool: { type: Number, default: 0, min: 0 },

    // ── Health / risk ─────────────────────────────────────────────────────────
    healthScore: { type: Number, default: 100, min: 0, max: 100 },
    riskLevel:   { type: String, enum: ["Low", "Medium", "High", "Critical"], default: "Low" },

    // ── Tech metadata ─────────────────────────────────────────────────────────
    techStack: { type: [String], default: [] },

    // ── Ownership ─────────────────────────────────────────────────────────────
    // director is optional — set to the org Director if found, otherwise null
    director:  { type: Types.ObjectId, ref: "User", default: null },
    managerId: { type: Types.ObjectId, ref: "User", default: null },
    orgId:     { type: String, required: true, index: true },

    // ── Team allocation ───────────────────────────────────────────────────────
    teamId:  { type: Types.ObjectId, ref: "Team", default: null, index: true },
    members: [{ type: Types.ObjectId, ref: "User" }],

    visibility: {
      type:    String,
      enum:    ["team_only", "org_wide"],
      default: "team_only",
    },
  },
  { timestamps: true }
);

projectSchema.index({ orgId: 1, status: 1 });
projectSchema.index({ orgId: 1, priority: 1 });
projectSchema.index({ orgId: 1, status: 1, deadline: 1 });
projectSchema.index({ managerId: 1, status: 1 });
projectSchema.index({ director: 1, status: 1 });

export default model("Project", projectSchema);
