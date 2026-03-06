import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/marie-memory");

// ---------------------------------------------------------------------------
// Constants — Hard Caps (non-negotiable)
// ---------------------------------------------------------------------------

/** MEMORY.md hard cap — agent-curated facts, preferences, task context. */
export const MEMORY_CHAR_CAP = 2200;

/** USER.md hard cap — user behavioral model (Honcho dialectic). */
export const USER_CHAR_CAP = 1375;

/** Directory name for frozen snapshots. */
const SNAPSHOT_DIR = "snapshots";

/** Maximum number of retained snapshots before pruning oldest. */
const MAX_SNAPSHOTS = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryWriteResult {
  ok: boolean;
  /** Error message when ok === false. */
  error?: string;
  /** Character count of the written content. */
  charCount: number;
  /** Hard cap that applies to this memory file. */
  cap: number;
}

export interface FrozenSnapshot {
  /** ISO-8601 timestamp of snapshot creation. */
  timestamp: string;
  /** SHA-256 hash of the snapshot content. */
  hash: string;
  /** Absolute path to the snapshot file. */
  path: string;
}

export interface MarieMemoryState {
  memory: string;
  userModel: string;
  lastSnapshotTs: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

function ensureDirSync(dir: string): void {
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function memoryPath(agentDir: string): string {
  return path.join(agentDir, "MEMORY.md");
}

function userModelPath(agentDir: string): string {
  return path.join(agentDir, "USER.md");
}

function snapshotDir(agentDir: string): string {
  return path.join(agentDir, SNAPSHOT_DIR);
}

// ---------------------------------------------------------------------------
// Read Operations
// ---------------------------------------------------------------------------

/**
 * Read bounded MEMORY.md content. Returns empty string if file doesn't exist.
 */
export async function readMemory(agentDir: string): Promise<string> {
  try {
    return await fs.readFile(memoryPath(agentDir), "utf8");
  } catch {
    return "";
  }
}

/**
 * Read bounded USER.md content. Returns empty string if file doesn't exist.
 */
export async function readUserModel(agentDir: string): Promise<string> {
  try {
    return await fs.readFile(userModelPath(agentDir), "utf8");
  } catch {
    return "";
  }
}

/**
 * Read full memory state (memory + user model + last snapshot timestamp).
 */
export async function readMemoryState(agentDir: string): Promise<MarieMemoryState> {
  const [memory, userModel, lastSnapshotTs] = await Promise.all([
    readMemory(agentDir),
    readUserModel(agentDir),
    getLastSnapshotTimestamp(agentDir),
  ]);
  return { memory, userModel, lastSnapshotTs };
}

import { validateMemoryWrite } from "../security/memory-write-gate.js";

// ... (keep constants and types)

// ---------------------------------------------------------------------------
// Write Operations — Cap-Enforced
// ---------------------------------------------------------------------------

/**
 * Write to MEMORY.md with hard cap enforcement and security scanning.
 *
 * Rejects writes that exceed MEMORY_CHAR_CAP or contain injection threats.
 * Never silently truncates — always returns an explicit error.
 */
export async function writeMemory(
  agentDir: string,
  content: string,
): Promise<MemoryWriteResult> {
  const charCount = content.length;
  const validation = validateMemoryWrite(content, "memory");

  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error,
      charCount,
      cap: MEMORY_CHAR_CAP,
    };
  }

  await ensureDir(agentDir);
  await fs.writeFile(memoryPath(agentDir), content, "utf8");
  log.info(`MEMORY.md written: ${charCount}/${MEMORY_CHAR_CAP} chars`);
  return { ok: true, charCount, cap: MEMORY_CHAR_CAP };
}

/**
 * Write to USER.md with hard cap enforcement and security scanning.
 *
 * Rejects writes that exceed USER_CHAR_CAP or contain injection threats.
 * Never silently truncates — always returns an explicit error.
 */
