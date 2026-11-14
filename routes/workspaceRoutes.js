// Employee daily loop (E-2, D-174) and submit / extension / one more try (E-3, D-178..D-181). Developers, Designers and Testers only.
import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import { isEmployee } from "../services/accessRules.js";
import { employeeTaskScope } from "../controllers/taskController.js";
import { submitTask } from "../controllers/taskController.js";
import { uploadFiles } from "../middleware/upload.js";
import employeeAiRoutes from "./employeeAiRoutes.js";
import { getAnalytics } from "../controllers/employeeAiController.js";
import { listMyQuests, joinQuest } from "../controllers/employeeQuestController.js";
import { today, listTasks, fullTask, prepareSubmit, listSubmissions, askExtension, askMoreTries } from "../controllers/workspaceController.js";

const router = Router();
router.use(verifyToken);
router.use((req, res, next) => (isEmployee(req.user) ? next() : res.status(403).json({ error: "These pages are for Developers, Designers and Testers." })));
router.param("id", employeeTaskScope); // S-1 (D-158): outside the employee's reach → 404

router.use("/ai",            employeeAiRoutes); // Batch 4
router.get("/analytics",      getAnalytics);     // Batch 4 (N12): charts, no AI call
router.get("/quests",                    listMyQuests);  // Batch 3 (E13)
router.post("/quests/:questId/join",     joinQuest);     // Batch 3 (E13, UC-17 step 3)
router.get("/today",          today);
router.get("/tasks",          listTasks);
router.get("/tasks/:id/full", fullTask);
// E-3 (D-178..D-181). The scope check above runs before the upload, so files of an out-of-reach task are never stored.
router.get("/submissions",              listSubmissions);
router.post("/tasks/:id/submit",        uploadFiles, prepareSubmit, submitTask);
router.post("/tasks/:id/extension",     askExtension);
router.post("/tasks/:id/more-tries",    askMoreTries);

export default router;
