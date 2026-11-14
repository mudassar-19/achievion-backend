/**
 * shopService.js — D-240..D-243, D-293 (IMPL-5 shop retune)
 * Shop catalog (constants) + atomic buy service.
 */
import GamificationProfile from "../models/GamificationProfile.js";
import ShopPurchase        from "../models/ShopPurchase.js";

// ── Catalog (D-293 — IMPL-5 retune; supersedes D-241) ────────────────────────
// unlockBadge: badge ID from BADGE_DEFINITIONS required to buy (FR06-05)
// unlockLevel: minimum GamificationProfile.level required to buy
// streak_freeze max 2 held at once enforced in shopBuyService
export const SHOP_CATALOG = [
  // Consumable
  { id: "streak_freeze",    name: "Streak Freeze",    type: "consumable", price: 100, unlockLevel: 1 },
  // Cosmetics — badge overlays
  { id: "badge_fire",       name: "Fire Badge",       type: "cosmetic", slot: "badge",  price: 150, unlockLevel: 1 },
  // Cosmetics — avatar frame overlays
  { id: "frame_gold",       name: "Gold Frame",       type: "cosmetic", slot: "frame",  price: 250, unlockLevel: 2 },
  { id: "badge_lightning",  name: "Lightning Badge",  type: "cosmetic", slot: "badge",  price: 250, unlockLevel: 2 },
  // Achievement-locked items (FR06-05)
  { id: "title_veteran",    name: "Veteran Title",    type: "cosmetic", slot: "title",  price: 400,
    unlockBadge: "task_slayer", unlockBadgeName: "Task Slayer" },
  { id: "frame_diamond",    name: "Diamond Frame",    type: "cosmetic", slot: "frame",  price: 600,
    unlockBadge: "on_fire",    unlockBadgeName: "On Fire" },
  { id: "title_champion",   name: "Champion Title",   type: "cosmetic", slot: "title",  price: 800, unlockLevel: 4 },
];

export const SHOP_CATALOG_MAP = Object.fromEntries(SHOP_CATALOG.map(i => [i.id, i]));

/**
 * shopBuyService — D-243
 * Atomically deducts gold and records a purchase.
 *
 * Returns: { success: true, purchase, item }
 *       or { success: false, code: "insufficient_gold"|"already_owned"|"not_found"|"locked"|"idempotent" }
 */
export async function shopBuyService(userId, orgId, itemId, idempotencyKey) {
  const item = SHOP_CATALOG_MAP[itemId];
  if (!item) return { success: false, code: "not_found" };

  // ── Idempotency check ───────────────────────────────────────────────────────
  if (idempotencyKey) {
    const existing = await ShopPurchase.findOne({ userId, idempotencyKey }).lean();
    if (existing) return { success: true, idempotent: true, purchase: existing, item };
  }

  const profile = await GamificationProfile.findOne({ userId }).lean();
  if (!profile) return { success: false, code: "no_profile" };

  // ── Level lock check ─────────────────────────────────────────────────────────
  if ((item.unlockLevel ?? 0) > 1 && profile.level < item.unlockLevel) {
    return { success: false, code: "locked_level", required: item.unlockLevel };
  }

  // ── Achievement badge lock check (FR06-05, D-293) ────────────────────────────
  if (item.unlockBadge) {
    const hasBadge = (profile.badges ?? []).some(b => b.id === item.unlockBadge);
    if (!hasBadge) {
      return { success: false, code: "locked_achievement",
               requiredBadge: item.unlockBadge, requiredBadgeName: item.unlockBadgeName };
    }
  }

  // ── Already-owned check for cosmetics ────────────────────────────────────────
  if (item.type === "cosmetic") {
    const owned = profile.ownedCosmetics ?? [];
    if (owned.includes(itemId)) return { success: false, code: "already_owned" };
  }

  // ── Streak freeze cap: max 2 held at once (D-293) ────────────────────────────
  if (item.id === "streak_freeze" && (profile.freezeCount ?? 0) >= 2) {
    return { success: false, code: "freeze_cap",
             message: "You can only hold 2 Streak Freezes at once." };
  }

  // ── Atomic deduct (D-243: conditional update, gold never negative) ────────────
  const updated = await GamificationProfile.findOneAndUpdate(
    { userId, gold: { $gte: item.price } },
    {
      $inc: { gold: -item.price, ...(item.id === "streak_freeze" ? { freezeCount: 1 } : {}) },
      ...(item.type === "cosmetic" ? { $addToSet: { ownedCosmetics: itemId } } : {}),
    },
    { returnDocument: "after" }
  );

  if (!updated) return { success: false, code: "insufficient_gold" };

  // ── Append-only ledger ────────────────────────────────────────────────────────
  const purchase = await ShopPurchase.create({
    userId, orgId, itemId, goldPaid: item.price, idempotencyKey: idempotencyKey ?? null,
  });

  return { success: true, purchase, item, gold: updated.gold };
}
