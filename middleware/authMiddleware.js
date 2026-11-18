import { shouldTouch } from "../services/presenceRules.js";
import jwt  from "jsonwebtoken";
import User, { ROLE_CATEGORY_MAP } from "../models/User.js";
import Session from "../models/Session.js";
import { effectiveRole } from "../services/authRules.js";
import { logAuthFail } from "../utils/authLog.js";

// ── Token error factory ────────────────────────────────────────────────────────
function authError(message, status = 401) {
  const err = new Error(message);
  err.status = status;
  err.expose  = true; // safe to send to client
  return err;
}

// ── verifyToken ───────────────────────────────────────────────────────────────
// Extracts the Bearer token from the Authorization header, verifies it, and
// attaches the decoded payload to req.user.  Works with Express 5 (async
// errors propagate automatically) but uses try/catch for explicit control.
export async function verifyToken(req, res, next) {
  // SEC: every 401 here carries a machine-readable `code` (and a [auth-fail] log line) so a logout can always be explained.
  const deny = (status, code, message, userId) => { logAuthFail(req, code, userId); return res.status(status).json({ error: message, code }); };
  const header = req.headers.authorization ?? "";

  if (!header.startsWith("Bearer ")) return deny(401, "NO_TOKEN", "Authentication required — please log in.");

  const token = header.slice(7).trim();

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return err.name === "TokenExpiredError" ? deny(401, "EXPIRED", "Session expired — please log in again.") : deny(401, "BAD_TOKEN", "Invalid authentication token.");
  }

  try {
    // The Session lookup runs IN PARALLEL with the user lookup, so it adds no waiting time (measured: one extra round trip when it was serial).
    const sessionP = !decoded.viewAs && decoded.jti ? Session.findOne({ jti: decoded.jti }, "revokedAt lastSeenAt").lean().catch(() => null) : null;
    const dbUser = await User.findById(decoded.id)
      .select("tokenVersion status orgId role lastSeenAt")
      .lean();

    if (!dbUser) return deny(401, "DELETED", "User not found", decoded.id);

    if (dbUser.tokenVersion !== (decoded.tokenVersion ?? 0)) return deny(401, "TOKEN_VERSION", "Session expired. Please login again.", decoded.id);

    if (dbUser.status === "suspended") return deny(403, "SUSPENDED", "Account suspended", decoded.id);
    if (dbUser.status === "deleted") return deny(401, "DELETED", "Account no longer exists.", decoded.id);

    // View as (D-109): the token is the target's; the viewer must still be valid, in the same org, same session.
    if (decoded.viewAs) {
      const viewer = await User.findById(decoded.viewAs.viewerId).select("tokenVersion status orgId role").lean();
      if (!viewer || viewer.status === "suspended" || String(viewer.orgId) !== String(dbUser.orgId)
        || viewer.tokenVersion !== (decoded.viewAs.viewerTokenVersion ?? 0) || viewer.role !== decoded.viewAs.viewerRole) {
        return deny(401, "VIEW_ENDED", "This view has ended. Please sign in again.", decoded.id);
      }
      req.viewAs = decoded.viewAs;
    }

    // SEC M-2/M-3: this one session, by its jti. A revoked session (logout) is refused; a token with no Session row (older token) stays valid;
    // last seen is written at most once a minute. Never for a View as visit.
    if (!decoded.viewAs && decoded.jti) {
      const sess = await sessionP;
      if (sess?.revokedAt) return deny(401, "SESSION_REVOKED", "You signed out of this session. Please log in again.", decoded.id);
      if (sess && shouldTouch(sess.lastSeenAt)) Session.updateOne({ _id: sess._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
    }

    // X17 (FR01-11): last seen, at most one small write a minute per person; never for a View as visit.
    if (!decoded.viewAs && shouldTouch(dbUser.lastSeenAt)) User.updateOne({ _id: decoded.id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});

    // SEC M-22: the role comes from the database, not the token, so a role change takes effect at once without signing anybody out.
    const { role, roleCategory } = effectiveRole(decoded, dbUser, ROLE_CATEGORY_MAP);
    req.user = {
      _id:   decoded.id,
      id:    decoded.id,
      role,
      orgId: dbUser.orgId?.toString() || decoded.orgId,
      email: decoded.email,
      name:  decoded.name,
      roleCategory,
    };

    next();
  } catch (err) {
    next(err);
  }
}

// ── requireRole ───────────────────────────────────────────────────────────────
// Role-guard middleware factory.  Must be used AFTER verifyToken in the chain.
// Usage: router.get("/admin", verifyToken, requireRole("Director"), handler)
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(authError("Authentication required — please log in."));
    }

    if (!roles.includes(req.user.role)) {
      return next(
        authError(
          `Access denied. This endpoint requires role: ${roles.join(" or ")}.`,
          403
        )
      );
    }

    next();
  };
}
