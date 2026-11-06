import express    from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import * as teamCtrl  from "../controllers/teamController.js";

const router = express.Router();
router.use(verifyToken);

router.get("/",    teamCtrl.getTeams);
router.post("/",   teamCtrl.createTeam);
router.get("/:id", teamCtrl.getTeam);
router.patch("/:id",  teamCtrl.updateTeam);
router.delete("/:id", teamCtrl.archiveTeam);

router.post("/:id/members",              teamCtrl.addMember);
router.delete("/:id/members/:userId",    teamCtrl.removeMember);
router.patch("/:id/lead",                teamCtrl.assignTeamLead);

router.get("/:id/availability",  teamCtrl.getTeamAvailability);
router.get("/:id/analytics",     teamCtrl.getTeamAnalytics);
router.get("/:id/leaderboard",   teamCtrl.getTeamLeaderboard);

export default router;
