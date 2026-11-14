import "dotenv/config";
import { viewAsGuard } from "./middleware/viewAs.js"; // first: registers the read-only plugin before models compile
import express    from "express";
import cors       from "cors";
import mongoose   from "mongoose";
import { allowedOrigins, healthBody } from "./config/deploy.js";
import cron       from "node-cron";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import path       from "path";
import { createServer } from "http";
import jwt from "jsonwebtoken";
import { Server }      from "socket.io";
import { connectDB }                       from "./config/db.js";
import authRoutes                          from "./routes/authRoutes.js";
import orgRoutes                           from "./routes/orgRoutes.js";
import directorRoutes                      from "./routes/directorRoutes.js";
import managerRoutes                       from "./routes/managerRoutes.js";
import taskRoutes                          from "./routes/taskRoutes.js";
import notificationRoutes                  from "./routes/notificationRoutes.js";
import gamificationRoutes                  from "./routes/gamificationRoutes.js";
import approvalRoutes                          from "./routes/approvalRoutes.js";
import chatRoutes                              from "./routes/chatRoutes.js";
import communityRoutes                        from "./routes/communityRoutes.js";
import teamRoutes                              from "./routes/teamRoutes.js";
import teamLeadRoutes                         from "./routes/teamLeadRoutes.js";
import workspaceRoutes                        from "./routes/workspaceRoutes.js"; // E-2 (D-174)
import qualityRoutes                          from "./routes/qualityRoutes.js";   // E-4 (D-187)
import workloadRoutes                         from "./routes/workloadRoutes.js";
import extensionRoutes                        from "./routes/extensionRoutes.js";
import riskRoutes                             from "./routes/riskRoutes.js";
import voiceRoutes                            from "./routes/voiceRoutes.js";
import { verifyToken }                        from "./middleware/authMiddleware.js";
import fileRoutes  from "./routes/fileRoutes.js";
import shopRoutes  from "./routes/shopRoutes.js";
import { requireSignedFile } from "./controllers/fileController.js";
import { errorStatus } from "./services/accessRules.js";
import { createPerfLog }                      from "./controllers/perfLogController.js";
import { submitSurvey }                       from "./controllers/surveyController.js";
import emitter                             from "./utils/emitter.js";
import { registerGamificationListeners, updateDailyStreaks } from "./services/gamificationService.js";
import { registerDesignHandoff } from "./services/designHandoff.js"; // E-3b (D-185)
import GamificationProfile from "./models/GamificationProfile.js";
import Task                from "./models/Task.js";
import ChatMessage         from "./models/ChatMessage.js";
import ChatChannel         from "./models/ChatChannel.js";
import ChatCommunity       from "./models/ChatCommunity.js";
import * as chatRules        from "./services/chatRules.js";
import { chatAudit }         from "./services/chatService.js";
import User                from "./models/User.js";
import { setIo }                           from "./utils/io.js";
import { startDeadlineJobs } from "./jobs/deadlineJobs.js";
import { snapshotAllOrgs } from "./services/reportService.js";
import { startWeeklySummaryScheduler }     from "./jobs/weeklySummaryScheduler.js";
import { flagStaleSuspensions }            from "./controllers/emergencySuspendController.js";
import { seedCommunities }                 from "./migrations/seedCommunities.js";

// ── Startup guard ─────────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET) {
  console.error("[Fatal] JWT_SECRET is not set in environment variables.");
  process.exit(1);
}

// ── App setup ─────────────────────────────────────────────────────────────────
const app        = express();
// Behind a proxy (Render: TRUST_PROXY=1) the client IP comes from X-Forwarded-For, so the rate limits count per user, not per proxy.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY));
const httpServer = createServer(app);
const PORT       = process.env.PORT || 3001;
const ALLOWED_ORIGINS = allowedOrigins(); // CLIENT_URL, comma separated (deploy)

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin:      ALLOWED_ORIGINS,
    credentials: true,
  },
});
setIo(io);

