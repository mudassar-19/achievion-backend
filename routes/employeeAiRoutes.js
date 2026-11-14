// Employee AI (Batch 4: E14 chat + /tasks /xp, E15 personas + tips, N11 leaderboard line, N12 analytics summary).
// Mounted under /api/workspace/ai by workspaceRoutes.js, so verifyToken (401) and the employee-only gate (403) already ran.
import { Router } from "express";
import { getStatus, chat, getTips, getBoardLine, getAnalyticsSummary } from "../controllers/employeeAiController.js";

const router = Router();
// D-109: view-as is read-only and the AI is off there (a viewer must not spend someone's daily AI requests).
router.use((req, res, next) => (req.viewAs ? res.status(403).json({ error: "AI is off while viewing as someone.", code: "view_as" }) : next()));
router.get("/status", getStatus);
router.post("/chat", chat);
router.get("/tips", getTips);
router.get("/leaderboard-line", getBoardLine);
router.get("/analytics-summary", getAnalyticsSummary);

export default router;
