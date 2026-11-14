// Last seen (Batch 5: X17, FR01-11) — pure. Written at most once a minute per person (authMiddleware), read only by
// Directors, Managers and Team Leads on their rosters, never by employees about others, never in View as.
export const TOUCH_MS = 60_000;
export const shouldTouch = (last, now = new Date()) => !last || +now - +new Date(last) > TOUCH_MS;

const MAY_SEE = ["Director", "Manager", "Team Lead"];
// The value a roster may send for one person: the date for a lead, null for everyone else and in View as.
export const lastSeenFor = (viewer, date) => (date && MAY_SEE.includes(viewer?.role) && !viewer?.viewAs ? date : null);
