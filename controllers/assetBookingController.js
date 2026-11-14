// Asset Booking (D-295, D-295-b, IMPL-5b).
// Manager books, Manager/Director can cancel. Director read-only list.
// Race safety: BookingSlot model with unique (assetId, day) index.
// insertMany all day-slots first; E11000 on any slot → 409, cleanup already-inserted slots.
import AssetBooking from "../models/AssetBooking.js";
import BookingSlot  from "../models/BookingSlot.js";
import Asset        from "../models/Asset.js";
import AuditLog     from "../models/AuditLog.js";
import mongoose     from "mongoose";

const IS_OID = /^[0-9a-f]{24}$/i;
function ok(id) { return IS_OID.test(String(id ?? "")); }
function audit(orgId, userId, action, detail) {
  AuditLog.create({ action, orgId, performedBy: userId, scope: "asset", detail }).catch(() => {});
}

// Generate UTC day strings (YYYY-MM-DD) from from-date through to-date inclusive.
function daysInRange(from, to) {
  const days = [];
  const d = new Date(from.toISOString().slice(0, 10) + "T00:00:00.000Z");
  const last = new Date(to.toISOString().slice(0, 10) + "T00:00:00.000Z");
  while (d <= last) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// GET /api/manager/assets/:assetId/bookings  or  GET /api/director/assets/:assetId/bookings
export async function listBookings(req, res) {
  const { assetId } = req.params;
  if (!ok(assetId)) return res.status(400).json({ error: "Invalid asset id." });
  const orgId = req.user.orgId;
  const asset = await Asset.findOne({ _id: assetId, orgId }).lean();
  if (!asset) return res.status(404).json({ error: "Asset not found." });

  const bookings = await AssetBooking.find({ orgId, assetId, status: "active" })
    .sort({ from: 1 }).populate("bookedBy", "name role").populate("projectId", "title").lean();
  res.json({ bookings });
}

// POST /api/manager/assets/:assetId/bookings — { from, to, projectId?, note? }
export async function createBooking(req, res) {
  const { assetId } = req.params;
  if (!ok(assetId)) return res.status(400).json({ error: "Invalid asset id." });
  const orgId = req.user.orgId;
  const asset = await Asset.findOne({ _id: assetId, orgId }).lean();
  if (!asset) return res.status(404).json({ error: "Asset not found." });

  const from = new Date(req.body?.from);
  const to   = new Date(req.body?.to);
  if (!from || isNaN(from) || !to || isNaN(to)) return res.status(400).json({ error: "from and to must be valid dates." });
  if (to <= from) return res.status(400).json({ error: "to must be after from." });

  const days = daysInRange(from, to);
  if (days.length > 30) return res.status(400).json({ error: "Booking cannot span more than 30 days." });

  const projectId = req.body?.projectId ? (ok(req.body.projectId) ? req.body.projectId : null) : null;
  const note = String(req.body?.note ?? "").trim().slice(0, 500);
  const assetOid   = new mongoose.Types.ObjectId(assetId);
  const bookingOid = new mongoose.Types.ObjectId();

  // Atomic overlap check: insert one slot per day; E11000 means a day is taken.
  const slots = days.map((day) => ({ assetId: assetOid, day, bookingId: bookingOid }));
  try {
    await BookingSlot.insertMany(slots, { ordered: false });
  } catch (e) {
    await BookingSlot.deleteMany({ bookingId: bookingOid });
    if (e.code === 11000 || e.writeErrors?.some((w) => w.code === 11000)) {
      return res.status(409).json({ error: "This asset is already booked on one or more of those days." });
    }
    throw e;
  }

  try {
    const booking = new AssetBooking({
      _id: bookingOid, orgId, assetId: assetOid,
      projectId: projectId ? new mongoose.Types.ObjectId(projectId) : null,
      bookedBy: new mongoose.Types.ObjectId(req.user.id),
      from, to, note, status: "active",
    });
    await booking.save();
    audit(orgId, req.user.id, "asset_booked", `Asset "${asset.name}" booked ${days[0]} – ${days[days.length - 1]}.`);
    res.status(201).json({ booking });
  } catch (e) {
    await BookingSlot.deleteMany({ bookingId: bookingOid });
    throw e;
  }
}

// DELETE /api/manager/assets/:assetId/bookings/:bookingId — cancel (Manager or Director)
export async function cancelBooking(req, res) {
  const { assetId, bookingId } = req.params;
  if (!ok(assetId) || !ok(bookingId)) return res.status(400).json({ error: "Invalid id." });
  const orgId = req.user.orgId;

  const booking = await AssetBooking.findOne({ _id: bookingId, orgId, assetId });
  if (!booking) return res.status(404).json({ error: "Booking not found." });
  if (booking.status === "cancelled") return res.status(409).json({ error: "Booking already cancelled." });

  booking.status = "cancelled";
  await booking.save();
  await BookingSlot.deleteMany({ bookingId: booking._id });
  audit(orgId, req.user.id, "asset_booking_cancelled", `Booking ${bookingId} cancelled.`);
  res.json({ booking });
}
