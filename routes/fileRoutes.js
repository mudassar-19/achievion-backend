import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import { signFile } from "../controllers/fileController.js";

const router = Router();
router.get("/sign", verifyToken, signFile);
export default router;