export async function writeUserModel(
  agentDir: string,
  content: string,
): Promise<MemoryWriteResult> {
  const charCount = content.length;
  const validation = validateMemoryWrite(content, "userModel");

  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error,
      charCount,
      cap: USER_CHAR_CAP,
    };
  }

  await ensureDir(agentDir);
  await fs.writeFile(userModelPath(agentDir), content, "utf8");
  log.info(`USER.md written: ${charCount}/${USER_CHAR_CAP} chars`);
  return { ok: true, charCount, cap: USER_CHAR_CAP };
}

// ---------------------------------------------------------------------------
// Frozen Snapshots — Immutable Copies for Cache Stability
// ---------------------------------------------------------------------------

/**
 * Create a frozen snapshot of the current memory state.
 *
 * Writes timestamped immutable copies to `snapshots/` directory.
 * Cache-stable: never live-watched, only written on explicit nudge/flush cycles.
 */
export async function createFrozenSnapshot(
  agentDir: string,
): Promise<FrozenSnapshot> {
  const [memory, userModel] = await Promise.all([
    readMemory(agentDir),
    readUserModel(agentDir),
  ]);

  const timestamp = new Date().toISOString();
  const combined = `# MEMORY.md\n${memory}\n\n# USER.md\n${userModel}`;
  const hash = hashContent(combined);

  const dir = snapshotDir(agentDir);
  await ensureDir(dir);

  // Filename: ISO timestamp (sanitized for filesystem) + hash prefix
  const safeTs = timestamp.replace(/[:.]/g, "-");
  const snapshotPath = path.join(dir, `${safeTs}_${hash}.md`);
  await fs.writeFile(snapshotPath, combined, "utf8");

  // Prune old snapshots beyond MAX_SNAPSHOTS
  await pruneOldSnapshots(dir);

  log.info(`Frozen snapshot created: ${snapshotPath}`);
  return { timestamp, hash, path: snapshotPath };
}

/**
 * Get the timestamp of the last frozen snapshot, or null if none exist.
 */
export async function getLastSnapshotTimestamp(
  agentDir: string,
): Promise<string | null> {
  const dir = snapshotDir(agentDir);
  try {
    const entries = await fs.readdir(dir);
    const snapshots = entries.filter((e) => e.endsWith(".md")).sort();
    if (snapshots.length === 0) return null;
    // Extract timestamp from filename pattern: YYYY-MM-DDTHH-MM-SS-sssZ_hash.md
    const last = snapshots[snapshots.length - 1]!;
    const tsPart = last.split("_")[0]!;
    // Restore the original ISO format
    return tsPart
      .replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "$1:$2:$3.$4Z");
  } catch {
    return null;
  }
}

/**
 * Prune oldest snapshots when count exceeds MAX_SNAPSHOTS.
 */
async function pruneOldSnapshots(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    const snapshots = entries.filter((e) => e.endsWith(".md")).sort();
    if (snapshots.length <= MAX_SNAPSHOTS) return;

    const toRemove = snapshots.slice(0, snapshots.length - MAX_SNAPSHOTS);
    for (const file of toRemove) {
      await fs.unlink(path.join(dir, file)).catch(() => {});
    }
    log.info(`Pruned ${toRemove.length} old snapshots`);
  } catch {
    // Directory may not exist yet
  }
}

// ---------------------------------------------------------------------------
// Capacity Helpers
// ---------------------------------------------------------------------------

/**
 * Get remaining capacity for MEMORY.md.
 */
export async function getMemoryCapacity(
  agentDir: string,
): Promise<{ used: number; remaining: number; cap: number }> {
  const content = await readMemory(agentDir);
  const used = content.length;
  return { used, remaining: Math.max(0, MEMORY_CHAR_CAP - used), cap: MEMORY_CHAR_CAP };
}

/**
 * Get remaining capacity for USER.md.
 */
export async function getUserModelCapacity(
  agentDir: string,
): Promise<{ used: number; remaining: number; cap: number }> {
  const content = await readUserModel(agentDir);
  const used = content.length;
  return { used, remaining: Math.max(0, USER_CHAR_CAP - used), cap: USER_CHAR_CAP };
}
