import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import {
  getNotifications,
  getUnreadCount,
  markAllRead,
  markOneRead,
  deleteOne,
  deleteAll,
} from "../controllers/notificationController.js";

const router = Router();

router.use(verifyToken);

router.get("/",               getNotifications);
router.get("/unread-count",   getUnreadCount);
router.patch("/read-all",     markAllRead);
router.patch("/:id/read",     markOneRead);
router.delete("/:id",         deleteOne);
router.delete("/",            deleteAll);

export default router;
