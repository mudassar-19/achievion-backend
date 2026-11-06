import { Schema, model, Types } from "mongoose";
import { createHash } from "crypto";

// D-022e: one Session doc per login; TTL = 30 days from lastSeenAt.
// tokenVersion on User is incremented to revoke all sessions at once.

const sessionSchema = new Schema(
  {
    userId:    { type: Types.ObjectId, ref: "User", required: true, index: true },
    orgId:     { type: Types.ObjectId, ref: "Organization", default: null },

    // SHA-256 of the raw JWT so the token is not stored in plain text.
    tokenHash: { type: String, required: true, unique: true },

    tokenVersion: { type: Number, default: 0 },

    // Device fingerprint from User-Agent
    device: { type: String, default: "Unknown" },
    ip:     { type: String, default: null },

    // TTL index: MongoDB auto-deletes doc 30 days after lastSeenAt
    lastSeenAt: { type: Date, default: Date.now, index: { expireAfterSeconds: 2592000 } },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

sessionSchema.statics.hashToken = (raw) =>
  createHash("sha256").update(raw).digest("hex");

export default model("Session", sessionSchema);
