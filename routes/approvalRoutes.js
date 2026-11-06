import { Router }   from "express";
import { verifyToken, requireRole } from "../middleware/authMiddleware.js";
import {
  getPendingApprovals,
  getApprovalHistory,
  approveRequest,
  rejectRequest,
} from "../controllers/approvalController.js";

const router = Router();

// All approval routes require authentication and Director role
router.use(verifyToken, requireRole("Director"));

router.get("/",          getPendingApprovals);
router.get("/history",   getApprovalHistory);
router.post("/:id/approve", approveRequest);
router.post("/:id/reject",  rejectRequest);

export default router;
