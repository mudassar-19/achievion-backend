import bcrypt   from "bcryptjs";
import crypto   from "crypto";
import jwt      from "jsonwebtoken";
import mongoose  from "mongoose";
import Organization, { generateOrgId } from "../models/Organization.js";
import User          from "../models/User.js";
import AuditLog      from "../models/AuditLog.js";
import GamificationProfile from "../models/GamificationProfile.js";
import ChatChannel   from "../models/ChatChannel.js";
import { checkAndAwardBadges, checkAndAwardTitles } from "../services/gamificationService.js";

const PASSWORD_MIN = 8;

async function generateUniqueOrgCode(orgName) {
  const prefix = orgName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6)
    .padEnd(3, "X");
  let code, exists;
  do {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    code = `${prefix}-${suffix}`;
    exists = await Organization.findOne({ orgCode: code });
  } while (exists);
  return code;
}

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(
    crypto.randomBytes(12),
    (b) => chars[b % chars.length]
  ).join("");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function signOrgToken(org) {
  return jwt.sign(
    {
      orgId:   org.orgId,
      orgDbId: org._id.toString(),
      role:    "org_admin",
      type:    "org",
      name:    org.name,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN ?? "7d" }
  );
}

function sanitizeOrg(org) {
  return {
    id:                    org._id.toString(),
    orgDbId:               org._id.toString(),
    orgId:                 org.orgId,
    orgCode:               org.orgCode ?? null,
    name:                  org.name,
    adminEmail:            org.adminEmail,
    departments:           org.departments,
    companySize:           org.companySize,
    status:                org.status,
    directorSetupComplete: org.directorSetupComplete ?? false,
    createdAt:             org.createdAt,
  };
}

