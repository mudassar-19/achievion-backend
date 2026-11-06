// Manager Resources → Assets (V2 Phase 3 · M-4, FR11-05): tools, licences and file links, linked to projects.
import { Schema, model, Types } from "mongoose";

const assetSchema = new Schema(
  {
    orgId:      { type: String, required: true, index: true },
    name:       { type: String, required: true, trim: true, maxlength: 120 },
    type:       { type: String, enum: ["Tool", "License", "File link"], required: true },
    url:        { type: String, default: "" },
    notes:      { type: String, default: "", maxlength: 1000 },
    expiresAt:  { type: Date, default: null },
    projectIds: [{ type: Types.ObjectId, ref: "Project" }],
    createdBy:  { type: Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);
assetSchema.index({ orgId: 1, projectIds: 1 });

export default model("Asset", assetSchema);
