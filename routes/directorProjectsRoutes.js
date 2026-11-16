// UI-B: additive read-only Director routes (project page + module page). Mounted on /api/director before
// directorRoutes; the guard is per route so every other /api/director request falls through untouched.
import { Router } from "express";
import { verifyToken, requireRole } from "../middleware/authMiddleware.js";
import { getProjectOverview, getProjectModule } from "../controllers/directorProjectsController.js";

const router = Router();
const director = [verifyToken, requireRole("Director")];

router.get("/projects/:id/overview",          director, getProjectOverview);
router.get("/projects/:id/modules/:moduleId", director, getProjectModule);

export default router;
