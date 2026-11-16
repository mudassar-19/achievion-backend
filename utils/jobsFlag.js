// DISABLE_JOBS=1 keeps every background job (crons, schedulers, the start-up seed) off. Used when a local server shares the
// live database: only the Render server runs the jobs. Default is on, so the deployed server needs no new setting.
export const jobsDisabled = (env = process.env) => ["1", "true"].includes(String(env.DISABLE_JOBS ?? "").trim().toLowerCase());
export const emailDisabled = (env = process.env) => ["1", "true"].includes(String(env.DISABLE_EMAIL ?? "").trim().toLowerCase());
