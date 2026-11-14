import { Router } from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import { getCatalog, buyItem, getInventory, equipItem, unequipItem } from "../controllers/shopController.js";

const router = Router();
router.use(verifyToken);

router.get  ("/catalog",  getCatalog);
router.post ("/buy",      buyItem);
router.get  ("/inventory",getInventory);
router.patch("/equip",    equipItem);
router.patch("/unequip",  unequipItem);

export default router;
