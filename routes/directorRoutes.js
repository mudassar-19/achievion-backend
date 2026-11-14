import * as org from "../controllers/directorOrgController.js";
import { listAnomalies, getAnomaly } from "../controllers/managerMotivationController.js";
import { Router } from "express";
import { verifyToken, requireRole } from "../middleware/authMiddleware.js";
import {
  getDashboard,
  getDirectorProfile,
  getAnalytics,
  getTeam,
  updateTeamMemberRole,
  adjustXp,
  getGarden,
  getProjects,
  getProjectDetail,
  updateProjectXpPool,
  getAuditLog,
  getXpDistribution,
  getWorkspaceSettings,
  updateWorkspaceSettings,
  getWorkspaceMembers,
  updateMemberStatus,
  resetGamification,
  getXpByRole,
  getTaskStats,
  getSprintVelocity,
  getRecentlyReviewed,
} from "../controllers/directorController.js";
import {
  getSettings,
  updateSettings,
  resetXpPools,
} from "../controllers/directorSettingsController.js";
import {
  listCustomRoles, addCustomRole, updateCustomRole, deactivateCustomRole, setUserRoleLabel,
} from "../controllers/customRolesController.js";
import { listBookings, cancelBooking } from "../controllers/assetBookingController.js";
import {
  listNotifications,
  countNotifications,
  markRead,
  markAllRead,
  muteNotification,
} from "../controllers/directorNotificationsController.js";
import { listExtensions, decideExtension } from "../controllers/extensionController.js";
import { listReports, getReport, addMessage, updateReport } from "../controllers/voiceController.js";
import { listGoals, createGoal, updateGoal, recalculateGoal } from "../controllers/goalController.js";
import { listRecaps, pendingRecaps, markSeen, generateRecap }   from "../controllers/recapController.js";
import { reportPortfolio, reportDelivery, reportCapacity, exportReport } from "../controllers/reportsController.js";
import { getOrgHealth, saveOrgHealthSnapshot, getOrgHealthHistory, getDeptDetail } from "../controllers/orgHealthController.js";
import { getSuccessCriteria } from "../controllers/successCriteriaController.js";
import { capacityHeatmap }    from "../controllers/capacityHeatmapController.js";
import { explainChart, suggestRebalance, sendRebalanceToManager, weeklySummary, aiStatus, askAchievion, reindexRag } from "../controllers/aiGatewayController.js";
import { needStorage } from "../middleware/upload.js";
import { getDues }   from "../controllers/duesController.js";
import { listViews, createView, updateView, deleteView } from "../controllers/portfolioViewController.js";

const router = Router();

router.use(verifyToken, requireRole("Director"));

router.get("/dashboard",                          getDashboard);
router.get("/profile",                            getDirectorProfile);
router.get("/approvals/reviewed",                 getRecentlyReviewed);
router.get("/analytics",                          getAnalytics);
router.get("/team",                               getTeam);
router.patch("/team/:userId/role",                updateTeamMemberRole);
router.post("/team/:userId/adjust-xp",            adjustXp);
router.get("/garden",                             getGarden);
router.get("/projects",                           getProjects);
router.get("/projects/:id",                       getProjectDetail);
router.patch("/projects/:projectId/xp-pool",      updateProjectXpPool);
router.get("/audit-log",                          getAuditLog);
router.get("/xp-distribution",                    getXpDistribution);
router.get("/workspace-settings",                 getWorkspaceSettings);
router.patch("/workspace-settings",               updateWorkspaceSettings);
router.post("/reset-gamification",                resetGamification);
router.get("/workspace-members",                  getWorkspaceMembers);
router.patch("/workspace-members/:userId/status", updateMemberStatus);

router.get("/reports/xp-by-role",                 getXpByRole);
router.get("/reports/task-stats",                  getTaskStats);
router.get("/reports/sprint-velocity",             getSprintVelocity);

// Settings — Slice 3a (replaces localStorage-only save)
router.get("/settings",                           getSettings);
router.patch("/settings",                         updateSettings);
router.post("/settings/reset-xp-pools",           resetXpPools);

