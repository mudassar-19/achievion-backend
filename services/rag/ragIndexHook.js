// QA2-66: a project or task was created or changed -> refresh that organisation's AI knowledge index in the background
// (debounced, so a burst of edits is one rebuild). Off under DISABLE_JOBS (a local server on the shared live database);
// the Ask handler also refreshes a stale index on the first question, so nothing depends on this hook alone.
import mongoose from "mongoose";
import { jobsDisabled } from "../../utils/jobsFlag.js";

export function indexChanged(doc) {
  const orgId = doc?.orgId != null ? String(doc.orgId) : null;
  if (!orgId || jobsDisabled()) return;
  import("./ragStore.js").then((m) => m.scheduleReindex(orgId, mongoose)).catch(() => {});
}
