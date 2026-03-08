import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getStrategicEvolutionStore } from "./strategic-evolution-store.js";

const log = createSubsystemLogger("agents/cortex-janitor");

const STRIP_PATTERNS = [
  { name: "base64", pattern: /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{100,}/g },
  { name: "large-code", pattern: /```[\s\S]{500,}?```/g },
  { name: "binary-hex", pattern: /\b[0-9a-f]{64,}\b/gi },
  { name: "inline-image", pattern: /!\[.*?\]\(data:image\/[^)]+\)/g },
  { name: "large-json", pattern: /\{(?:[^{}]|\{[^{}]*\}){200,}\}/g },
];

const STRIP_PLACEHOLDER = "[artifact-stripped]";

/**
 * CortexJanitor handles advanced memory hygiene.
 */
export class CortexJanitor {
  /**
   * Run a full hygiene pass on memory content.
   */
  public static async runHygiene(
    content: string,
    sessionKey?: string,
  ): Promise<{ cleaned: string; strippedCount: number }> {
    let cleaned = content;
    let strippedCount = 0;

    // 1. Basic Artifact Stripping
    for (const entry of STRIP_PATTERNS) {
      const matches = cleaned.match(entry.pattern);
      if (matches) {
        strippedCount += matches.length;
        cleaned = cleaned.replace(entry.pattern, STRIP_PLACEHOLDER);
      }
    }

    // 2. Semantic Pruning: Remove multiple placeholders
    cleaned = cleaned.replace(/(\[artifact-stripped\]\s*){2,}/g, `${STRIP_PLACEHOLDER}\n`);

    // 3. Recall-Based Ablation (V2 Hardening)
    // If a line exists in memory but has 0 recall hits in the store after multiple sessions, it's dead context.
    if (sessionKey) {
      try {
        const store = await getStrategicEvolutionStore();
        const lines = cleaned.split("\n");
        const keptLines = lines.filter((line) => {
          const trimmed = line.trim();
          // Only ablate non-empty, non-header, sufficiently long lines
          if (trimmed.length < 20 || trimmed.startsWith("#") || trimmed.startsWith("- [ ]")) {
            return true;
          }
          const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
          const hits = store.getRecallHits(sessionKey, hash);

          // Heuristic: If it has 0 hits, it's a candidate for ablation.
          // We keep it if it's new (discovery logic covers this by not having an entry yet, but here we just check hits)
          return hits > 0;
        });

        if (keptLines.length < lines.length) {
          log.info(
            `Recall-Based Ablation: Pruned ${lines.length - keptLines.length} forgotten lines.`,
          );
          cleaned = keptLines.join("\n");
        }
      } catch (err) {
        log.warn(`Recall-Based Ablation failed: ${String(err)}`);
      }
    }

    // 4. Zombie Detection: Prune "Completed" tasks older than a certain format
    const lines = cleaned.split("\n");
    const completedTasks = lines.filter((l) => l.trim().startsWith("- [x]"));
    if (completedTasks.length > 50) {
      log.info(`Zombie Detection: Pruning ${completedTasks.length - 20} oldest completed tasks.`);
      cleaned = lines
        .filter((line) => {
          if (line.trim().startsWith("- [x]")) {
            const taskIdx = completedTasks.indexOf(line);
            return taskIdx >= completedTasks.length - 20;
          }
          return true;
        })
        .join("\n");
    }

    return { cleaned, strippedCount };
  }
}
