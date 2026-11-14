import { Router } from "express";
import { registerOrg, loginOrg, getOrgMe, setupDirector, validateInvite } from "../controllers/orgAuthController.js";
import {
  getDashboard,
  createEmployee,
  listEmployees,
  getEmployee,
  updateEmployeeRole,
  updateEmployeeStatus,
  deleteEmployee,
  listOrgApprovals,
  listDeletedEmployees,
} from "../controllers/orgAdminController.js";
import { verifyOrgToken } from "../middleware/orgAuth.js";

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────────
router.post("/register",        registerOrg);
router.post("/login",           loginOrg);
router.post("/validate-invite", validateInvite);

// ── Protected (org admin JWT required) ───────────────────────────────────────
router.use(verifyOrgToken);

router.get("/me",                          getOrgMe);
router.post("/setup-director",             setupDirector);
router.get("/dashboard",                   getDashboard);

router.get("/employees",                   listEmployees);
router.post("/employees/create",           createEmployee);
router.get("/employees/deleted",           listDeletedEmployees);  // must precede /:userId
router.get("/employees/:userId",           getEmployee);
router.patch("/employees/:userId/role",    updateEmployeeRole);
router.patch("/employees/:userId/status",  updateEmployeeStatus);
router.delete("/employees/:userId",        deleteEmployee);

router.get("/approvals",                   listOrgApprovals);

export default router;
