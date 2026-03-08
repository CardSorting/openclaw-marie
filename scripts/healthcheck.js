import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const CONFIG_DIR = process.env.OPENCLAW_CONFIG_DIR || "/home/node/.openclaw";
const BOOTSTRAP_LOCK = path.join(CONFIG_DIR, ".bootstrapping");

// If bootstrapping is in progress, we consider the service "healthy enough"
// to prevent Docker from restarting it prematurely during initial setup.
if (fs.existsSync(BOOTSTRAP_LOCK)) {
  process.exit(0);
}

const options = {
  host: "127.0.0.1",
  port: process.env.OPENCLAW_GATEWAY_PORT || 18789,
  path: "/healthz",
  timeout: 5000,
};

const request = http.request(options, (res) => {
  const statusCode = res.statusCode || 0;
  if (statusCode >= 200 && statusCode < 400) {
    process.exit(0);
  } else {
    console.error(`Health check failed: Gateway returned status ${statusCode}`);
    process.exit(1);
  }
});

request.on("error", (err) => {
  console.error(`Health check failed: Cannot reach Gateway (${err.message})`);
  process.exit(1);
});

request.on("timeout", () => {
  console.error("Health check failed: Gateway response timed out");
  request.destroy();
  process.exit(1);
});

request.end();
