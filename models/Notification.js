import mongoose, { Schema, model, Types } from "mongoose";
import { isMuted } from "../services/notificationPrefs.js";

const notificationSchema = new Schema(
  {
    userId:  { type: Types.ObjectId, ref: "User", required: true, index: true },
    orgId:   { type: String, index: true, default: null },
    type:    { type: String, required: true },
    title:   { type: String, default: "" },
    message: { type: String, required: true },
    read:      { type: Boolean, default: false },
    meta:      { type: Schema.Types.Mixed, default: {} },
    // ── Slice 3a new fields ────────────────────────────────────────────────────
    tier:      { type: String, enum: ["critical","needs_action","fyi"], default: "fyi" },
    deepLink:  { type: String, default: null },
    muteUntil: { type: Date,   default: null },
    digestId:  { type: String, default: null },
    expiresAt: { type: Date,   default: null },
    // U-1 (D-131): switched off in this person's Settings → kept as read and hidden from lists and counts.
    muted:     { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.pre("save", async function () {
  if (!this.isNew) return;
  const u = await mongoose.model("User").findById(this.userId, "role settings").lean();
  if (u && isMuted({ role: u.role, prefs: u.settings?.notifications, type: this.type, message: this.message })) { this.muted = true; this.read = true; }
});

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, tier: 1, read: 1, createdAt: -1 });

export default model("Notification", notificationSchema);
