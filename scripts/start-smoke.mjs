import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const envFile = fs.readFileSync(new URL("../.env", import.meta.url).pathname, "utf8");
const env = { ...process.env };

for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

// Switch to achievion_dev
if (env.MONGO_URI) {
  env.MONGO_URI = env.MONGO_URI.replace(/\/(\?|$)/, "/achievion_dev$1");
}
env.PORT = process.env.LAUNCH_PORT || "5057";
env.CLIENT_URL = process.env.LAUNCH_CLIENT_URL || "http://localhost:5176";
// Optional: clear Cloudinary
if (process.env.NO_CLOUDINARY) {
  env.CLOUDINARY_CLOUD_NAME = "";
  env.CLOUDINARY_API_KEY = "";
  env.CLOUDINARY_API_SECRET = "";
}

const outFd = fs.openSync("/tmp/server5057-out.log", "w");
const errFd = fs.openSync("/tmp/server5057-err.log", "w");

const child = spawn("node", ["server.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  env,
  stdio: ["ignore", outFd, errFd],
  detached: true,
});

child.on("error", (e) => { console.error("spawn error:", e); process.exit(1); });

const pidFile = `/tmp/server${env.PORT}.pid`;
fs.writeFileSync(pidFile, String(child.pid));
console.log("PID=" + child.pid + " PORT=" + env.PORT);
child.unref();
process.exit(0);
