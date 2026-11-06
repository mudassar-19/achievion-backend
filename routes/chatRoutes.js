import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import * as chatCtrl from "../controllers/chatController.js";

const router = Router();
router.use(verifyToken);

// Channels / groups
router.get("/channels",                              chatCtrl.getChannels);
router.post("/channels",                             chatCtrl.createChannel);
router.get("/channels/:id",                          chatCtrl.getGroupInfo);
router.get("/channels/:id/messages",                 chatCtrl.getMessages);
router.post("/channels/:id/messages",                chatCtrl.sendMessage);
router.post("/channels/:id/read",                    chatCtrl.markRead);
router.get("/channels/:id/unread-count",             chatCtrl.getUnreadCount);
router.patch("/channels/:id/settings",               chatCtrl.updateGroupSettings);
router.post("/channels/:id/clear",                   chatCtrl.clearConversation);
router.post("/channels/:id/leave",                   chatCtrl.leaveGroup);
router.post("/channels/:id/join",                    chatCtrl.joinGroup);
router.post("/channels/:id/join-requests/:uid",      chatCtrl.decideJoinRequest);
router.post("/channels/:id/mute",                    chatCtrl.muteGroup);

// Members
router.get("/channels/:id/members",                  chatCtrl.getMembers);
router.post("/channels/:id/members",                 chatCtrl.addMember);
router.delete("/channels/:id/members/:uid",          chatCtrl.removeMember);

// Admins
router.post("/channels/:id/admins",                  chatCtrl.addGroupAdmin);
router.delete("/channels/:id/admins/:uid",           chatCtrl.removeGroupAdmin);

// Posting rights in admins-only groups (Announcements)
router.post("/channels/:id/posters",                 chatCtrl.addPoster);
router.delete("/channels/:id/posters/:uid",          chatCtrl.removePoster);

// Pinned messages
router.get("/channels/:id/pinned",                   chatCtrl.getPinnedMessages);
router.post("/channels/:id/pin/:msgId",              chatCtrl.pinMessage);
router.delete("/channels/:id/pin/:msgId",            chatCtrl.unpinMessage);

// Messages
router.patch("/messages/:id",                        chatCtrl.editMessage);
router.delete("/messages/:id",                       chatCtrl.deleteMessage);
router.post("/messages/:id/reactions",               chatCtrl.reactToMessage);

// Direct messages
router.get("/dm/:userId",                            chatCtrl.getOrCreateDm);

// User search (for mentions / DM)
router.get("/users",                                 chatCtrl.searchUsers);

export default router;
