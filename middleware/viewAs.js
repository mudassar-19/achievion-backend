// View as (D-109): request guard + database write block.
// 1. viewAsGuard (mounted on /api before every route): a view-as token may only GET; every other method → 403
//    "View-as is read-only" (except POST /api/auth/view-as/exit); AI routes → 403.
// 2. The rest of a view-as GET runs inside a read-only context. The Mongoose plugin refuses every write in that
//    context, so a GET that normally writes (auto-create, read-time refresh, notifications) cannot write either.
// 3. HP/wellbeing fields stripped from every view-as JSON response (D-218).
// 4. Blocked attempts logged to AuditLog (throttled, max 1/viewer/path/minute) (D-218).
import { AsyncLocalStorage } from "node:async_hooks";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { guardDecision, READ_ONLY_ERROR } from "../services/viewAsRules.js";
import AuditLog from "../models/AuditLog.js";

const als = new AsyncLocalStorage();
export const isReadOnly = () => als.getStore()?.readOnly === true;
export const runReadOnly = (fn) => als.run({ readOnly: true }, fn);

// ponytail: global in-memory Map; per-process, lost on restart; sufficient for flood protection
const _blocked = new Map();
function _canLog(viewerId, path) {
  const key = `${viewerId}|${path}`;
  if (Date.now() - (_blocked.get(key) ?? 0) < 60_000) return false;
  _blocked.set(key, Date.now());
  return true;
}
function _logBlocked(decoded, req) {
  const viewerId = decoded?.viewAs?.viewerId;
  if (!viewerId || !_canLog(viewerId, req.originalUrl)) return;
  AuditLog.create({
    action:       "view_as_blocked",
    performedBy:  viewerId,
    targetUserId: decoded.id ?? null,
    orgId:        decoded.orgId ?? null,
    detail:       `Blocked ${req.method} ${req.originalUrl} in view-as`,
    ip:           req.ip ?? null,
    device:       req.headers["user-agent"]?.slice(0, 200) ?? null,
    scope:        "account",
  }).catch((e) => console.warn("[view-as] audit log failed:", e.message));
}

const HP_KEYS = new Set(["hp", "burnoutRisk", "burnoutRiskLabel", "wellbeing"]);
export function deepStripHp(val) {
  if (!val || typeof val !== "object") return val;
  if (typeof val.toJSON === "function") return deepStripHp(val.toJSON()); // Date → ISO string, ObjectId → string, document → plain: exactly what res.json would send
  if (Array.isArray(val)) return val.map(deepStripHp);
  const out = {};
  for (const [k, v] of Object.entries(val)) out[k] = HP_KEYS.has(k) ? null : deepStripHp(v);
  return out;
}

export function viewAsGuard(req, res, next) {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Bearer ")) return next();
  let decoded = null;
  try { decoded = jwt.verify(h.slice(7).trim(), process.env.JWT_SECRET); } catch { return next(); } // verifyToken answers bad tokens
  const viewAs = decoded?.viewAs ?? null;
  const d = guardDecision({ method: req.method, path: req.originalUrl, viewAs });
  if (d.block) {
    _logBlocked(decoded, req);
    return res.status(d.block.status).json({ error: d.block.error, code: "view_as_read_only" });
  }
  if (!d.readOnly) return next();
  const origJson = res.json.bind(res);
  res.json = (body) => origJson(deepStripHp(body));
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
