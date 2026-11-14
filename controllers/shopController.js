/**
 * shopController.js — D-243 / D-244 / D-246
 * Employee-only shop: catalog, buy, inventory (equip/unequip).
 */
import GamificationProfile from "../models/GamificationProfile.js";
import { SHOP_CATALOG, shopBuyService } from "../services/shopService.js";

const EMPLOYEE_ROLES = new Set(["Developer", "Designer", "Tester", "Senior Developer", "Junior Developer", "Senior Designer", "Junior Designer", "Senior Tester", "Junior Tester", "Team Lead"]);

function requireEmployee(req, res) {
  if (!EMPLOYEE_ROLES.has(req.user?.role)) {
    res.status(403).json({ error: "Shop is only available to employee roles." });
    return false;
  }
  return true;
}

// GET /api/shop/catalog
export async function getCatalog(req, res) {
  if (!requireEmployee(req, res)) return;
  const profile = await GamificationProfile.findOne(
    { userId: req.user._id }, "gold level ownedCosmetics freezeCount badges"
  ).lean();
  const gold    = profile?.gold ?? 0;
  const level   = profile?.level ?? 1;
  const owned   = new Set(profile?.ownedCosmetics ?? []);
  const earnedBadgeIds = new Set((profile?.badges ?? []).map(b => b.id));
  const freezeCount = profile?.freezeCount ?? 0;

  const items = SHOP_CATALOG.map(item => {
    // Determine lock status and reason
    let unlocked = true;
    let lockReason = null;
    if (item.unlockLevel && item.unlockLevel > 1 && level < item.unlockLevel) {
      unlocked = false;
      lockReason = `Reach level ${item.unlockLevel}`;
    } else if (item.unlockBadge && !earnedBadgeIds.has(item.unlockBadge)) {
      unlocked = false;
      lockReason = `Earn the ${item.unlockBadgeName} badge to unlock`;
    } else if (item.id === "streak_freeze" && freezeCount >= 2) {
      unlocked = false;
      lockReason = "You can only hold 2 Streak Freezes at once";
    }
    return {
      ...item,
      affordable: gold >= item.price,
      unlocked,
      lockReason,
      owned: owned.has(item.id),
    };
  });

  res.json({ items, gold, freezeCount });
}

// POST /api/shop/buy
export async function buyItem(req, res) {
  if (!requireEmployee(req, res)) return;
  const { itemId, idempotencyKey } = req.body ?? {};
  if (!itemId) return res.status(400).json({ error: "itemId is required." });

  const userId = req.user._id;
  const orgId  = req.user.orgId;

  const result = await shopBuyService(userId, orgId, itemId, idempotencyKey ?? null);

  if (result.idempotent) return res.status(200).json({ message: "Already purchased (idempotent).", purchase: result.purchase, item: result.item });

  if (!result.success) {
    const msgs = {
      not_found:          "Item not found in shop catalog.",
      insufficient_gold:  "Insufficient gold.",
      already_owned:      "You already own this item.",
      locked_level:       `This item requires level ${result.required}.`,
      locked_achievement: `Earn the ${result.requiredBadgeName} badge to unlock this item.`,
      freeze_cap:         result.message ?? "You can only hold 2 Streak Freezes at once.",
      no_profile:         "Gamification profile not found.",
    };
    const status = result.code === "already_owned" ? 409 : 400;
    return res.status(status).json({ error: msgs[result.code] ?? "Purchase failed." });
  }

  res.status(201).json({ message: "Purchase successful.", item: result.item, gold: result.gold });
}

// GET /api/shop/inventory
export async function getInventory(req, res) {
  if (!requireEmployee(req, res)) return;
  const profile = await GamificationProfile.findOne(
    { userId: req.user._id },
    "ownedCosmetics shopEquipped freezeCount gold"
  ).lean();

  const owned = profile?.ownedCosmetics ?? [];
  const equipped = profile?.shopEquipped instanceof Map
    ? Object.fromEntries(profile.shopEquipped)
    : (profile?.shopEquipped ?? {});
  res.json({ ownedCosmetics: owned, equipped, freezeCount: profile?.freezeCount ?? 0, gold: profile?.gold ?? 0 });
}

// PATCH /api/shop/equip
export async function equipItem(req, res) {
  if (!requireEmployee(req, res)) return;
  const { itemId } = req.body ?? {};
  if (!itemId) return res.status(400).json({ error: "itemId is required." });

  const profile = await GamificationProfile.findOne({ userId: req.user._id }, "ownedCosmetics").lean();
  if (!profile?.ownedCosmetics?.includes(itemId)) {
    return res.status(403).json({ error: "You do not own this item." });
  }

  const item = SHOP_CATALOG.find(i => i.id === itemId && i.type === "cosmetic");
  if (!item) return res.status(400).json({ error: "Item is not equippable." });

  await GamificationProfile.updateOne({ userId: req.user._id }, { $set: { [`shopEquipped.${item.slot}`]: itemId } });
  res.json({ message: `${item.name} equipped in slot "${item.slot}".`, slot: item.slot, itemId });
}

// PATCH /api/shop/unequip
export async function unequipItem(req, res) {
  if (!requireEmployee(req, res)) return;
  const { slot } = req.body ?? {};
  if (!slot) return res.status(400).json({ error: "slot is required." });

  await GamificationProfile.updateOne({ userId: req.user._id }, { $unset: { [`shopEquipped.${slot}`]: "" } });
  res.json({ message: `Slot "${slot}" unequipped.`, slot });
}