// Custom roles — D-294 IMPL-5 Part 4
router.get("/settings/custom-roles",              listCustomRoles);
router.post("/settings/custom-roles",             addCustomRole);
router.patch("/settings/custom-roles/:key",       updateCustomRole);
router.delete("/settings/custom-roles/:key",      deactivateCustomRole);
router.patch("/settings/users/:userId/role-label", setUserRoleLabel);

// Asset bookings (read-only for Director) — D-295 IMPL-5 Part 5
router.get("/assets/:assetId/bookings",           listBookings);
router.delete("/assets/:assetId/bookings/:bookingId", cancelBooking);

// Notifications — Slice 3a (replaces stubs)
router.get("/notifications/count",                countNotifications);
router.get("/notifications",                      listNotifications);
router.patch("/notifications/:id/read",           markRead);
router.patch("/notifications/:id/mute",           muteNotification);
router.post("/notifications/mark-all-read",       markAllRead);

// Extensions — Slice 3b
router.get("/extensions",                         listExtensions);
router.patch("/extensions/:id",                   decideExtension);

// Voice — Slice 3b
router.get("/voice",                              listReports);
router.get("/voice/:id",                          getReport);
router.post("/voice/:id/message",                 addMessage);
router.patch("/voice/:id",                        updateReport);

// Goals — Slice 3d
router.get("/goals",                              listGoals);
router.post("/goals",                             createGoal);
router.patch("/goals/:id",                        updateGoal);
router.post("/goals/:id/recalculate",             recalculateGoal);

// Recaps — Slice 3e
router.get("/recaps/pending",                     pendingRecaps);
router.get("/recaps",                             listRecaps);
router.post("/recaps/:id/seen",                   markSeen);
router.post("/recaps/generate",                   generateRecap);

// Reports — Slice 3e
router.get("/reports/portfolio",                  reportPortfolio);
router.get("/reports/delivery",                   reportDelivery);
router.get("/reports/capacity",                   reportCapacity);
router.get("/reports/export",                     exportReport);

// Org Health — Slice 3f
router.get("/org-health",                         getOrgHealth);
router.post("/org-health/snapshot",               saveOrgHealthSnapshot);
router.get("/org-health/history",                 getOrgHealthHistory);
// Batch 5 (D4, N5, D7, D9)
router.get("/departments",                        org.listDepartments);
router.post("/departments",                       org.createDepartment);
router.patch("/departments",                      org.renameDepartmentRoute);
router.post("/departments/archive",               org.archiveDepartment);
router.patch("/team/:userId/department",          org.setMemberDepartment);
router.post("/branding/logo",                     needStorage, org.receiveLogo, org.uploadLogo);
router.delete("/branding/logo",                   org.removeLogo);
router.get("/anomalies",                          listAnomalies);   // read only: decisions stay on the Manager's routes
router.get("/anomalies/:flagId",                  getAnomaly);
router.get("/dept/:deptName",                     getDeptDetail);

// Success Criteria — Slice 3f
router.get("/success-criteria",                   getSuccessCriteria);

// Capacity Heatmap — Slice 3f
router.get("/capacity-heatmap",                   capacityHeatmap);

// Dues widget — Slice 3f Part C
router.get("/dues",                               getDues);

// Portfolio saved views — Slice 3f Part C
router.get("/portfolio/views",                    listViews);
router.post("/portfolio/views",                   createView);
router.patch("/portfolio/views/:id",              updateView);
router.delete("/portfolio/views/:id",             deleteView);

// AI Gateway — Slice 3f (Director-only, read-only)
router.get("/ai/status",                          aiStatus);
router.post("/ai/explain",                        explainChart);
router.post("/ai/rebalance",                      suggestRebalance);
router.post("/ai/rebalance/send",                 sendRebalanceToManager);
router.post("/ai/weekly-summary",                 weeklySummary);
router.post("/ai/ask",                            askAchievion);
router.post("/ai/reindex",                        reindexRag);

export default router;