function clientError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// ── POST /api/org/register ────────────────────────────────────────────────────
export async function registerOrg(req, res) {
  const { orgName, adminEmail, password } = req.body ?? {};

  if (!orgName?.trim())     return clientError(res, 400, "Organisation name is required.");
  if (!adminEmail?.trim())  return clientError(res, 400, "Admin email is required.");
  if (!/\S+@\S+\.\S+/.test(adminEmail)) return clientError(res, 400, "Enter a valid email.");
  if (!password)            return clientError(res, 400, "Password is required.");
  if (password.length < PASSWORD_MIN)
    return clientError(res, 400, `Password must be at least ${PASSWORD_MIN} characters.`);

  const existing = await Organization.findOne({ adminEmail: adminEmail.toLowerCase().trim() });
  if (existing) return clientError(res, 409, "An organisation with this email already exists.");

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const orgCode    = await generateUniqueOrgCode(orgName.trim());
    const hashedPwd  = await bcrypt.hash(password, 10);

    let orgId, orgIdExists;
    do {
      orgId      = generateOrgId();
      orgIdExists = await Organization.findOne({ orgId }).session(session);
    } while (orgIdExists);

    const [org] = await Organization.create([{
      name:                  orgName.trim(),
      orgCode,
      orgId,
      adminEmail:            adminEmail.toLowerCase().trim(),
      passwordHash:          hashedPwd,
      directorSetupComplete: false,
    }], { session });

    await AuditLog.create([{
      action:      "ORG_CREATED",
      orgId:       org._id,
      performedBy: org._id,
      detail:      `Organization "${orgName}" registered.`,
    }], { session });

    await session.commitTransaction();
    session.endSession();

    return res.status(201).json({ success: true, orgCode: org.orgCode });
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    session.endSession();
    if (err.code === 11000) return clientError(res, 409, "An organisation with this email already exists.");
    console.error("[registerOrg] error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ── POST /api/org/login ───────────────────────────────────────────────────────
export async function loginOrg(req, res) {
  const { email, password } = req.body ?? {};

  if (!email?.trim() || !password)
    return clientError(res, 400, "Email and password are required.");

  try {
    const org = await Organization.findOne({
      adminEmail: email.toLowerCase().trim(),
    }).select("+passwordHash");

    const match = org ? await bcrypt.compare(password, org.passwordHash) : false;

    if (!org || !match) return clientError(res, 401, "Invalid email or password.");
    if (org.status === "suspended") return clientError(res, 403, "This organisation account has been suspended.");

    const token = signOrgToken(org);
    return res.json({ success: true, data: { token, org: sanitizeOrg(org) } });
  } catch (err) {
    console.error("[loginOrg] error:", err.message);
    return res.status(500).json({ success: false, error: "Login failed. Please try again." });
  }
}

// ── POST /api/org/setup-director ──────────────────────────────────────────────
// Protected. Called once after first org login to create the Director user.
export async function setupDirector(req, res) {
  const { directorName, directorEmail } = req.body ?? {};

  if (!directorName?.trim()) return clientError(res, 400, "Director name is required.");
  if (!directorEmail?.trim()) return clientError(res, 400, "Director email is required.");
  if (!/\S+@\S+\.\S+/.test(directorEmail)) return clientError(res, 400, "Enter a valid director email.");

  const org = await Organization.findOne({ orgId: req.org.orgId });
  if (!org) return clientError(res, 404, "Organisation not found.");
  if (org.directorSetupComplete) return clientError(res, 409, "Director has already been set up.");

  const existingUser = await User.findOne({ email: directorEmail.toLowerCase().trim() });
  if (existingUser) return clientError(res, 409, "An account with this email already exists.");

  const generatedPassword = generatePassword();
  const hashedPwd = await bcrypt.hash(generatedPassword, 10);

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const [director] = await User.create([{
      name:     directorName.trim(),
      email:    directorEmail.toLowerCase().trim(),
      password: hashedPwd,
      role:     "Director",
      orgId:    org._id.toString(),
      status:   "active",
    }], { session });

    await Organization.updateOne(
      { _id: org._id },
      {
        $addToSet:           { members: director._id },
        $set:                { directorSetupComplete: true },
      },
      { session }
    );

    const [directorProfile] = await GamificationProfile.create([{
      userId:      director._id,
      orgId:       org._id,
      totalXp:     0,
      monthlyXp:   0,
      level:       1,
      hp:          100,
      gold:        0,
      activeTitle: "newcomer",
      titles:      [{ id: "newcomer", name: "The Newcomer", rarity: "common", unlockedAt: new Date() }],
      stats:       { isFoundingMember: true },
    }], { session });

    await ChatChannel.insertMany([
      { orgId: org._id, name: "general",       type: "channel", isDefault: true, createdBy: director._id },
      { orgId: org._id, name: "announcements", type: "channel", isDefault: true, createdBy: director._id },
      { orgId: org._id, name: "random",        type: "channel", isDefault: true, createdBy: director._id },
    ], { session });

    await AuditLog.create([{
      action:      "DIRECTOR_SETUP",
      orgId:       org._id,
      performedBy: director._id,
      detail:      `Director "${directorName}" registered for org "${org.name}".`,
    }], { session });

    await session.commitTransaction();
    session.endSession();

    try {
      await checkAndAwardBadges(director._id, org._id, directorProfile.toObject());
      await checkAndAwardTitles(director._id, org._id, directorProfile.toObject(), director);
    } catch (e) {
      console.warn("[setupDirector] badge/title award failed (non-fatal):", e.message);
    }

    return res.status(201).json({
      success: true,
      data: {
        directorEmail:     directorEmail.toLowerCase().trim(),
        generatedPassword,
      },
    });
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    session.endSession();
    if (err.code === 11000) return clientError(res, 409, "An account with this email already exists.");
    console.error("[setupDirector] error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ── GET /api/org/me ───────────────────────────────────────────────────────────
export async function getOrgMe(req, res) {
  const org = await Organization.findOne({ orgId: req.org.orgId });
  if (!org) return clientError(res, 404, "Organisation not found.");
  return res.json({ success: true, data: { org: sanitizeOrg(org) } });
}

// ── POST /api/org/validate-invite ─────────────────────────────────────────────
export async function validateInvite(req, res) {
  const { orgId } = req.body ?? {};
  if (!orgId?.trim()) return clientError(res, 400, "orgId is required.");

  const org = await Organization.findOne({ orgId: orgId.trim().toUpperCase() });
  if (!org) return clientError(res, 404, "No organisation found with that invite code.");
  if (org.status === "suspended") return clientError(res, 403, "This organisation account has been suspended.");

  return res.json({ success: true, data: { valid: true, orgName: org.name, orgId: org.orgId } });
}
