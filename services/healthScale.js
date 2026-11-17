// QA4 D-QA4-11: ONE health scale for the whole app (Org Health, Garden, project lists, dashboards, PDFs, AI text).
// 75 and up = Healthy (a project reads "On track"), 60-74 = Needs attention, below 60 = At risk. Three tiers: green, amber, red.
// This is the team's design choice (ASSUMPTION, checked on the simulation month), not a value from a source. Pure.
export const HEALTHY_FROM = 75, ATTENTION_FROM = 60;
export const healthTier = (score) => (score == null ? null : score >= HEALTHY_FROM ? "healthy" : score >= ATTENTION_FROM ? "attention" : "risk");
const NAME = { healthy: "Healthy", attention: "Needs attention", risk: "At risk" }, PROJECT = { healthy: "On track", attention: "Needs attention", risk: "At risk" };
export const healthBand = (score) => NAME[healthTier(score)] ?? "No data";
export const projectBand = (score) => PROJECT[healthTier(score)] ?? "No data";

// QA4 M-20: ONE risk label per project, derived from the same health band (the old stored "Low" could contradict a computed 53 At risk).
export const riskFromBand = (band) => ({ "On track": "Low", Healthy: "Low", "Needs attention": "Medium", "At risk": "High" })[band] ?? "Low";
