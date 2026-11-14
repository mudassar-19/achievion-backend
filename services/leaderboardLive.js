// Live leaderboard signal (Batch 3: E4, TC-LB-02 "Socket.IO event broadcast to org room"). Called by the XpLog
// post-save hook, so every XP path (task approval, quest reward, reversal, Director adjust) is covered without touching
// the reward code. One "leaderboard:changed" per organisation per second: the ledger row is written just before the
// profile total, and a burst of awards (a group task) becomes one refresh.
import User from "../models/User.js";
import { getIo } from "../utils/io.js";

const WAIT_MS = 1000;
const pending = new Set();
// ponytail: in-memory, per server process. With several API servers, use the Socket.IO Redis adapter.
export async function leaderboardChanged(userId) {
  const io = getIo();
  if (!io || !userId) return;
  const u = await User.findById(userId, "orgId").lean();
  if (!u?.orgId) return;
  const room = `org:${u.orgId}`;
  if (pending.has(room)) return;
  pending.add(room);
  setTimeout(() => { pending.delete(room); getIo()?.to(room).emit("leaderboard:changed", { at: Date.now() }); }, WAIT_MS).unref();
}
