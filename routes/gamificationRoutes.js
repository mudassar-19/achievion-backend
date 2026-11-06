import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import { getLeaderboard, getBadges, getProfile, getAvatar, saveAvatar, getTitles, equipTitle } from "../controllers/gamificationController.js";

const router = Router();

router.use(verifyToken);

router.get("/profile",      getProfile);
router.get("/leaderboard",  getLeaderboard);
router.get("/badges",       getBadges);
router.get("/avatar",       getAvatar);
router.put("/avatar",       saveAvatar);
router.get("/titles",       getTitles);
router.put("/titles/equip", equipTitle);

export default router;
