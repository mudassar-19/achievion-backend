// Cached Manager AI results (V2 Phase 3 · M-7, D-106): the dashboard insight once a day, narratives per
// filters/day, so free-tier tokens are not spent on every page view. Expires on its own (TTL index).
import { Schema, model } from "mongoose";

const aiCacheSchema = new Schema({
  key:       { type: String, required: true, unique: true, maxlength: 400 },
  orgId:     { type: String, required: true },
  feature:   { type: String, required: true },
  value:     { type: Schema.Types.Mixed, required: true },
  dismissed: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

aiCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model("AICache", aiCacheSchema);
