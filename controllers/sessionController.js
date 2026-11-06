import Session      from "../models/Session.js";
import User         from "../models/User.js";
import AuditLog     from "../models/AuditLog.js";
import mongoose     from "mongoose";
import jwt          from "jsonwebtoken";
import { ROLE_CATEGORY_MAP } from "../models/User.js";

function signToken(user) {
  return jwt.sign(
    {
      id:           user._id.toString(),
      email:        user.email,
      role:         user.role,
      roleCategory: user.roleCategory ?? ROLE_CATEGORY_MAP[user.role] ?? "developer",
      name:         user.name,
      orgId:        user.orgId ?? null,
      tokenVersion: user.tokenVersion ?? 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN ?? "7d" }
  );
}

// ── GET /api/auth/sessions  — list active sessions for current user ────────────
export async function listSessions(req, res) {
  const { id: userId } = req.user;
  const current = Session.hashToken(req.headers.authorization?.replace("Bearer ", "") ?? "");

  const sessions = await Session.find({ userId: new mongoose.Types.ObjectId(userId) })
    .sort({ lastSeenAt: -1 })
    .lean();

  res.json({
    sessions: sessions.map((s) => ({
      id:        s._id,
      device:    s.device,
      ip:        s.ip,
      lastSeenAt: s.lastSeenAt,
      createdAt: s.createdAt,
      isCurrent: s.tokenHash === current,
    })),
  });
}

// ── POST /api/auth/sessions/sign-out-others  — revoke all other sessions ──────
export async function signOutOtherSessions(req, res) {
  const { id: userId, orgId } = req.user;
  const current = Session.hashToken(req.headers.authorization?.replace("Bearer ", "") ?? "");

  // Delete all sessions except current
  const result = await Session.deleteMany({
    userId:    new mongoose.Types.ObjectId(userId),
    tokenHash: { $ne: current },
  });

  // Increment tokenVersion so old JWTs also fail; re-sign current token with new version
  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { $inc: { tokenVersion: 1 } },
    { returnDocument: "after", new: true }
  ).lean();

  const newToken = signToken(updatedUser);
  const newHash  = Session.hashToken(newToken);

  // Update current session with new tokenHash
  await Session.updateOne({ tokenHash: current }, { $set: { tokenHash: newHash, lastSeenAt: new Date() } });

  const orgOid = /^[0-9a-f]{24}$/i.test(orgId)
    ? new mongoose.Types.ObjectId(orgId)
    : null;

  await AuditLog.create({
    action:      "session_revoked",
    orgId:       orgOid,
    performedBy: new mongoose.Types.ObjectId(userId),
    detail:      `${result.deletedCount} other session(s) revoked`,
    scope:       "session",
  });

  res.json({ revoked: result.deletedCount, token: newToken });
}

// ── Middleware helper: touch lastSeenAt on authenticated routes ───────────────
// Called from verifyToken after validation succeeds.
export async function touchSession(tokenHash, userId) {
  await Session.updateOne(
    { tokenHash, userId: new mongoose.Types.ObjectId(userId) },
    { $set: { lastSeenAt: new Date() } }
  ).catch(() => {});  // fire-and-forget; never block the request
}
