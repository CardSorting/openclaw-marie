import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { escapeRegExp, resolveConfigDir } from "../utils.js";

export function upsertSharedEnvVar(params: {
  key: string;
  value: string;
  env?: NodeJS.ProcessEnv;
}): { path: string; updated: boolean; created: boolean } {
  const env = params.env ?? process.env;
  const dir = resolveConfigDir(env);
  const filepath = path.join(dir, ".env");
  const key = params.key.trim();
  const value = params.value;

  let raw = "";
  if (fs.existsSync(filepath)) {
    raw = fs.readFileSync(filepath, "utf8");
  }

  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const matcher = new RegExp(`^(\\s*(?:export\\s+)?)${escapeRegExp(key)}\\s*=`);
  let updated = false;
  let replaced = false;

  const nextLines = lines.map((line) => {
    const match = line.match(matcher);
    if (!match) {
      return line;
    }
    replaced = true;
    const prefix = match[1] ?? "";
    const next = `${prefix}${key}=${value}`;
    if (next !== line) {
      updated = true;
    }
    return next;
  });

  if (!replaced) {
    nextLines.push(`${key}=${value}`);
    updated = true;
  }

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const output = `${nextLines.join("\n")}\n`;
  fs.writeFileSync(filepath, output, "utf8");
  fs.chmodSync(filepath, 0o600);

  return { path: filepath, updated, created: !raw };
}

export function readSharedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const filepath = path.join(resolveConfigDir(env), ".env");
  if (!fs.existsSync(filepath)) {
    return {};
  }
  const raw = fs.readFileSync(filepath, "utf8");
  return dotenv.parse(raw);
}

export function deleteSharedEnvVar(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; deleted: boolean } {
  const dir = resolveConfigDir(env);
  const filepath = path.join(dir, ".env");
  if (!fs.existsSync(filepath)) {
    return { path: filepath, deleted: false };
  }

  const raw = fs.readFileSync(filepath, "utf8");
  const lines = raw.split(/\r?\n/);
  const matcher = new RegExp(`^(\\s*(?:export\\s+)?)${escapeRegExp(key.trim())}\\s*=`);

  const nextLines = lines.filter((line) => !line.match(matcher));
  const deleted = nextLines.length !== lines.length;

  if (deleted) {
    fs.writeFileSync(filepath, `${nextLines.join("\n")}\n`, "utf8");
  }

  return { path: filepath, deleted };
}
