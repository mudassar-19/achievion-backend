import jwt  from "jsonwebtoken";
import User from "../models/User.js";

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
  const header = req.headers.authorization ?? "";

  if (!header.startsWith("Bearer ")) {
    return next(authError("Authentication required — please log in."));
  }

  const token = header.slice(7).trim();

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    const message =
      err.name === "TokenExpiredError"
        ? "Session expired — please log in again."
        : "Invalid authentication token.";
    return next(authError(message));
  }

  try {
    const dbUser = await User.findById(decoded.id)
      .select("tokenVersion status orgId role")
      .lean();

    if (!dbUser) return res.status(401).json({ error: "User not found" });

    if (dbUser.tokenVersion !== (decoded.tokenVersion ?? 0)) {
      return res.status(401).json({ error: "Session expired. Please login again." });
    }

    if (dbUser.status === "suspended") {
      return res.status(403).json({ error: "Account suspended" });
    }

    // View as (D-109): the token is the target's; the viewer must still be valid, in the same org, same session.
    if (decoded.viewAs) {
      const viewer = await User.findById(decoded.viewAs.viewerId).select("tokenVersion status orgId role").lean();
      if (!viewer || viewer.status === "suspended" || String(viewer.orgId) !== String(dbUser.orgId)
        || viewer.tokenVersion !== (decoded.viewAs.viewerTokenVersion ?? 0) || viewer.role !== decoded.viewAs.viewerRole) {
        return res.status(401).json({ error: "This view has ended. Please sign in again." });
      }
      req.viewAs = decoded.viewAs;
    }

    req.user = {
      _id:   decoded.id,
      id:    decoded.id,
      role:  decoded.role,
      orgId: dbUser.orgId?.toString() || decoded.orgId,
      email: decoded.email,
      name:  decoded.name,
      roleCategory: decoded.roleCategory,
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
