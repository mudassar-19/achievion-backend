import * as tq from "../controllers/teamLeadRequestsController.js";
import { Router } from "express";
import { aiConfigured } from "../services/aiChain.js";
import * as tai from "../controllers/teamLeadAiController.js";
import { listChats, getChat, feedback as aiFeedback } from "../controllers/managerAiController.js";
import * as tp from "../controllers/teamLeadPerformanceController.js";
import * as tr from "../controllers/teamLeadReviewController.js";
import { verifyToken, requireRole } from "../middleware/authMiddleware.js";
import {
  getDashboard,
  getProjects,
  getProjectDetail,
  getMembersWorkload,
  getTasks,
  getReviewSubmissions,
  getReviewSubmission,
  getMilestones,
  createMilestone,
  updateMilestone,
  deleteMilestone,
  getMilestoneDetail,
  // Phase 3
  getTeamWorkload,
  getEmployeeCapacity,
  tlReviewTask,
  createResourceRequest,
  getResourceRequests,
  getAlerts,
  getSprintView,
  // Phase 4
  createSprint,
  getSprints,
  updateSprint,
  deleteSprint,
  addSprintTask,
  removeSprintTask,
  getAnalytics,
  getRisks,
  getActivity,
  getTLFullProfile,
} from "../controllers/teamLeadController.js";
import {
  getTLGamProfile,
  getTLLeaderboard,
  getTLBadges,
  getTLTitles,
  equipTLTitle,
  getTLXpEvents,
  getTLTimeline,
} from "../controllers/tlGamificationController.js";
import { getProjectTasks } from "../controllers/managerController.js";
import * as taskCtrl from "../controllers/taskController.js";
import { suggestTask } from "../controllers/aiAssistController.js";

import * as tw from "../controllers/teamLeadWorkController.js";
import * as tt from "../controllers/teamLeadTaskController.js";
import * as tb from "../controllers/teamLeadBreakdownController.js";
import { attachmentUpload } from "../middleware/upload.js";

const router = Router();

router.use(verifyToken, requireRole("Team Lead"));

// ── T-1 (V2 Phase 4, D-113..D-116): home, modules, task list/detail, team + reassign, sprints read-only ──
router.get("/home",                          tw.getHome);
router.get("/modules",                       tw.listModules);
router.get("/modules/:projectId",            tw.getModule);
router.post("/modules/:moduleId/accept",     tw.acceptModule);
router.post("/modules/:projectId/question",  tw.askQuestion);
router.get("/tasks/list",                    tw.listTasks);   // before /tasks/:id
router.get("/tasks/:id/detail",              tw.taskDetail);
router.get("/tasks/:id/candidates",          tw.taskCandidates);
router.post("/tasks/:id/reassign",           tw.taskReassign);
router.get("/team",                          tw.getTeam);
router.get("/team/members/:userId",          tw.getTeamMember);

// ── T-2 (D-118, D-119, D-122..D-125): create / edit / group assign, detail tabs, files, bulk, saved filters, module requests ──
router.post("/tasks/create",                 tt.createTasks);             // project checked inside (own projects only)
router.post("/tasks/bulk",                   tt.bulkTasks);               // every id checked inside
router.get("/tasks/:id/full",                tw.ownTask, tt.fullTask);
router.patch("/tasks/:id/edit",              tw.ownTask, tt.editTask);
router.post("/tasks/:id/duplicate",          tw.ownTask, tt.duplicateTask);
router.post("/tasks/:id/extend",             tw.ownTask, tt.extendTask);
// E-3 (D-180): requests from the TL's own people: more time, one more try. Decisions reuse respondExtension / decideLimitRequest.
router.get("/requests",                      tq.listRequests);
router.post("/requests/extension/:id",       tw.ownTask, tq.decideExtension);
router.post("/requests/limit/:id",           tq.decideTries);
router.post("/tasks/:id/attachments",        tw.ownTask, ...attachmentUpload("files", 5), tt.addAttachments);
router.delete("/tasks/:id/attachments/:attId", tw.ownTask, tt.removeAttachment);
router.get("/filters",                       tt.listFilters);
router.post("/filters",                      tt.saveFilter);
router.delete("/filters/:filterId",          tt.deleteFilter);
router.post("/modules/:projectId/deadline-request", tt.requestModuleDeadline);
router.post("/modules/:moduleId/qa-ready",   tt.markQaReady);
router.get("/modules/:projectId/history",    tt.moduleHistory);

