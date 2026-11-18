import { Router } from "express";
import mongoose from "mongoose";
import Project from "../models/Project.js";
import { verifyToken, requireRole } from "../middleware/authMiddleware.js";
import { attachmentUpload } from "../middleware/upload.js";
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
  closeProjectWithOpenTasks,
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
import * as fl from "../controllers/flowsController.js";
import * as mr from "../controllers/managerResourcesController.js";
import { listBookings, createBooking, cancelBooking } from "../controllers/assetBookingController.js";
import * as mm from "../controllers/managerMotivationController.js";
import * as rp from "../controllers/managerReportsController.js";
import * as ai from "../controllers/managerAiController.js";
import { decideExtension, listManagerPendingExtensions } from "../controllers/extensionController.js";

const router = Router();

router.use(verifyToken, requireRole("Manager", "Team Lead"));
// QA4 D-QA4-8: every /projects/:id... route answers 404 for a Manager who does not manage that project (Team Leads keep their own rules).
router.use("/projects/:id", async (req, res, next) => {
  if (req.user.role !== "Manager" || !mongoose.isValidObjectId(req.params.id)) return next();
  try { return (await Project.exists({ _id: req.params.id, managerId: req.user.id })) ? next() : res.status(404).json({ error: "Project not found." }); } catch (e) { return next(e); }
});

router.get("/dashboard",                            getDashboard);
router.get("/team",                                 getTeam);
router.get("/tasks/overview",                       getTaskOverview);
router.get("/overdue-tasks",                        getOverdueTasks);
router.get("/team-workload",                        getTeamWorkload);
const mgr = requireRole("Manager");
router.get("/projects",                             getProjects);
// M-2 Projects (Manager only; static paths before /projects/:id)
router.get("/projects/list",                        mgr, mp.listProjects);
router.post("/projects", mgr, ...attachmentUpload("attachments", 5), createProject);
router.get("/projects/:id",                         getProjectById);
router.patch("/projects/:id",                       mgr, mp.editProject);
router.post("/projects/:id/archive",                mgr, mp.archiveProject);
router.post("/projects/:id/restore",                mgr, mp.restoreProject);
router.get("/projects/:id/overview",                mgr, mp.getOverview);
router.get("/projects/:id/history",                 mgr, mp.getHistory);
router.get("/projects/:id/team",                    mgr, mp.getTeam);
router.post("/projects/:id/members",                mgr, mp.addMember);
// QA4 Y-8: removing a member is blocked by open tasks and by leading a module; past work stays (see flowsController)
router.get("/projects/:id/members/:userId/remove-check", mgr, fl.removeCheck);
router.delete("/projects/:id/members/:userId",      mgr, fl.removeMember);
// QA4 Y-6 Change Team Lead, Y-7 Request reallocation / Nudge
router.get("/projects/:id/modules/:moduleId/change-lead/preview", mgr, fl.changeLeadPreview);
router.post("/projects/:id/modules/:moduleId/change-lead",        mgr, fl.changeLead);
router.post("/tasks/:id/request-reallocation", mgr, fl.requestReallocation);
router.post("/tasks/:id/nudge-team-lead",      mgr, fl.nudgeTeamLead);
router.get("/reallocation-requests",           mgr, fl.listSent);
router.get("/projects/:id/modules",                 mgr, mp.getModules);
router.patch("/projects/:id/modules/:moduleId/lead", mgr, mp.assignModuleLead);
router.get("/projects/:id/sprints",                 mgr, mp.getProjectSprints);
router.post("/projects/:id/extension",              mgr, mp.requestProjectExtension);
// QA4 D-QA4-12: the Manager decides extension requests up to the limit (3 working days by default) on their own projects
router.post("/extensions/:id/decide",               mgr, decideExtension);
router.get("/extensions/pending",                   mgr, listManagerPendingExtensions);
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

// Asset bookings — D-295 IMPL-5 Part 5
router.get("/assets/:assetId/bookings",             mgr, listBookings);
router.post("/assets/:assetId/bookings",            mgr, createBooking);
router.delete("/assets/:assetId/bookings/:bookingId", mgr, cancelBooking);
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
router.delete("/ai/chats/:id",                      mgr, ai.deleteChat);      // QA4 M-14
router.delete("/ai/chats",                          mgr, ai.deleteAllChats);
router.get("/ai/insights/unseen",                   mgr, ai.unseenInsights);  // QA4 M-13
router.post("/ai/insights/seen",                    mgr, ai.markInsightsSeen);
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
// SEC P-2: project and module WRITES are the Manager's only (a Team Lead used to pass the router-wide Manager/Team Lead gate)
router.patch("/projects/:id/status",               mgr, updateProjectStatus);
router.post("/projects/:id/close",                  mgr, closeProjectWithOpenTasks);
router.get("/projects/:id/tasks",                   getProjectTasks);
router.get("/projects/:id/milestones",               getMilestones);
router.post("/projects/:id/milestones",              mgr, createMilestone);
router.patch("/projects/:id/milestones/:milestoneId", mgr, updateMilestone);
router.delete("/projects/:id/milestones/:milestoneId", mgr, deleteMilestone);
router.post("/projects/:id/freeze",                  mgr, freezeProject);
router.delete("/projects/:id",                       mgr, deleteProject);
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
