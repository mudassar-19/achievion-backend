// Runs an Express handler in-process with the caller's identity and returns { status, body }.
// Used to reuse a handler's numbers and scope checks (Manager AI, Team Lead portal) without copying queries.
export async function capture(handler, req, { params = {}, query = {}, body } = {}) {
  let status = 200, out;
  const res = { status(c) { status = c; return res; }, json(b) { out = b; return res; } };
  await handler({ user: req.user, viewAs: req.viewAs, headers: req.headers, ip: req.ip, params, query, body }, res);
  return { status, body: out };
}
export const passOn = (res, r) => res.status(r.status).json(r.body);
