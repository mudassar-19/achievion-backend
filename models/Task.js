import { defaultXpValue } from "../services/xpEngine.js";
import { Schema, model, Types } from "mongoose";

const taskSchema = new Schema(
  {
    title: {
      type:     String,
      required: [true, "Task title is required"],
      trim:     true,
    },
    description: { type: String, default: "" },

    type: {
      type:     String,
      enum:     ["Feature", "Bug", "Design", "Testing", "DevOps", "Documentation"],
      required: [true, "Task type is required"],
    },
    priority: {
      type:    String,
      enum:    ["Critical", "High", "Medium", "Low"],
      default: "Medium",
    },
    status: {
      type:    String,
      enum:    ["Backlog", "To-Do", "In-Progress", "In-Review", "Done"],
      default: "To-Do",
    },

    // Org-scoped — every query filters by this first.
    orgId:     { type: String,         required: true, index: true },
    projectId: { type: Types.ObjectId, ref: "Project", default: null },

    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    assignees: [{ type: Types.ObjectId, ref: "User" }],

    // Single-assignee workflow (new role-based assignment)
    assignee:     { type: Types.ObjectId, ref: "User", default: null },
    assignedBy:   { type: Types.ObjectId, ref: "User", default: null },
    assignerRole: { type: String, default: null },

    // D-066: XP base. Not set → priority default (pre-validate below). Existing tasks keep their value.
    xpValue:  { type: Number, default: null, min: 10, max: 1000 },
    goldValue: { type: Number, default: 50,  min: 0 },

    deadline:    { type: Date, default: null },
    startDate:   { type: Date, default: null },
    endDate:     { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    firstSubmittedAt: { type: Date, default: null }, // D-057: lateness is judged here, once
    deadlineAlertSentAt: { type: Date, default: null }, // 1.5: 24 h alert sent (reset when the deadline moves)
    overduePenaltyAt:    { type: Date, default: null }, // 1.6: missed-deadline HP already charged
    completedAt: { type: Date, default: null },

    // Submission
    submissionNote:  { type: String, default: "" },
    submissionFiles: [
      {
        filename:   String,
        url:        String,
        publicId:   String,
        size:       { type: Number, default: 0 },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    submissionLinks: [{ label: String, url: String }],
    // V2 2.3 (D-075): text the AI may read — dev code paste/file or tester report (D-060/D-062);
    // designer checklist keys (D-061). The AI never sees files or images.
    submissionContent:   { type: String, default: "", maxlength: 100_000 },
    submissionChecklist: [{ type: String }],
    // E-3b (D-185): the designer's handoff note (composer), and what approved designs handed to this task (read-only).
    submissionHandoff: { type: String, default: "", maxlength: 1000 },
    designHandoffs: [{
      _id: false,
      fromTask:  { type: Types.ObjectId, ref: "Task" },
      fromTitle: String,
      by:        String,
      note:      { type: String, default: "", maxlength: 1000 },
      links:     [{ _id: false, label: String, url: String }],
      files:     [{ _id: false, name: String, url: String }],
      at:        { type: Date, default: Date.now },
    }],
    aiEval: {
      type: new Schema({
        status:        { type: String, enum: ["pending", "done", "failed", "off", "limit", "skipped"], required: true },
        evidence:      { type: Schema.Types.Mixed, default: null },
        strengths:     [String],
        improvements:  [String],
        confidence:    { type: String, default: null },
        partial:       { type: Boolean, default: false },
        role:          { type: String, default: null },
        promptId:      { type: String, default: null },
        promptVersion: { type: Number, default: null },
        error:         { type: String, default: null },
        at:            { type: Date, default: Date.now },
      }, { _id: false }),
      default: null,
    },
    // AI score is hidden from every query unless selected ("+aiScore"): the TL must score first (spec §4, anchoring).
    aiScore:  { type: Number, min: 0, max: 100, default: null, select: false },
    aiScores: { type: Schema.Types.Mixed, default: null, select: false },
    tlScore: { type: Number, min: 0, max: 100, default: null }, // final score (D-063); stars = scoreToStars
    // Manager Flags (spec §5, D-076). ai_tl_disagreement at review; xp_outlier / rubber_stamp / burst at XP award (M-5).
    reviewFlags: [{
      kind:      { type: String, enum: ["ai_tl_disagreement", "xp_outlier", "rubber_stamp", "burst"], required: true },
      aiScore:   Number,
      tlScore:   Number,
      gap:       Number,
      by:        { type: Types.ObjectId, ref: "User" },
      status:    { type: String, enum: ["open", "dismissed", "confirmed"], default: "open" },
      createdAt: { type: Date, default: Date.now },
      // M-5: per-award flags (xp_outlier, rubber_stamp, burst) name the person; disagreement is task-wide.
      userId:     { type: Types.ObjectId, ref: "User", default: null },
      xp:         { type: Number, default: null },
      evidence:   { type: Schema.Types.Mixed, default: null },
      note:       { type: String, default: "" },
      reviewedBy: { type: Types.ObjectId, ref: "User", default: null },
      reviewedAt: { type: Date, default: null },
    }],

    // Review
    qualityScore: { type: Number, min: 1, max: 5, default: null },
    reviewNote:   { type: String, default: null },
    reviewedBy:   { type: Types.ObjectId, ref: "User", default: null },
    reviewedAt:   { type: Date, default: null },
    reviewStage: {
      type:    String,
      enum:    ["none", "senior_approved", "manager_pending"],
      default: "none",
    },

    // Lifecycle
    isLate:            { type: Boolean, default: false },
    resubmissionCount: { type: Number,  default: 0 },
    maxResubmissions:  { type: Number,  default: 3 },
    workloadWarning:   { type: Boolean, default: false },
    rejectionFeedback: { type: String,  default: null },

    // Deadline extensions
    extensionRequests: [
      {
        requestedBy:       { type: Types.ObjectId, ref: "User" },
        reason:            String,
        requestedDeadline: Date,
        status: {
          type:    String,
          enum:    ["PENDING", "APPROVED", "REJECTED"],
          default: "PENDING",
        },
        approvedBy:   { type: Types.ObjectId, ref: "User", default: null },
        approvalNote: { type: String, default: "" },
        createdAt:    { type: Date, default: Date.now },
      },
    ],

    // Milestone link
    milestoneId: { type: Types.ObjectId, ref: "Milestone", default: null },

    // V1 1.9: one level of subtasks + prerequisites (start blocked until all are Done)
    parentId:  { type: Types.ObjectId, ref: "Task", default: null, index: true },
    dependsOn: [{ type: Types.ObjectId, ref: "Task" }],

    // Team Lead review history
    revisionHistory: [
      {
        type:        { type: String, enum: ["revision_requested", "accepted"], default: "revision_requested" },
        comment:     { type: String, default: "" },
        requestedBy: { type: Types.ObjectId, ref: "User" },
        requestedAt: { type: Date, default: Date.now },
        unmetCriteria: { type: [String], default: [] }, // T-4: criteria the reviewer marked as not met
        source:      { type: String, enum: ["review", "qa"], default: "review" }, // E-4b (D-194): who sent it back
      },
    ],

    // Team ownership
    teamId: { type: Types.ObjectId, ref: "Team", default: null },

    // ── Workload engine fields ────────────────────────────────────────────────
    estimatedHours: { type: Number, default: null, min: 0.25, max: 200 },
    tags: { type: [{ type: String, trim: true, lowercase: true, maxlength: 24 }], validate: [(v) => v.length <= 5, "At most 5 tags"] },
    difficulty: {
      type:    String,
      enum:    ["Easy", "Medium", "Hard", "Critical"],
      default: "Medium",
    },
    // Role category required to work on this task (enforced by assignment engine)
    roleRequired: {
      type:    String,
      enum:    ["developer", "designer", "tester", "team_lead", "manager", "any"],
      default: "any",
    },
    // Actual logged hours (sum of timeLogs.minutes / 60)
    actualHours: { type: Number, default: 0, min: 0 },
    // Workload snapshot at assignment time
    assigneeLoadAtAssignment: { type: Number, default: null },

    labels: [String],

    // ── V2 Phase 4 · T-2 (D-118, D-122): quality, group, files ──────────────
    acceptanceCriteria: { type: [{ type: String, maxlength: 200 }], default: [], validate: [(v) => v.length <= 10, "At most 10 criteria"] },
    benchmark:  { type: String, default: "", maxlength: 1000 },
    qaRequired: { type: Boolean, default: false },
    // T-4 (D-137, D-021): Tester sign-off records; the newest one after the latest submission counts.
    // E-4 (D-189): withNotes = "Pass with notes" (still a pass for the approval gate); files = the Tester's evidence.
    qaSignoffs: [{ by: { type: Types.ObjectId, ref: "User" }, at: { type: Date, default: Date.now }, result: { type: String, enum: ["pass", "fail"], required: true }, note: { type: String, default: "", maxlength: 2000 },
      withNotes: { type: Boolean, default: false }, files: [{ _id: false, name: String, url: String, size: Number }] }],
    // Approved without a pass: who, when, why (logged, D-021).
    qaConditional: { type: new Schema({ by: { type: Types.ObjectId, ref: "User" }, at: Date, reason: String }, { _id: false }), default: null },
    groupTag:   { type: String, default: null, index: true }, // D-118: tasks made by one group assign share it
    attachments: [{
      name: String, url: String, size: Number,
      by: { type: Types.ObjectId, ref: "User" }, at: { type: Date, default: Date.now },
    }],

    comments: [
      {
        author:    { type: Types.ObjectId, ref: "User" },
        text:      String,
        createdAt: { type: Date, default: Date.now },
        // T-4 (D-139): who is mentioned, reactions (one per user per emoji), last edit.
        mentions:  [{ type: Types.ObjectId, ref: "User" }],
        reactions: [{ _id: false, emoji: String, user: { type: Types.ObjectId, ref: "User" } }],
        editedAt:  { type: Date, default: null },
      },
    ],

    // V1 1.7: per-task activity log (status, comments, assignment, submit, review, time). Last 200 kept.
    activity: [
      {
        kind: { type: String, enum: ["created", "status", "edited", "submitted", "reviewed", "escalated", "comment", "time", "extension"], required: true },
        by:   { type: Types.ObjectId, ref: "User", default: null },
        at:   { type: Date, default: Date.now },
        from: { type: String, default: null },
        to:   { type: String, default: null },
        note: { type: String, default: "", maxlength: 300 },
      },
    ],

    timeLogs: [
      {
        user:     { type: Types.ObjectId, ref: "User" },
        minutes:  Number,
        loggedAt: { type: Date, default: Date.now },
        note:     String,
      },
    ],
  },
  { timestamps: true }
);

// D-066: default xpValue from priority when the creator gave none.
taskSchema.pre("validate", function () {
  if (this.xpValue === null || this.xpValue === undefined) this.xpValue = defaultXpValue(this.priority);
  if (this.isNew && !this.activity?.length) this.activity = [{ kind: "created", by: this.createdBy, to: this.status }];
});

// 4.2a: every new task inherits its project's team, so the capacity heatmap can count it.
taskSchema.pre("save", async function () {
  if (!this.isNew || this.teamId || !this.projectId) return;
  const project = await this.model("Project").findById(this.projectId, "teamId").lean();
  if (project?.teamId) this.teamId = project.teamId;
});

// V1 1.7: append one activity entry; never blocks the request that caused it.
taskSchema.statics.logActivity = function (taskId, by, kind, extra = {}) {
  const entry = { kind, by: by ?? null, at: new Date(), ...extra };
  if (entry.note) entry.note = String(entry.note).slice(0, 300);
  return this.updateOne({ _id: taskId }, { $push: { activity: { $each: [entry], $slice: -200 } } })
    .catch((e) => console.error("[activity]", e.message));
};

taskSchema.index({ orgId: 1, status: 1 });
taskSchema.index({ orgId: 1, deadline: 1, status: 1 });
taskSchema.index({ teamId: 1 });
taskSchema.index({ assignees: 1, status: 1 });
taskSchema.index({ assignee: 1, status: 1 });
taskSchema.index({ projectId: 1 });
taskSchema.index({ milestoneId: 1 });
taskSchema.index({ createdBy: 1 });
taskSchema.index({ reviewedBy: 1 });

// T-2 (D-124): when a task reaches Done, the tasks that were waiting only for it get an "unblocked" notification.
// Hooked here so every Done path (both review routes) is covered without touching the review code.
taskSchema.pre("save", function () { this.$locals.becameDone = this.isModified("status") && this.status === "Done"; });
taskSchema.post("save", function (doc) { if (doc.$locals?.becameDone) notifyUnblocked(doc); });
taskSchema.post("findOneAndUpdate", function (doc) {
  const u = this.getUpdate() ?? {};
  if (doc?.status === "Done" && (u.$set?.status === "Done" || u.status === "Done")) notifyUnblocked(doc);
});
function notifyUnblocked(doc) {
  import("../services/dependencyNotify.js").then((m) => m.notifyUnblocked(doc)).catch((e) => console.error("[unblock]", e.message));
}

export default model("Task", taskSchema);
