// Asset Booking (D-295, IMPL-5 Part 5). Manager books an asset for a time window.
// Overlap check is race-safe via atomic findOneAndUpdate (see assetBookingController).
import { Schema, model, Types } from "mongoose";

const assetBookingSchema = new Schema(
  {
    orgId:     { type: String,              required: true, index: true },
    assetId:   { type: Types.ObjectId,      ref: "Asset", required: true },
    projectId: { type: Types.ObjectId,      ref: "Project", default: null },
    bookedBy:  { type: Types.ObjectId,      ref: "User", required: true },
    from:      { type: Date,                required: true },
    to:        { type: Date,                required: true },
    note:      { type: String,              trim: true, maxlength: 500, default: "" },
    status:    { type: String,              enum: ["active", "cancelled"], default: "active" },
  },
  { timestamps: true }
);

assetBookingSchema.index({ orgId: 1, assetId: 1, status: 1, from: 1, to: 1 });

export default model("AssetBooking", assetBookingSchema);
