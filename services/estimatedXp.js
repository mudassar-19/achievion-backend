// Item 52 (D-527): "Estimated XP" for the New Task form, from the engine that pays the XP (calculateTaskXP): a 3-star task of this
// type and priority handed in on time, with the organisation's multipliers. Read-only: the Team Lead types no XP. Pure.
import { calculateTaskXP } from "./xpEngine.js";

export const estimatedXp = ({ type, priority, rules = null }) =>
  calculateTaskXP({ task: { type, priority }, isLate: false, qualityStars: 3, orgRules: rules }).finalXP;
