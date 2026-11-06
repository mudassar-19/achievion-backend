// View as (D-109): request guard + database write block.
// 1. viewAsGuard (mounted on /api before every route): a view-as token may only GET; every other method → 403
//    "View-as is read-only" (except POST /api/auth/view-as/exit); AI routes → 403.
// 2. The rest of a view-as GET runs inside a read-only context. The Mongoose plugin refuses every write in that
//    context, so a GET that normally writes (auto-create, read-time refresh, notifications) cannot write either.
import { AsyncLocalStorage } from "node:async_hooks";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { guardDecision, READ_ONLY_ERROR } from "../services/viewAsRules.js";

const als = new AsyncLocalStorage();
export const isReadOnly = () => als.getStore()?.readOnly === true;
export const runReadOnly = (fn) => als.run({ readOnly: true }, fn);

export function viewAsGuard(req, res, next) {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Bearer ")) return next();
  let viewAs = null;
  try { viewAs = jwt.verify(h.slice(7).trim(), process.env.JWT_SECRET)?.viewAs ?? null; } catch { return next(); } // verifyToken answers bad tokens
  const d = guardDecision({ method: req.method, path: req.originalUrl, viewAs });
  if (d.block) return res.status(d.block.status).json({ error: d.block.error, code: "view_as_read_only" });
  if (!d.readOnly) return next();
  runReadOnly(() => next());
}

const WRITE_OPS = ["save", "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "replaceOne", "deleteOne", "deleteMany"];
const MODEL_OPS = ["insertMany", "bulkWrite"];
// Registered globally below; server.js imports this module before any model is compiled.
// ponytail: Model.collection.* (native driver) bypasses hooks; the request guard still blocks every non-GET.
function block(op) {
  return function () {
    if (!isReadOnly()) return;
    console.warn(`[view-as] write blocked: ${this?.modelName ?? this?.constructor?.modelName ?? this?.model?.modelName ?? "?"}.${op}`);
    throw Object.assign(new Error(READ_ONLY_ERROR), { status: 403, viewAsReadOnly: true });
  };
}
export function readOnlyPlugin(schema) {
  for (const op of WRITE_OPS) schema.pre(op, { document: true, query: true }, block(op));
  for (const op of MODEL_OPS) schema.pre(op, block(op));
}
mongoose.plugin(readOnlyPlugin);
