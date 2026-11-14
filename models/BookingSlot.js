// BookingSlot — one document per (assetId, day) for atomic overlap detection (D-295-b).
// Unique index on {assetId, day} means insertMany of a range of days fails atomically
// on E11000 if any day is already taken, giving true race safety without transactions.
import { Schema, model, Types } from "mongoose";

const bookingSlotSchema = new Schema({
  assetId:   { type: Types.ObjectId, required: true },
  day:       { type: String, required: true },      // YYYY-MM-DD UTC
  bookingId: { type: Types.ObjectId, required: true, index: true },
}, { _id: false, timestamps: false });

bookingSlotSchema.index({ assetId: 1, day: 1 }, { unique: true });

export default model("BookingSlot", bookingSlotSchema);
