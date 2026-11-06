import mongoose, { Schema } from "mongoose";

const SavedPortfolioViewSchema = new Schema({
  orgId:    { type: String,                    required: true, index: true },
  userId:   { type: Schema.Types.ObjectId, ref: "User", required: true },
  name:     { type: String, required: true, trim: true, maxlength: 80 },
  filters:  {
    status:        { type: String,  default: null }, // e.g. "Active"
    managerId:     { type: String,  default: null },
    deadlineFrom:  { type: Date,    default: null },
    deadlineTo:    { type: Date,    default: null },
  },
}, { timestamps: true });

SavedPortfolioViewSchema.index({ orgId: 1, userId: 1 });

export default mongoose.model("SavedPortfolioView", SavedPortfolioViewSchema);
