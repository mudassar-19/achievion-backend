/**
 * Idempotent migration: wrap legacy ChatChannels that have no communityId
 * into appropriate ChatCommunity parents.
 * Called once at server start.
 */
import ChatChannel   from "../models/ChatChannel.js";
import ChatCommunity from "../models/ChatCommunity.js";
import Organization  from "../models/Organization.js";

export async function seedCommunities() {
  try {
    // The old schema had only type "channel"; it is no longer a valid type, so saving such a channel failed. Idempotent.
    const fixed = await ChatChannel.updateMany({ type: "channel" }, { $set: { type: "general" } });
    if (fixed.modifiedCount) console.log(`[seedCommunities] ${fixed.modifiedCount} old "channel" type(s) set to "general".`);

    // Find all orgs that have orphaned channels (non-DM, no communityId)
    const orphaned = await ChatChannel.find({
      communityId: null,
      type:        { $ne: "dm" },
    }).lean();

    if (!orphaned.length) return;

    // Group by orgId
    const byOrg = {};
    for (const ch of orphaned) {
      const oid = ch.orgId.toString();
      (byOrg[oid] ??= []).push(ch);
    }

    for (const [orgId, channels] of Object.entries(byOrg)) {
      // Project-linked channels → one community per project
      const projectChannels = channels.filter((ch) => ch.projectId);
      const projectIds = [...new Set(projectChannels.map((ch) => ch.projectId?.toString()).filter(Boolean))];

      for (const projId of projectIds) {
        const projChans = projectChannels.filter((ch) => ch.projectId?.toString() === projId);
        const firstCh   = projChans[0];
        // Find or create community
        let community = await ChatCommunity.findOne({ orgId, projectId: firstCh.projectId });
        if (!community) {
          // Derive name from channel names (strip slug prefix)
          const name = firstCh.name.replace(/-announcements$|-general$|-dev$|-design$|-testing$/, "")
            || `Project ${projId.slice(-6)}`;
          const allMembers = [...new Set(projChans.flatMap((c) => (c.memberIds ?? []).map(String)))];
          community = await ChatCommunity.findOneAndUpdate(
            { orgId, name },
            { $setOnInsert: {
              orgId,
              name,
              description: `Project collaboration space`,
              icon:        "📁",
              type:        "project",
              projectId:   firstCh.projectId,
              createdBy:   firstCh.createdBy ?? allMembers[0] ?? null,
              adminIds:    firstCh.createdBy ? [firstCh.createdBy] : [],
              memberIds:   allMembers,
            }},
            { upsert: true, new: true }
          );
        }
        // Link channels to community
        await ChatChannel.updateMany(
          { _id: { $in: projChans.map((c) => c._id) }, communityId: null },
          { $set: { communityId: community._id } }
        );
      }

      // Non-project orphaned channels → "General" community per org
      const nonProjectChans = channels.filter((ch) => !ch.projectId);
      if (nonProjectChans.length) {
        const org = await Organization.findById(orgId, "name").lean();
        const commName = org?.name ? `${org.name} — General` : "General";
        const allMembers = [...new Set(nonProjectChans.flatMap((c) => (c.memberIds ?? []).map(String)))];
        const community = await ChatCommunity.findOneAndUpdate(
          { orgId, name: commName, type: "organization" },
          { $setOnInsert: {
            orgId,
            name:        commName,
            description: "Organization-wide collaboration",
            icon:        "🏢",
            type:        "organization",
            createdBy:   nonProjectChans[0]?.createdBy ?? allMembers[0] ?? null,
            adminIds:    nonProjectChans[0]?.createdBy ? [nonProjectChans[0].createdBy] : [],
            memberIds:   allMembers,
          }},
          { upsert: true, new: true }
        );
        await ChatChannel.updateMany(
          { _id: { $in: nonProjectChans.map((c) => c._id) }, communityId: null },
          { $set: { communityId: community._id } }
        );
      }
    }

    console.log("[Migration] seedCommunities: done.");
  } catch (err) {
    console.error("[Migration] seedCommunities failed:", err.message);
  }
}
