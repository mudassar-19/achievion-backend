import { Router }   from "express";
import { verifyToken, requireRole } from "../middleware/authMiddleware.js";
import {
  getPendingApprovals,
  getApprovalHistory,
  approveRequest,
  rejectRequest,
} from "../controllers/approvalController.js";

import { directorDecisions } from "../controllers/decisionController.js";

const router = Router();

// All approval routes require authentication and Director role
router.use(verifyToken, requireRole("Director"));

router.get("/",          getPendingApprovals);
router.get("/history",   getApprovalHistory);
router.get("/decisions", directorDecisions); // items 10/55: decided requests with both notes
router.post("/:id/approve", approveRequest);
router.post("/:id/reject",  rejectRequest);

export default router;
