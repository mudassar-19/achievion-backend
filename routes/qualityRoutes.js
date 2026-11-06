// E-4 Tester Quality (D-187..D-192). Every route needs a login; each handler checks the role (Tester-only work answers 403
// to other roles) and the project scope (404 outside it, also for another organisation and a malformed id).
import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import { uploadFiles } from "../middleware/upload.js";
import * as q from "../controllers/qualityController.js";

const router = Router();
router.use(verifyToken);
const testers = (req, res, next) => (req.user?.roleCategory === "tester" ? next() : res.status(403).json({ error: "This is the Tester's Quality work." }));

router.get("/today",                 testers, q.testerToday);
router.get("/qa",                    testers, q.qaQueue);
router.get("/qa/:id",                testers, q.qaPage);
router.post("/qa/:id/signoff",       testers, uploadFiles, q.signOff);   // scope is checked after the upload; files of a refused sign-off stay unreferenced
router.get("/bugs",                  q.listBugs);
router.post("/bugs",                 testers, uploadFiles, q.reportBug);
router.get("/bugs/:id",              q.getBug);
router.post("/bugs/:id/move",        q.moveBug);
router.post("/bugs/:id/check",       q.checkBug);
router.get("/projects/:id/tasks",    q.projectTasks);
router.get("/test-cases",            q.listCases);
router.post("/test-cases",           testers, q.createCase);
router.patch("/test-cases/:id",      q.updateCase);
router.post("/test-cases/:id/runs",  q.runCase);

export default router;
