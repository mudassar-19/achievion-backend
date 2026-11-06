import { Router } from "express";
import { verifyToken, requireRole } from "../middleware/authMiddleware.js";
import { projectAttachmentUpload } from "../middleware/upload.js";
import {
  getDashboard,
  getTeam,
  getTaskOverview,
  getOverdueTasks,
  getTeamWorkload,
  getProjects,
  getProjectTasks,
  createProject,
  getTeamFull,
  getTimeline,
  getTeamAvailability,
  getWorkforce,
  getProjectTimeline,
  getReports,
  getActivityFeed,
} from "../controllers/managerController.js";
import {
  getProjectById,
  updateProjectStatus,
  getMilestones,
  createMilestone,
  updateMilestone,
  deleteMilestone,
  freezeProject,
  deleteProject,
} from "../controllers/projectController.js";
import {
  getOpsHub,
  getRequests,
  createRequest,
  updateRequest,
  decideLimitRequest,
} from "../controllers/opsHubController.js";
import {
  getSprints,
  createSprint,
  getSprintDetail,
  updateSprint,
  addTaskToSprint,
  removeTaskFromSprint,
  getSprintBacklog,
  startSprint,
  closeSprint,
  getSprintSummary,
} from "../controllers/sprintController.js";
import { listManagerReports }  from "../controllers/voiceController.js";
import { listManagerGoals }    from "../controllers/goalController.js";
import { getHome, nudgeReviewer } from "../controllers/managerHomeController.js";
import * as mp from "../controllers/managerProjectsController.js";
import * as mr from "../controllers/managerResourcesController.js";
import * as mm from "../controllers/managerMotivationController.js";
import * as rp from "../controllers/managerReportsController.js";
import * as ai from "../controllers/managerAiController.js";

const router = Router();

router.use(verifyToken, requireRole("Manager", "Team Lead"));

router.get("/dashboard",                            getDashboard);
router.get("/team",                                 getTeam);
router.get("/tasks/overview",                       getTaskOverview);
router.get("/overdue-tasks",                        getOverdueTasks);
router.get("/team-workload",                        getTeamWorkload);
const mgr = requireRole("Manager");
router.get("/projects",                             getProjects);
// M-2 Projects (Manager only; static paths before /projects/:id)
router.get("/projects/list",                        mgr, mp.listProjects);
router.post("/projects", mgr, projectAttachmentUpload.array("attachments", 10), createProject);
router.get("/projects/:id",                         getProjectById);
router.patch("/projects/:id",                       mgr, mp.editProject);
router.post("/projects/:id/archive",                mgr, mp.archiveProject);
router.post("/projects/:id/restore",                mgr, mp.restoreProject);
router.get("/projects/:id/overview",                mgr, mp.getOverview);
router.get("/projects/:id/history",                 mgr, mp.getHistory);
router.get("/projects/:id/team",                    mgr, mp.getTeam);
router.post("/projects/:id/members",                mgr, mp.addMember);
router.delete("/projects/:id/members/:userId",      mgr, mp.removeMember);
router.get("/projects/:id/modules",                 mgr, mp.getModules);
router.patch("/projects/:id/modules/:moduleId/lead", mgr, mp.assignModuleLead);
router.get("/projects/:id/sprints",                 mgr, mp.getProjectSprints);
router.post("/projects/:id/extension",              mgr, mp.requestProjectExtension);
router.get("/tasks/:id/detail",                     mgr, mp.getTaskDetail);
// M-4 Resources (Manager only)
router.get("/resources/workload",                   mgr, mr.getWorkload);
router.get("/resources/members/:userId",            mgr, mr.getMember);
router.get("/resources/threshold",                  mgr, mr.getThreshold);
router.put("/resources/threshold",                  mgr, mr.setThreshold);
router.get("/tasks/:id/candidates",                 mgr, mr.getCandidates);
router.post("/tasks/:id/reassign",                  mgr, mr.reassignTask);
router.get("/assets",                               mgr, mr.listAssets);
router.post("/assets",                              mgr, mr.createAsset);
router.patch("/assets/:id",                         mgr, mr.updateAsset);
router.delete("/assets/:id",                        mgr, mr.deleteAsset);
router.get("/projects/:id/assets",                  mgr, mr.getProjectAssets);
router.post("/projects/:id/assets",                 mgr, (req, res) => mr.linkProjectAsset(req, res));
router.delete("/projects/:id/assets/:assetId",      mgr, mr.unlinkProjectAsset);
// M-5 Challenges + Anomalies (Manager only)
router.get("/quests/options",                       mgr, mm.questOptions);
router.get("/quests",                               mgr, mm.listQuests);
router.post("/quests",                              mgr, mm.createQuest);
router.get("/quests/:id",                           mgr, mm.getQuest);
router.patch("/quests/:id",                         mgr, mm.updateQuest);
router.delete("/quests/:id",                        mgr, mm.deleteQuest);
router.post("/quests/:id/publish",                  mgr, mm.publishQuest);
router.post("/quests/:id/end",                      mgr, mm.endQuest);
router.post("/quests/:id/duplicate",                mgr, mm.duplicateQuest);
router.get("/anomalies",                            mgr, mm.listAnomalies);
router.get("/anomalies/count",                      mgr, mm.anomalyCount);
router.get("/anomalies/:flagId",                    mgr, mm.getAnomaly);
router.post("/anomalies/:flagId/dismiss",           mgr, mm.dismissAnomaly);
router.post("/anomalies/:flagId/reopen",            mgr, mm.reopenAnomaly);
router.post("/anomalies/:flagId/confirm",           mgr, mm.confirmAnomaly);

