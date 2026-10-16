const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_NAME = "9router";

function defaultDir() {
  const home = (typeof os.homedir === "function" ? os.homedir() : "") || "/tmp";
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, APP_NAME);
  }
  return path.join(home, `.${APP_NAME}`);
}

function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    // In serverless / edge runtimes (e.g. Cloudflare Workers unenv stub) fs.mkdirSync is not implemented
    return configured;
  }
}

const DATA_DIR = getDataDir();
const MITM_DIR = path.join(DATA_DIR, "mitm");

module.exports = { DATA_DIR, MITM_DIR };
