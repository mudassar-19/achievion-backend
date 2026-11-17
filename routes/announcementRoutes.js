import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import { getAnnouncements, markAnnouncementsRead, postAnnouncement } from "../controllers/announcementController.js";

// Items 79, 80: the Announcements feed for every employee portal (an Org admin token is refused by verifyToken: no chat there).
const router = Router();
router.use(verifyToken);
router.get("/",       getAnnouncements);
router.post("/read",  markAnnouncementsRead);
router.post("/",      postAnnouncement);
export default router;
