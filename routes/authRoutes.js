import { Router } from "express";
import { groupsFor, LANDINGS } from "../services/notificationPrefs.js";
import { isRankable } from "../services/leaderboardRules.js";
import { register, login, getMe, getProfile, updateMe, changePassword, forgotPassword, resetPassword, updateSettings, getManagerProfileSummary } from "../controllers/authController.js";
import { listSessions, signOutOtherSessions } from "../controllers/sessionController.js";
import { verifyToken }                              from "../middleware/authMiddleware.js";
import * as viewAs                                 from "../controllers/viewAsController.js";

const router = Router();

// Public
router.post("/register",        register);
router.post("/login",           login);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password",  resetPassword);

// Protected — requires a valid JWT
router.get( "/me",       verifyToken, getMe);
router.get( "/profile",  verifyToken, getProfile);
router.get( "/manager-profile-summary", verifyToken, getManagerProfileSummary);
router.patch("/me",       verifyToken, updateMe);
router.patch("/password", verifyToken, changePassword);
router.patch("/settings", verifyToken, updateSettings);
// U-1 (D-131): which notification groups and landing pages this role has (the Settings page draws from this).
router.get("/settings/options", verifyToken, (req, res) => res.json({
  groups: groupsFor(req.user.role).map(({ key, label, desc, locked }) => ({ key, label, desc, locked })),
  landings: (LANDINGS[req.user.role] ?? LANDINGS.contributor).map(([key, label]) => ({ key, label })),
  celebrations: isRankable(req.user.role),
  aiPanel: ["Manager", "Director", "Team Lead"].includes(req.user.role),
  dateTime: ["Manager", "Team Lead"].includes(req.user.role),
}));

// Sessions — D-022e
router.get( "/sessions",                  verifyToken, listSessions);
router.post("/sessions/sign-out-others",  verifyToken, signOutOtherSessions);

// View as — AUTH-11, D-109 (read-only; middleware/viewAs.js guards every request)
router.get( "/view-as/candidates",        verifyToken, viewAs.candidates);
router.post("/view-as",                   verifyToken, viewAs.start);
router.post("/view-as/exit",              verifyToken, viewAs.exit);

export default router;