// ── T-3 (D-126..D-129): breakdown workspace — context, realism, AI suggest + benchmark, Apply (all or nothing) ──
router.get("/modules/:projectId/breakdown",        tb.getBreakdown);
router.post("/modules/:projectId/realism",         tb.postRealism);
router.post("/modules/:projectId/breakdown/apply", tb.applyBreakdown);
router.post("/ai/breakdown",                       tb.suggestBreakdown);
router.post("/ai/benchmark",                       tb.suggestBenchmark);

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get("/dashboard", getDashboard);

// ── Projects (TL-scoped) ──────────────────────────────────────────────────────
router.get("/projects",                              getProjects);
router.get("/projects/:id",                          tw.ownProject, getProjectDetail);
router.get("/projects/:id/members-workload",         tw.ownProject, getMembersWorkload);
router.get("/projects/:id/tasks",                    tw.ownProject, getProjectTasks);

// ── Milestones (TL-scoped, uses TL controller for member guard) ───────────────
router.get("/projects/:id/milestones",                        getMilestones);
router.post("/projects/:id/milestones",                       createMilestone);
router.get("/projects/:id/milestones/:milestoneId",           getMilestoneDetail);
router.patch("/projects/:id/milestones/:milestoneId",         updateMilestone);
router.delete("/projects/:id/milestones/:milestoneId",        deleteMilestone);

// ── Review Submissions ───────────────────────────────────────────────────────
router.get("/review-submissions",           getReviewSubmissions);
router.get("/review-submissions/:taskId",   getReviewSubmission);

// ── Tasks ─────────────────────────────────────────────────────────────────────
router.get("/tasks",                getTasks);
router.post("/tasks",               tw.ownProject, taskCtrl.createTask); // body.projectId must be one of the TL's
router.get("/tasks/review-queue",   taskCtrl.getReviewQueue);
router.get("/tasks/:id",            tw.ownTask, taskCtrl.getTask);
router.patch("/tasks/:id/status",   tw.ownTask, taskCtrl.updateTaskStatus);
router.post("/tasks/:id/review",    tw.ownTask, taskCtrl.reviewTask);
router.post("/tasks/:id/tl-review", tw.ownTask, tlReviewTask);
router.post("/ai/task-suggest",     suggestTask); // V2 2.2: suggestion only
router.post("/tasks/:id/comment",   tw.ownTask, taskCtrl.addComment);
router.patch("/tasks/:id/comments/:commentId",            tw.ownTask, taskCtrl.editComment);
router.delete("/tasks/:id/comments/:commentId",           tw.ownTask, taskCtrl.deleteComment);
router.post("/tasks/:id/comments/:commentId/reactions",   tw.ownTask, taskCtrl.reactComment);

// ── T-4 review (D-136, D-137) + handoff (D-138) ──────────────────────────────
router.get("/review/queue",            tr.getQueue);
router.get("/review/history",          tr.getHistory);
router.get("/review/:id",              tw.ownTask, tr.getReview);
router.post("/review/:id/approve",     tw.ownTask, tr.approveReview);
router.post("/review/:id/conditional", tw.ownTask, tr.conditionalApprove);
router.post("/review/:id/revision",    tw.ownTask, tr.requestRevision);
router.get("/modules/:projectId/handoff", tr.getHandoff);
router.delete("/tasks/:id",         tw.ownTask, tw.deletableTask, taskCtrl.deleteTask); // T-2: Backlog / To-Do only

