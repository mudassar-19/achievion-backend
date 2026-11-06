import jwt from "jsonwebtoken";

function orgAuthError(message, status = 401) {
  const err = new Error(message);
  err.status = status;
  err.expose  = true;
  return err;
}

// ── verifyOrgToken ────────────────────────────────────────────────────────────
// Validates a Software House JWT (type: "org").
// Attaches req.org = { orgId, orgDbId, orgName, role } on success.
// Must NOT be used on employee routes — those use verifyToken from authMiddleware.
export function verifyOrgToken(req, _res, next) {
  const header = req.headers.authorization ?? "";

  if (!header.startsWith("Bearer ")) {
    return next(orgAuthError("Organisation authentication required."));
  }

  const token = header.slice(7).trim();

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.type !== "org") {
      return next(orgAuthError("This endpoint requires a Software House token.", 403));
    }

    // { orgId, orgDbId, role, type, name, iat, exp }
    req.org = {
      orgId:   decoded.orgId,
      orgDbId: decoded.orgDbId,
      name:    decoded.name,
      role:    decoded.role,
    };

    next();
  } catch (err) {
    const message =
      err.name === "TokenExpiredError"
        ? "Session expired — please log in again."
        : "Invalid organisation token.";
    next(orgAuthError(message));
  }
}
