import { Router } from "express";
import { signOff } from "../controllers/qualityController.js";
import { verifyToken, requireRole } from "../middleware/authMiddleware.js";
import { upload, needStorage } from "../middleware/upload.js";
import * as taskCtrl from "../controllers/taskController.js";
import { ownTask, ownProject, deletableTask } from "../controllers/teamLeadWorkController.js";
import { isEmployee } from "../services/accessRules.js";
import { askExtension } from "../controllers/workspaceController.js";

const router = Router();

router.use(verifyToken);

const mgmt = requireRole("Director", "Manager", "Team Lead");
// M-2: Managers see tasks read-only; creating, editing, moving, reviewing and deleting is the Team Lead's job (D-075).
const notManager = (req, res, next) => (req.user?.role === "Manager"
  ? res.status(403).json({ error: "Managers can view tasks but not change them. The Team Lead does that." })
  : next());

// T-2 (D-125): a Team Lead may touch only tasks / projects of their own projects here too (same guards as
// /api/teamlead, T-1 D-117). Before, these routes checked only the org. Other roles are unchanged.
const asTL = (guard) => (req, res, next) => (req.user?.role === "Team Lead" ? guard(req, res, next) : next());
// S-1 (D-158): an employee reaches a task only if they may read it, else 404. Covers read, comments, reactions and every write.
router.param("id", (req, res, next) => (isEmployee(req.user) ? taskCtrl.employeeTaskScope(req, res, next) : asTL(ownTask)(req, res, next)));

// ── Static routes (must come before /:id) ─────────────────────────────────────
router.get("/review-queue",           taskCtrl.getReviewQueue);
router.get("/for-review",             taskCtrl.getTasksForReview);
router.get("/review-stats",           taskCtrl.getReviewStats);
router.get("/mentoring-stats",        taskCtrl.getMentoringStats);
router.get("/current-sprint",         taskCtrl.getCurrentSprint);

// ── Collection ────────────────────────────────────────────────────────────────
router.post("/",           mgmt, notManager, asTL(ownProject), taskCtrl.createTask);
router.get("/",                  taskCtrl.getTasks);

// ── Single task ───────────────────────────────────────────────────────────────
router.get("/:id",                           taskCtrl.getTask);
router.patch("/:id",            mgmt, notManager,        taskCtrl.updateTask);
router.patch("/:id/status", notManager,                  taskCtrl.updateTaskStatus);

// ── Submission & review ───────────────────────────────────────────────────────
router.post("/:id/submit",  needStorage, upload.array("files", 5), taskCtrl.submitTask);
router.post("/:id/review", notManager,                            taskCtrl.reviewTask);

// ── Legacy approve / reject — Manager + Team Lead only (Director removed) ────
const taskReview = requireRole("Manager", "Team Lead");
router.post("/:id/approve", notManager, taskReview, taskCtrl.approveTask);
router.post("/:id/reject", notManager,  taskReview, taskCtrl.rejectTask);

// ── Extensions ────────────────────────────────────────────────────────────────
router.post("/:id/extension-request",  askExtension); // E-3 (D-179): one implementation with /api/workspace/tasks/:id/extension
router.post("/:id/extension-respond",  taskCtrl.respondExtension);

// ── Misc ──────────────────────────────────────────────────────────────────────
router.post("/:id/comment",            taskCtrl.addComment);
router.patch("/:id/comments/:commentId",          taskCtrl.editComment);
router.delete("/:id/comments/:commentId",         taskCtrl.deleteComment);
router.post("/:id/comments/:commentId/reactions", taskCtrl.reactComment);
// T-4 (D-137): Tester QA sign-off (UI comes with the Tester portal).
router.post("/:id/qa-signoff", requireRole("Tester", "Senior Tester", "Junior Tester"), signOff); // E-4 (D-189): same handler as /api/quality/qa/:id/signoff
router.post("/:id/time-log",           taskCtrl.logTime);
router.delete("/:id",       mgmt, notManager, asTL(deletableTask), taskCtrl.deleteTask);

export default router;