// ── Phase 3: Workload Engine ──────────────────────────────────────────────────
router.get("/team-workload",              getTeamWorkload);
router.get("/employee/:id/capacity",      tw.ownTeamMember, getEmployeeCapacity);

// ── Phase 3: Resource Requests ────────────────────────────────────────────────
router.post("/resource-requests",         createResourceRequest);
router.get("/resource-requests",          getResourceRequests);

// ── Phase 3: Smart Alerts ─────────────────────────────────────────────────────
router.get("/alerts",                     getAlerts);

// ── Phase 3: Sprint View (milestone-based) ────────────────────────────────────
router.get("/sprint",                     getSprintView);

// ── Phase 4: Sprint CRUD ──────────────────────────────────────────────────────
router.post("/sprints",                   tw.tlCreateSprint); // T-5 (D-143, D-121)
router.get("/sprints",                    tw.listSprints);   // T-1: Manager sprints in the TL's projects (was the TL's own)
router.get("/sprints/:id",                tw.sprintDetail);
router.get("/sprints/:id/summary",        tw.sprintSummary);
router.patch("/sprints/:id",              tw.tlUpdateSprint);
router.delete("/sprints/:id",             tw.tlDeleteSprint);
router.post("/sprints/:id/tasks",         tw.tlAddSprintTask);
router.get("/sprints/:id/backlog",         tw.tlSprintBacklog);
router.post("/sprints/:id/start",         tw.tlStartSprint);
router.post("/sprints/:id/close",         tw.tlCloseSprint);
router.get("/projects/:id/sprints",       tw.tlProjectSprints);
router.delete("/sprints/:id/tasks/:taskId", tw.tlRemoveSprintTask);

// ── Phase 4: Analytics + Risk + Activity ─────────────────────────────────────
router.get("/analytics",                  getAnalytics);
router.get("/risks",                      getRisks);
router.get("/activity",                   getActivity);

// ── T-6: AI panel and hints (D-149..D-152). Suggest only. ─────────────────────
router.get("/ai/status",                (_req, res) => res.json({ configured: aiConfigured() }));
router.get("/ai/context",               tai.getContext);
router.get("/ai/chats",                 listChats);
router.get("/ai/chats/:id",             getChat);
router.post("/ai/chat",                 tai.chat);
router.post("/ai/feedback",             aiFeedback);
router.get("/ai/insight",               tai.getInsight);
router.post("/ai/insight/dismiss",      tai.dismissInsight);
router.post("/ai/assign-hint",          tai.assignHint);
router.post("/ai/sprints/:id/scope",    tai.sprintScope);
router.post("/ai/realism-explain",      tai.realismExplain);

// ── T-5: Performance (D-144), My stats (D-145), Announcements (D-146) ────────
router.get("/performance/options",  tp.getOptions);
router.get("/performance/activity", tp.tab("activity"));
router.get("/performance/sprints",  tp.tab("sprints"));
router.get("/performance/export",   tp.exportPerformance);
router.get("/performance/delivery", tp.tab("delivery"));
router.get("/performance/people",   tp.tab("people"));
router.get("/performance/xp",       tp.tab("xp"));
router.get("/my-stats",             tp.getMyStats);
router.get("/announcements",        tp.getAnnouncements);
router.post("/announcements/read",  tp.markAnnouncementsRead);

// ── Phase 6: Full Profile ────────────────────────────────────────────────────
router.get("/profile/full",           getTLFullProfile);

// ── Phase 5: TL Gamification ──────────────────────────────────────────────────
router.get("/gamification/profile",       getTLGamProfile);
router.get("/gamification/leaderboard",   getTLLeaderboard);
router.get("/gamification/badges",        getTLBadges);
router.get("/gamification/titles",        getTLTitles);
router.patch("/gamification/titles/equip", equipTLTitle);
router.get("/gamification/xp-events",    getTLXpEvents);
router.get("/gamification/timeline",      getTLTimeline);

export default router;