// Reports (V2 Phase 3 · M-6): Manager only, org-scoped filters (managerReportsController.context)
router.get("/reports/options",                      mgr, rp.getOptions);
router.get("/reports/delivery",                     mgr, rp.getDelivery);
router.get("/reports/people",                       mgr, rp.getPeople);
router.get("/reports/xp",                           mgr, rp.getXpTrend);
router.get("/reports/wellbeing",                    mgr, rp.getWellbeing);
router.get("/reports/lessons",                      mgr, rp.getLessons);
router.post("/reports/lessons",                     mgr, rp.createLesson);
router.patch("/reports/lessons/:id",                mgr, rp.updateLesson);
router.delete("/reports/lessons/:id",               mgr, rp.deleteLesson);
router.get("/reports/export",                       mgr, rp.exportReport);
// M-7 Manager AI (suggest only; D-105..D-108)
router.get("/ai/context",                           mgr, ai.getContext);
router.get("/ai/chats",                             mgr, ai.listChats);
router.get("/ai/chats/:id",                         mgr, ai.getChat);
router.post("/ai/chat",                             mgr, ai.chat);
router.post("/ai/feedback",                         mgr, ai.feedback);
router.get("/ai/insight",                           mgr, ai.getInsight);
router.post("/ai/insight/dismiss",                  mgr, ai.dismissInsight);
router.post("/ai/sprints/:id/narrative",            mgr, ai.sprintNarrative);
router.post("/ai/sprints/:id/scope",                mgr, ai.sprintScope);
router.post("/ai/reports/narrative",                mgr, ai.reportNarrative);
router.post("/ai/reports/lessons",                  mgr, ai.lessonsDraft);
router.post("/ai/challenge-draft",                  mgr, ai.challengeDraft);
router.post("/ai/tasks/:id/rebalance",              mgr, ai.rebalanceHint);
router.post("/ai/anomalies/:flagId/explain",        mgr, ai.explainAnomaly);
router.patch("/projects/:id/status",               updateProjectStatus);
router.get("/projects/:id/tasks",                   getProjectTasks);
router.get("/projects/:id/milestones",               getMilestones);
router.post("/projects/:id/milestones",              createMilestone);
router.patch("/projects/:id/milestones/:milestoneId", updateMilestone);
router.delete("/projects/:id/milestones/:milestoneId", deleteMilestone);
router.post("/projects/:id/freeze",                  freezeProject);
router.delete("/projects/:id",                       deleteProject);
router.get("/team-full",                            getTeamFull);
router.get("/timeline",                             getTimeline);
router.get("/team-availability",                    getTeamAvailability);
router.get("/workforce",                            getWorkforce);
router.get("/project-timeline",                     getProjectTimeline);
router.get("/reports",                              getReports);
router.get("/activity-feed",                        getActivityFeed);
router.get("/home",                requireRole("Manager"), getHome);        // M-1 Dashboard
router.post("/tasks/:id/nudge",    requireRole("Manager"), nudgeReviewer);  // M-1 Inbox · In Review
router.get("/ops-hub",                              getOpsHub);
router.get("/requests",                             getRequests);
router.post("/requests",                            createRequest);
router.patch("/requests/:id",                       updateRequest);
router.post("/requests/:id/limit-decision", mgr, decideLimitRequest); // T-5 (D-142)

// Voice inbox (D-022: reports about self excluded)
router.get("/voice",                                listManagerReports);

// Goals read-only (visibleTo=managers|all only)
router.get("/goals",                                listManagerGoals);

// Sprint routes (M-3: Manager only; Team Leads use /api/teamlead/sprints)
router.get("/sprints",                              mgr, getSprints);
router.post("/sprints",                             mgr, createSprint);
router.get("/sprints/:id",                          mgr, getSprintDetail);
router.patch("/sprints/:id",                        mgr, updateSprint);
router.get("/sprints/:id/backlog",                  mgr, getSprintBacklog);
router.post("/sprints/:id/tasks",                   mgr, addTaskToSprint);
router.delete("/sprints/:id/tasks/:taskId",         mgr, removeTaskFromSprint);
router.post("/sprints/:id/start",                   mgr, startSprint);
router.post("/sprints/:id/close",                   mgr, closeSprint);
router.get("/sprints/:id/summary",                  mgr, getSprintSummary);

export default router;
