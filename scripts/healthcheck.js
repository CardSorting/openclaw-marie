import http from "node:http";

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
    console.error(`Health check failed with status code: ${statusCode}`);
    process.exit(1);
  }
});

request.on("error", (err) => {
  console.error(`Health check request error: ${err.message}`);
  process.exit(1);
});

request.on("timeout", () => {
  console.error("Health check request timed out");
  request.destroy();
  process.exit(1);
});

request.end();
