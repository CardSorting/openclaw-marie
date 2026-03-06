import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  readMemory,
  readUserModel,
  writeMemory,
  writeUserModel,
  createFrozenSnapshot,
} from "./marie-memory.js";

const log = createSubsystemLogger("agents/marie-memory-flush");

// ---------------------------------------------------------------------------
// Artifact Stripping Patterns
// ---------------------------------------------------------------------------

/**
 * Patterns for content that should be stripped before memory snapshot commit.
 * These inflate memory without providing recall value.
 */
const STRIP_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // Inline base64 data URIs
  {
    name: "base64-data-uri",
    pattern: /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{100,}/g,
  },
  // Large fenced code blocks (>500 chars)
  {
    name: "large-code-block",
    pattern: /```[\s\S]{500,}?```/g,
  },
  // Binary file references with hex content
  {
    name: "binary-hex",
    pattern: /\b[0-9a-f]{64,}\b/gi,
  },
  // Inline images in markdown
  {
    name: "inline-image",
    pattern: /!\[.*?\]\(data:image\/[^)]+\)/g,
  },
  // Raw JSON blobs > 200 chars
  {
    name: "large-json-blob",
    pattern: /\{(?:[^{}]|\{[^{}]*\}){200,}\}/g,
  },
];

/** Placeholder for stripped content. */
const STRIP_PLACEHOLDER = "[artifact-stripped]";

// ---------------------------------------------------------------------------
// Artifact Stripping
// ---------------------------------------------------------------------------

/**
 * Strip artifacts from memory content before snapshot commit.
 *
 * Removes inline base64 data, binary references, large code blocks,
 * and other content that inflates memory without providing recall value.
 *
 * Returns the stripped content and a count of stripped artifacts.
 */
export function stripArtifacts(content: string): { stripped: string; count: number } {
  let stripped = content;
  let count = 0;

  for (const entry of STRIP_PATTERNS) {
    const matches = stripped.match(entry.pattern);
    if (matches) {
      count += matches.length;
      stripped = stripped.replace(entry.pattern, STRIP_PLACEHOLDER);
    }
  }

  // Collapse multiple consecutive placeholders
  stripped = stripped.replace(
    /(\[artifact-stripped\]\s*){2,}/g,
    `${STRIP_PLACEHOLDER}\n`,
  );

  return { stripped, count };
}

// ---------------------------------------------------------------------------
// Memory Flush — Dedicated API Turn
// ---------------------------------------------------------------------------

export interface FlushResult {
  memoryFlushed: boolean;
  userModelFlushed: boolean;
  artifactsStripped: number;
  snapshotCreated: boolean;
  error?: string;
}

/**
 * Dedicated flush for memory persistence.
 *
 * This is the Marie flush cycle — a dedicated turn that:
 * 1. Reads current memory + user model
 * 2. Strips artifact references (base64, binary, large code blocks)
 * 3. Writes stripped content back
 * 4. Creates a frozen snapshot
 *
 * Designed to run in parallel with OpenClaw's pre-compaction flush
 * (belt-and-suspenders reliability).
 */
export async function flushMemory(agentDir: string): Promise<FlushResult> {
  const result: FlushResult = {
    memoryFlushed: false,
    userModelFlushed: false,
    artifactsStripped: 0,
    snapshotCreated: false,
  };

  try {
    // Read current state
    const [memory, userModel] = await Promise.all([
      readMemory(agentDir),
      readUserModel(agentDir),
    ]);

    // Strip artifacts from memory
    const memoryStrip = stripArtifacts(memory);
    const userStrip = stripArtifacts(userModel);
    result.artifactsStripped = memoryStrip.count + userStrip.count;

    // Write back stripped content (only if changes were made)
    if (memoryStrip.count > 0) {
      const writeResult = await writeMemory(agentDir, memoryStrip.stripped);
      result.memoryFlushed = writeResult.ok;
      if (!writeResult.ok) {
        result.error = writeResult.error;
        return result;
      }
    } else {
      result.memoryFlushed = true;
    }

    if (userStrip.count > 0) {
      const writeResult = await writeUserModel(agentDir, userStrip.stripped);
      result.userModelFlushed = writeResult.ok;
      if (!writeResult.ok) {
        result.error = writeResult.error;
        return result;
      }
    } else {
      result.userModelFlushed = true;
    }

    // Create frozen snapshot after flush
    await createFrozenSnapshot(agentDir);
    result.snapshotCreated = true;

    log.info(
      `Memory flush complete: ${result.artifactsStripped} artifacts stripped, snapshot created`,
    );
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    log.warn(`Memory flush failed: ${result.error}`);
  }

  return result;
}
