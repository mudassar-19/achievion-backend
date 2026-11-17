/**
 * weeklySummaryScheduler.js
 * Runs every minute, checks all orgs with weeklySummaryEnabled=true,
 * fires on summaryDay/summaryTime (local server time), guards via lastRunAt.
 *
 * No real AI call if OPENAI_API_KEY is unset — logs AIPromptLog with configured:false.
 */
import cron from "node-cron";
import Organization from "../models/Organization.js";
import Notification  from "../models/Notification.js";
import { recapCards, aiRecapSummary } from "../services/recapService.js";
import { periodRange, completedPeriodFor } from "../services/recapMetrics.js";

function matchesSchedule(aiSettings, now) {
  const day  = now.getDay();  // 0=Sun … 6=Sat
  const hhmm = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  return day === (aiSettings.summaryDay ?? 1) && hhmm === (aiSettings.summaryTime ?? "09:00");
}

async function runOnce(now) {
  // Item 42: the weekly AI summary is always on for every org (the toggle is gone from Settings; the stored flag is ignored).
  const orgs = await Organization.find({}, "aiSettings gamificationSettings _id").lean();

  for (const org of orgs) {
    // QA3 B-29: Settings > Gamification > "Weekly recap" is the one switch. Off means no automatic weekly summary and no recap pop-up.
    if (org.gamificationSettings?.recapEnabled === false) continue;
    const orgId    = String(org._id);
    const settings = org.aiSettings ?? {}; // old organisation documents may not have aiSettings at all

    if (!matchesSchedule(settings, now)) continue;

    // Duplicate guard: skip if already ran today
    const lastRun = settings.weeklySummaryLastRunAt;
    if (lastRun) {
      const last = new Date(lastRun);
      if (last.getFullYear() === now.getFullYear()
        && last.getMonth()   === now.getMonth()
        && last.getDate()    === now.getDate()) {
        continue; // already ran this day
      }
    }

    // Cost cap check via callAI (it throws 429 if over cap)
    try {
      // QA3 B-29 / G-18: the same summary as the Director's button: LAST COMPLETED week, real numbers, calm tone. Without AI the plain numbers are sent.
      const period = completedPeriodFor("weekly", now), range = periodRange(period.start, period.end);
      const cards = await recapCards(org, period);
      const ai = await aiRecapSummary({ orgId, userId: null, periodLabel: `Weekly recap, ${range}`, cards });
      const result = { text: ai.text ?? `Last week (${range}): ` + cards.filter((c) => c.metric?.value != null).slice(0, 4).map((c) => `${c.title.toLowerCase()} ${c.metric.value} ${c.metric.unit}`).join(", ") + ".", ai: !!ai.text };

      // Find Director of this org for the notification
      const { default: User } = await import("../models/User.js");
      const director = await User.findOne({ orgId, role: "Director", isActive: true }).lean();
      if (director) {
        await Notification.create({
          userId: director._id, orgId,
          type: "system", tier: "fyi",
          title: "Weekly summary",
          message: result.ai ? `[AI-generated] ${result.text}` : result.text,
        });
      }

      await Organization.updateOne({ _id: org._id }, { $set: { "aiSettings.weeklySummaryLastRunAt": now } });
    } catch (err) {
      if (err.status === 429) {
        console.warn(`[weeklySummary] org ${orgId} skipped — cost cap reached`);
      } else {
        console.warn(`[weeklySummary] org ${orgId} error — ${err.message}`);
      }
    }
  }
}

export function startWeeklySummaryScheduler() {
  // ponytail: minute-level granularity is good enough; sub-minute is unnecessary
  cron.schedule("* * * * *", () => runOnce(new Date()));
  console.log("[weeklySummary] scheduler started (every minute check)");
}
