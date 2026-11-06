// Employee daily loop (E-2, D-174) and submit / extension / one more try (E-3, D-178..D-181). Developers, Designers and Testers only.
import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import { isEmployee } from "../services/accessRules.js";
import { employeeTaskScope } from "../controllers/taskController.js";
import { submitTask } from "../controllers/taskController.js";
import { uploadFiles } from "../middleware/upload.js";
import { today, listTasks, fullTask, prepareSubmit, listSubmissions, askExtension, askMoreTries } from "../controllers/workspaceController.js";

const router = Router();
router.use(verifyToken);
router.use((req, res, next) => (isEmployee(req.user) ? next() : res.status(403).json({ error: "These pages are for Developers, Designers and Testers." })));
router.param("id", employeeTaskScope); // S-1 (D-158): outside the employee's reach → 404

router.get("/today",          today);
router.get("/tasks",          listTasks);
router.get("/tasks/:id/full", fullTask);
// E-3 (D-178..D-181). The scope check above runs before the upload, so files of an out-of-reach task are never stored.
router.get("/submissions",              listSubmissions);
router.post("/tasks/:id/submit",        uploadFiles, prepareSubmit, submitTask);
router.post("/tasks/:id/extension",     askExtension);
router.post("/tasks/:id/more-tries",    askMoreTries);

export default router;
