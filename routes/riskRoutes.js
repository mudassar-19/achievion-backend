import { Router } from "express";
import { verifyToken, requireRole } from "../middleware/authMiddleware.js";
import { createRisk, listRisks, updateRisk } from "../controllers/riskController.js";

const router = Router();
router.use(verifyToken);

// D-022b: Manager + Director only
const guard = requireRole("Manager", "Director");

router.get("/",      guard, listRisks);
router.post("/",     guard, createRisk);
router.patch("/:id", guard, updateRisk);

export default router;
