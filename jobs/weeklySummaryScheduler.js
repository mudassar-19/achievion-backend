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
import { callAI }    from "../services/aiService.js";

function matchesSchedule(aiSettings, now) {
  const day  = now.getDay();  // 0=Sun … 6=Sat
  const hhmm = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  return day === (aiSettings.summaryDay ?? 1) && hhmm === (aiSettings.summaryTime ?? "09:00");
}

async function runOnce(now) {
  const orgs = await Organization.find({ "aiSettings.weeklySummaryEnabled": true },
    "aiSettings _id").lean();

  for (const org of orgs) {
    const orgId    = String(org._id);
    const settings = org.aiSettings;

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
      const result = await callAI({ feature: "weekly_summary", data: { orgId }, orgId, requestedBy: null });

      // Find Director of this org for the notification
      const { default: User } = await import("../models/User.js");
      const director = await User.findOne({ orgId, role: "Director", isActive: true }).lean();
      if (director) {
        await Notification.create({
          userId: director._id, orgId,
          type: "system", tier: "fyi",
          title: "Weekly AI Summary (auto)",
          message: `[AI-generated] ${result.text}`,
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
