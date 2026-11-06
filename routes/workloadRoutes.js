import { Router } from "express";
import { verifyToken, requireRole } from "../middleware/authMiddleware.js";
import {
  getOrgWorkload,
  getEmployeeWorkload,
  validateAssignment,
  validateMilestone,
  getSuggestions,
  getTeamWorkload,
  getProjectCapacity,
  getRoleEligibility,
} from "../controllers/workloadController.js";

const router = Router();

router.use(verifyToken);

// ── Org-wide health (Manager / Director only) ─────────────────────────────────
router.get("/org",    requireRole("Manager", "Director"), getOrgWorkload);

// ── Team workload (TL sees dept, Manager sees all) ────────────────────────────
router.get("/team",   requireRole("Team Lead", "Manager", "Director"), getTeamWorkload);

// ── Per-employee snapshot ─────────────────────────────────────────────────────
router.get("/employee/:id", requireRole("Team Lead", "Manager", "Director"), getEmployeeWorkload);

// ── Project capacity ─────────────────────────────────────────────────────────
router.get("/project/:id/capacity", requireRole("Team Lead", "Manager", "Director"), getProjectCapacity);

// ── Validation endpoints (pre-assign, pre-milestone) ─────────────────────────
router.post("/validate-assignment", requireRole("Team Lead", "Manager"), validateAssignment);
router.post("/validate-milestone",  requireRole("Team Lead", "Manager"), validateMilestone);

// ── Smart suggestions ─────────────────────────────────────────────────────────
router.get("/suggestions", requireRole("Team Lead", "Manager"), getSuggestions);

// ── Role eligibility map (public within auth) ─────────────────────────────────
router.get("/role-eligibility", getRoleEligibility);

export default router;
