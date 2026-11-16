// Item 42: the daily AI spend cap (USD). The environment variable AI_DAILY_COST_CAP_USD wins, so the limit is set where the
// server runs and not on a Settings screen; otherwise the org's stored value, otherwise the caller's default. Pure.
export function dailyCapUsd(org, fallback, env = process.env) {
  const raw = env.AI_DAILY_COST_CAP_USD;
  const fromEnv = raw === undefined || raw === "" ? NaN : Number(raw);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return org?.aiSettings?.costCapUsdPerDay ?? fallback;
}
