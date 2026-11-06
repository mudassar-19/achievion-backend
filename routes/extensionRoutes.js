import { Router } from "express";
import { verifyToken, requireRole } from "../middleware/authMiddleware.js";
import { requestExtension, listExtensions } from "../controllers/extensionController.js";

const router = Router();
router.use(verifyToken);

// Manager/TL: list own extensions; Director reads from /api/director/extensions
router.get("/",  requireRole("Manager", "Team Lead"), listExtensions);
// Manager submits extension request
router.post("/", requireRole("Manager", "Team Lead"), requestExtension);

export default router;