// FE-039 / FE-R001: sockets are authenticated. The client sends its JWT (employee or
// Software House) in the handshake; anything else is refused. Rooms are derived from the
// token, never from client-supplied ids.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("unauthorized"));
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.viewAs) return next(new Error("unauthorized")); // View as is read-only: no live socket (D-109)
    if (decoded.type === "org") {
      socket.data = { kind: "org", orgId: String(decoded.orgDbId) };
      return next();
    }
    const u = await User.findById(decoded.id).select("tokenVersion status orgId name role").lean();
    if (!u || u.status === "suspended" || u.tokenVersion !== (decoded.tokenVersion ?? 0)) {
      return next(new Error("unauthorized"));
    }
    socket.data = { kind: "user", userId: String(u._id), orgId: String(u.orgId), name: u.name, role: u.role };
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

io.on("connection", (socket) => {
  const { kind, userId, orgId } = socket.data;

  // The ids the client sends are ignored: a socket can only join its own rooms.
  socket.on("join", () => { if (userId) socket.join(`user:${userId}`); });
  socket.on("joinOrg", () => { if (orgId) socket.join(`org:${orgId}`); });

  // ── Collaboration Bridge — channel rooms ─────────────────────────────────────
  async function canAccessChannel(channelId) {
    if (!channelId || !userId) return null;
    const ch = await ChatChannel.findById(channelId).lean().catch(() => null);
    if (!ch || String(ch.orgId) !== orgId) return null;
    return chatRules.canView(ch, { id: userId, role: socket.data.role }) ? ch : null; // D-074
  }

  socket.on("chat:join", async ({ channelId } = {}) => {
    if (await canAccessChannel(channelId)) socket.join(`chat:${channelId}`);
  });

  socket.on("chat:leave", ({ channelId } = {}) => {
    socket.leave(`chat:${channelId}`);
  });

  // Rate limit: 20 msgs / 10s per user
  const msgTimes = [];
  socket.on("chat:message", async ({ channelId, content, clientId, mentions = [] } = {}) => {
    try {
      if (!content?.trim() && !clientId) return;
      const ch = await canAccessChannel(channelId);
      if (!ch) { socket.emit("chat:error", { message: "Access denied." }); return; }

      // Permission check: same rule as REST (chatRules.canSend) + legacy postRoles
      if (!chatRules.canSend(ch, { id: userId, role: socket.data.role })) {
        socket.emit("chat:error", { message: "Only admins can post in this group." }); return;
      }
      if (ch.postRoles?.length && !ch.postRoles.includes(socket.data.role)) {
        socket.emit("chat:error", { message: "You cannot post in this channel." }); return;
      }

      if ((content?.length ?? 0) > 2000) {
        socket.emit("chat:error", { message: "Message too long (max 2000 chars)." }); return;
      }

      // Rate limit
      const now = Date.now();
      msgTimes.push(now);
      if (msgTimes.length > 20) msgTimes.shift();
      if (msgTimes.length === 20 && now - msgTimes[0] < 10_000) {
        socket.emit("chat:error", { message: "Slow down — rate limit reached." }); return;
      }

      // Dedup by clientId
      if (clientId) {
        const dup = await ChatMessage.findOne({ channelId, clientId }).lean();
        if (dup) { socket.emit("chat:message_saved", dup); return; }
      }

      const mentionOids = (mentions ?? []).filter(Boolean);
      const msg = await ChatMessage.create({
        orgId, channelId,
        sender:  userId,
        content: content?.trim() ?? "",
        clientId: clientId ?? null,
        mentions: mentionOids,
        readBy:  [userId],
      });

      const populated = await ChatMessage.findById(msg._id)
        .populate("sender",   "name role avatarStyle avatarSeed")
        .populate("mentions", "name role")
        .lean();

      io.to(`chat:${channelId}`).emit("chat:new_message", populated);
      socket.emit("chat:message_saved", populated);

      // Push mention notifications via socket
      for (const mId of mentionOids) {
        if (String(mId) === userId) continue;
        io.to(`user:${mId}`).emit("notification:new", {
          type:    "mention",
          message: `${socket.data.name ?? "Someone"} mentioned you in #${ch.name}`,
          deepLink: `/chat/${channelId}`,
        });
      }
    } catch (err) {
      socket.emit("chat:error", { message: err.message });
    }
  });

  socket.on("chat:edit", async ({ messageId, content } = {}) => {
    try {
      const msg = await ChatMessage.findById(messageId);
      if (!msg || String(msg.sender) !== userId) return;
      if (Date.now() - msg.createdAt.getTime() > 5 * 60 * 1000) {
        socket.emit("chat:error", { message: "Edit window closed (5 minutes)." }); return;
      }
      if (!content?.trim() || content.length > 2000) return;
      msg.content  = content.trim();
      msg.editedAt = new Date();
      await msg.save();
      const populated = await ChatMessage.findById(msg._id)
        .populate("sender",   "name role avatarStyle avatarSeed")
        .populate("mentions", "name role").lean();
      io.to(`chat:${String(msg.channelId)}`).emit("chat:message_updated", populated);
    } catch (err) { socket.emit("chat:error", { message: err.message }); }
  });

  socket.on("chat:delete", async ({ messageId } = {}) => {
    try {
      const msg = await ChatMessage.findById(messageId);
      if (!msg) return;
      const ch = await ChatChannel.findById(msg.channelId).lean();
      if (!ch || String(ch.orgId) !== orgId) return;
      if (!chatRules.canDeleteMessage(ch, msg, { id: userId, role: socket.data.role })) return;
      if (String(msg.sender) !== userId) {
        chatAudit({ user: { id: userId, orgId }, ip: socket.handshake.address }, "chat_message_removed", `Removed a message in "${ch.name}"`, { targetUserId: msg.sender });
      }
      msg.deletedAt = new Date();
      msg.content   = "";
      await msg.save();
      io.to(`chat:${String(msg.channelId)}`).emit("chat:message_deleted", { _id: msg._id, channelId: msg.channelId });
    } catch (err) { socket.emit("chat:error", { message: err.message }); }
  });

  socket.on("chat:typing", ({ channelId } = {}) => {
    if (socket.rooms.has(`chat:${channelId}`))
      socket.to(`chat:${channelId}`).emit("chat:typing", { userId, name: socket.data.name });
  });

  socket.on("chat:stop_typing", ({ channelId } = {}) => {
    if (socket.rooms.has(`chat:${channelId}`))
      socket.to(`chat:${channelId}`).emit("chat:stop_typing", { userId });
  });

  socket.on("disconnect", () => {
    console.log("[Socket] disconnected:", socket.id);
  });
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin:      ALLOWED_ORIGINS,
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve project attachment uploads
// S-1 (D-157): only through a signed link from GET /api/files/sign.
app.use("/uploads", requireSignedFile, express.static(path.resolve(process.cwd(), "uploads"), { cacheControl: false, dotfiles: "deny", index: false, redirect: false }));
// A valid signed link to a file that is not on this disk (older records, or a disk reset by a deploy): say so instead of "Route not found".
app.use("/uploads", (_req, res) => res.status(404).json({ error: "This file is no longer stored on the server. Upload it again.", code: "file_missing" }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Only failed requests count for login limiters (skipSuccessfulRequests: true).
// Key = email+IP so 30 users from the same Wi-Fi with correct passwords are never blocked.
// A second IP-only limiter (ceiling 200/15 min) catches one IP trying many accounts.
const authEmailIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${(req.body?.email ?? "").toLowerCase().trim()}:${ipKeyGenerator(req)}`,
  message: { error: "Too many failed login attempts. Try again in 15 minutes." },
});
const authIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts from this IP. Try again in 15 minutes." },
});
// Forgot/reset-password: keyed by email+IP, counts all requests (endpoint always 200 for security)
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `fp:${(req.body?.email ?? "").toLowerCase().trim()}:${ipKeyGenerator(req)}`,
  message: { error: "Too many password reset requests. Try again in 15 minutes." },
});
app.use("/api/auth/login",           authEmailIpLimiter, authIpLimiter);
app.use("/api/org/login",            authEmailIpLimiter, authIpLimiter);
app.use("/api/auth/forgot-password", forgotPasswordLimiter);
app.use("/api/auth/reset-password",  forgotPasswordLimiter);

// View as (D-109): before every route — view-as tokens only GET, and those GETs cannot write.
app.use("/api", viewAsGuard);

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json(healthBody(mongoose.connection.readyState)));

app.use("/api/auth",          authRoutes);
app.use("/api/org",           orgRoutes);
app.use("/api/director",      directorRoutes);
app.use("/api/manager",       managerRoutes);
app.use("/api/tasks",         taskRoutes);
app.use("/api/files",         fileRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/gamification",  gamificationRoutes);
app.use("/api/approvals",     approvalRoutes);
app.use("/api/chat",          chatRoutes);
app.use("/api/communities",   communityRoutes);
app.use("/api/teams",         teamRoutes);
app.use("/api/teamlead",      teamLeadRoutes);
app.use("/api/workspace",     workspaceRoutes);
app.use("/api/quality",       qualityRoutes);
app.use("/api/shop",          shopRoutes);
app.use("/api/workload",      workloadRoutes);
app.use("/api/extensions",   extensionRoutes);
app.use("/api/risks",        riskRoutes);
app.use("/api/voice",        voiceRoutes);
app.post("/api/perf/log",    verifyToken, createPerfLog);
app.post("/api/survey",      verifyToken, submitSurvey);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found." });
});

// ── Global error handler ──────────────────────────────────────────────────────
// Express 5 forwards async throws here automatically.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status  = errorStatus(err); // S11 (D-167): malformed id → 404
  const isDev   = process.env.NODE_ENV !== "production";
  const message = err.name === "CastError" ? (status === 404 ? "Not found." : "A value has the wrong format.") : (err.expose || isDev) ? err.message : "Internal server error.";
  if (status >= 500) {
    console.error("[Error]", err.message ?? err);
  }
  res.status(status).json({ error: message });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function start() {
  await connectDB();
  registerGamificationListeners(emitter);
  registerDesignHandoff(emitter); // E-3b: approved design → linked developer tasks (no XP)

  // Daily cron at midnight: update streaks + HP regen + monthly XP reset
  cron.schedule("0 0 * * *", async () => {
    try {
      await updateDailyStreaks();

      if (new Date().getDate() === 1) {
        await GamificationProfile.updateMany({}, { $set: { monthlyXp: 0 } });
        console.log("[Gamification] Monthly XP reset complete.");
      }
    } catch (err) {
      console.error("[Gamification] Cron error:", err.message);
    }
  });

  // M-6: daily team well-being counts for the Reports trend (after the HP update above).
  cron.schedule("20 0 * * *", () => snapshotAllOrgs().catch((e) => console.error("[wellbeing-snapshot]", e.message)));

  // D-055: no auto-start cron. The assignee moves To-Do → In-Progress (taskController.updateTaskStatus).

  startWeeklySummaryScheduler();
  startDeadlineJobs();
  seedCommunities(); // idempotent — wraps legacy channels into communities

  // Flag stale emergency suspensions every hour
  cron.schedule("0 * * * *", () => flagStaleSuspensions().catch((e) => console.error("[suspend-cron]", e.message)));

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] Listening on 0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error("[Fatal] Failed to start server:", err.message);
  process.exit(1);
});
