// SEC: two log lines that make a "random logout" explainable. Never a token, password or e-mail; only a code, the route (no query) and a short id.
const short = (id) => String(id ?? "").slice(-6);
export const logAuthFail = (req, code, userId) => console.warn(`[auth-fail] code=${code} ${req.method} ${String(req.originalUrl ?? req.url ?? "").split("?")[0]}${userId ? ` user=${short(userId)}` : ""}`);
// causes: SUSPEND_APPROVED, EMERGENCY_SUSPEND_REJECTED, EMERGENCY_SUSPEND, PASSWORD_CHANGE, PASSWORD_RESET, SIGN_OUT_OTHERS, DIRECTOR_STATUS
export const logAuthBump = (cause, userId) => console.warn(`[auth-bump] cause=${cause} user=${short(userId)}`);
