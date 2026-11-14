import { Schema, model, Types } from "mongoose";

// D-242: append-only purchase ledger — one document per successful buy.
const shopPurchaseSchema = new Schema(
  {
    userId:         { type: Types.ObjectId, ref: "User",         required: true, index: true },
    orgId:          { type: Types.ObjectId, ref: "Organization", required: true },
    itemId:         { type: String,  required: true },
    goldPaid:       { type: Number,  required: true, min: 0 },
    idempotencyKey: { type: String,  default: null },
    purchasedAt:    { type: Date,    default: Date.now },
  },
  { timestamps: false }
);

// D-243: idempotency guard — one purchase per key per user (sparse so null keys don't collide)
shopPurchaseSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

// Append-only: no updates or deletes
const appendOnly = () => { throw new Error("ShopPurchase is append-only"); };
shopPurchaseSchema.pre("save", function () { if (!this.isNew) appendOnly(); });
for (const op of ["updateOne", "updateMany", "replaceOne", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "deleteOne", "deleteMany"]) {
  shopPurchaseSchema.pre(op, appendOnly);
}

export default model("ShopPurchase", shopPurchaseSchema);
