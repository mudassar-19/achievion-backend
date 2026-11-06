import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import * as ctrl from "../controllers/communityController.js";

const router = Router();
router.use(verifyToken);

// Org user search for member picker
router.get("/org-users",                        ctrl.searchOrgUsers);

// Communities
router.get("/",                                 ctrl.getCommunities);
router.post("/",                                ctrl.createCommunity);
router.get("/:id",                              ctrl.getCommunityInfo);
router.patch("/:id",                            ctrl.updateCommunity);
router.patch("/:id/archive",                    ctrl.archiveCommunity);

// Community members
router.get("/:id/members",                      ctrl.getCommunityMembers);
router.post("/:id/members",                     ctrl.addCommunityMembers);
router.delete("/:id/members/:userId",           ctrl.removeCommunityMember);

// Community admins are the Director and Managers (D-074); no promote/demote routes.

// Groups inside community
router.post("/:id/groups",                      ctrl.createGroup);
router.post("/:id/group-requests",              ctrl.requestGroup);
router.post("/:id/group-requests/:reqId",       ctrl.decideGroupRequest);

export default router;
