import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import { createReport } from "../controllers/voiceController.js";

const router = Router();
router.use(verifyToken);

// Any authenticated employee can submit a voice report
router.post("/", createReport);

export default router;
