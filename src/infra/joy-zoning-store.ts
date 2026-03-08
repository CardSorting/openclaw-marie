/**
 * Joy-Zoning Audit Store — SQLite persistence for architectural violations,
 * per-file strike tracking, and session health summaries.
 *
 * Uses Node 22+ built-in `node:sqlite` (DatabaseSync) — same pattern as
 * `src/memory/`. No external deps required.
 *
 * Ported concepts from cline-main's BufferedDbPool:
 * - Persistent violation audit trail
 * - Per-file strike tracking (progressive enforcement)
 * - Session aggregation for system prompt injection
 * - WAL mode + NORMAL sync for performance
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { SqliteConnectionPool, getGlobalSqlitePool } from "../memory/sqlite-pool.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

const log = createSubsystemLogger("infra/joy-zoning-store");

// ── Types ───────────────────────────────────────────────────────────────────

export type StoredViolation = {
  id: string;
  sessionKey: string;
  filePath: string;
  layer: string;
  level: "warning" | "block";
  message: string;
  correctionHint: string | null;
  severity: string | null;
  toolName: string | null;
  agentId: string | null;
  thoughtSnippet: string | null;
  createdAt: number;
};

export type StoredStrike = {
  filePath: string;
  strikeCount: number;
  lastViolation: string | null;
  updatedAt: number;
};

export type StoredSession = {
  sessionKey: string;
  warningCount: number;
  blockCount: number;
  agentId: string | null;
  lastTool: string | null;
  firstSeen: number;
  lastSeen: number;
};

export type JoyZoningHealthSummary = {
  totalViolations: number;
  totalWarnings: number;
  totalBlocks: number;
  filesWithStrikes: number;
  topOffenders: StoredStrike[];
};

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA busy_timeout = 10000;

CREATE TABLE IF NOT EXISTS jz_violations (
  id TEXT PRIMARY KEY,
  sessionKey TEXT NOT NULL,
  filePath TEXT NOT NULL,
  layer TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  correctionHint TEXT,
  severity TEXT,
  toolName TEXT,
  agentId TEXT,
  thoughtSnippet TEXT,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jz_strikes (
  filePath TEXT PRIMARY KEY,
  strikeCount INTEGER NOT NULL DEFAULT 0,
  lastViolation TEXT,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jz_sessions (
  sessionKey TEXT PRIMARY KEY,
  warningCount INTEGER NOT NULL DEFAULT 0,
  blockCount INTEGER NOT NULL DEFAULT 0,
  agentId TEXT,
  lastTool TEXT,
  firstSeen INTEGER NOT NULL,
  lastSeen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jz_dependencies (
  sourcePath TEXT NOT NULL,
  targetPath TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (sourcePath, targetPath)
);

CREATE TABLE IF NOT EXISTS jz_performance (
  filePath TEXT NOT NULL,
  durationMs REAL NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_violations_session ON jz_violations(sessionKey);
CREATE INDEX IF NOT EXISTS idx_violations_file ON jz_violations(filePath);
CREATE INDEX IF NOT EXISTS idx_violations_created ON jz_violations(createdAt);
CREATE INDEX IF NOT EXISTS idx_deps_source ON jz_dependencies(sourcePath);
CREATE INDEX IF NOT EXISTS idx_deps_target ON jz_dependencies(targetPath);
CREATE INDEX IF NOT EXISTS idx_perf_created ON jz_performance(createdAt);
`;

// ── Store ───────────────────────────────────────────────────────────────────

export class JoyZoningStore {
  private pool: SqliteConnectionPool;
  private stmtCache = new Map<string, any>();

  constructor(pool: SqliteConnectionPool) {
    this.pool = pool;
    this.initialize();
    this.ensureSchema();
  }

  private initialize(): void {
    this.pool.withWriteLock((db) => {
      db.exec(SCHEMA_SQL);
    });
  }

  /**
   * Ensures the database schema is up-to-date by adding missing columns.
   */
  private ensureSchema(): void {
    const tables = {
      jz_violations: ["agentId", "severity", "toolName", "thoughtSnippet"],
      jz_sessions: ["agentId", "lastTool"],
    };

    this.pool.withWriteLock((db) => {
      for (const [table, columns] of Object.entries(tables)) {
        try {
          const info = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
          const existing = new Set(info.map((c) => c.name));

          for (const col of columns) {
            if (!existing.has(col)) {
              db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
            }
          }
        } catch (err) {
          // Silently continue if pragma check fails
        }
      }
    });
  }

  private prepare(db: any, sql: string): any {
    return db.prepare(sql);
  }


  // ── Violations ──────────────────────────────────────────────────────────

  async recordViolation(params: {
    sessionKey: string;
    filePath: string;
    layer: string;
    level: "warning" | "block";
    message: string;
    correctionHint?: string;
    severity?: string;
    toolName?: string;
    agentId?: string;
    thoughtSnippet?: string;
  }): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    await this.pool.transaction((db) => {
      this.prepare(
        db,
        `INSERT INTO jz_violations (id, sessionKey, filePath, layer, level, message, correctionHint, severity, toolName, agentId, thoughtSnippet, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        params.sessionKey,
        params.filePath,
        params.layer,
        params.level,
        params.message,
        params.correctionHint ?? null,
        params.severity ?? null,
        params.toolName ?? null,
        params.agentId ?? null,
        params.thoughtSnippet ?? null,
        now,
      );

      // Update session counters and attribution
      this.upsertSession(db, params.sessionKey, params.level, now, params.agentId);
    });
    return id;
  }

  private upsertSession(
    db: any,
    sessionKey: string,
    level: "warning" | "block",
    timestamp: number,
    agentId?: string,
  ): void {
    const existing = this.prepare(
      db,
      `SELECT warningCount, blockCount FROM jz_sessions WHERE sessionKey = ?`,
    ).get(sessionKey) as { warningCount: number; blockCount: number } | undefined;

    if (existing) {
      const warningInc = level === "warning" ? 1 : 0;
      const blockInc = level === "block" ? 1 : 0;
      this.prepare(
        db,
        `UPDATE jz_sessions SET warningCount = ?, blockCount = ?, lastSeen = ?, agentId = COALESCE(agentId, ?) WHERE sessionKey = ?`,
      ).run(
        existing.warningCount + warningInc,
        existing.blockCount + blockInc,
        timestamp,
        agentId ?? null,
        sessionKey,
      );
    } else {
      this.prepare(
        db,
        `INSERT INTO jz_sessions (sessionKey, warningCount, blockCount, agentId, firstSeen, lastSeen)
           VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionKey,
        level === "warning" ? 1 : 0,
        level === "block" ? 1 : 0,
        agentId ?? null,
        timestamp,
        timestamp,
      );
    }
  }

  getRecentViolations(sessionKey: string, limit = 10): StoredViolation[] {
    const db = this.pool.acquireRead();
    return this.prepare(
      db,
      `SELECT id, sessionKey, filePath, layer, level, message, correctionHint, agentId, thoughtSnippet, createdAt
         FROM jz_violations
         WHERE sessionKey = ?
         ORDER BY createdAt DESC
         LIMIT ?`,
    ).all(sessionKey, limit) as StoredViolation[];
  }

  getViolationsByFile(filePath: string, limit = 20): StoredViolation[] {
    const db = this.pool.acquireRead();
    return this.prepare(
      db,
      `SELECT id, sessionKey, filePath, layer, level, message, correctionHint, createdAt
         FROM jz_violations
         WHERE filePath = ?
         ORDER BY createdAt DESC
         LIMIT ?`,
    ).all(filePath, limit) as StoredViolation[];
  }

  // ── Strikes ─────────────────────────────────────────────────────────────

  async getOrIncrementStrike(filePath: string, violationMessage?: string): Promise<number> {
    return await this.incrementStrikes(filePath, 1, violationMessage);
  }

  async incrementStrikes(filePath: string, amount: number, violationMessage?: string): Promise<number> {
    const now = Date.now();
    return await this.pool.withWriteLock((db) => {
      const existing = this.prepare(db, `SELECT strikeCount FROM jz_strikes WHERE filePath = ?`).get(
        filePath,
      ) as { strikeCount: number } | undefined;

      if (existing) {
        const newCount = existing.strikeCount + amount;
        this.prepare(
          db,
          `UPDATE jz_strikes SET strikeCount = ?, lastViolation = ?, updatedAt = ? WHERE filePath = ?`,
        ).run(newCount, violationMessage ?? null, now, filePath);
        return newCount;
      }

      this.prepare(
        db,
        `INSERT INTO jz_strikes (filePath, strikeCount, lastViolation, updatedAt) VALUES (?, ?, ?, ?)`,
      ).run(filePath, amount, violationMessage ?? null, now);
      return amount;
    });
  }

  getStrikeCount(filePath: string): number {
    const db = this.pool.acquireRead();
    const row = this.prepare(db, `SELECT strikeCount FROM jz_strikes WHERE filePath = ?`).get(
      filePath,
    ) as { strikeCount: number } | undefined;
    return row?.strikeCount ?? 0;
  }

  async resetStrike(filePath: string): Promise<void> {
    await this.pool.withWriteLock((db) => {
      this.prepare(db, `DELETE FROM jz_strikes WHERE filePath = ?`).run(filePath);
    });
  }

  getTopStrikes(limit = 10): StoredStrike[] {
    const db = this.pool.acquireRead();
    return this.prepare(
      db,
      `SELECT filePath, strikeCount, lastViolation, updatedAt
         FROM jz_strikes
         ORDER BY strikeCount DESC
         LIMIT ?`,
    ).all(limit) as StoredStrike[];
  }

  // ── Dependencies & Circularity ──────────────────────────────────────────

  async recordDependency(sourcePath: string, targetPath: string): Promise<void> {
    const now = Date.now();
    await this.pool.withWriteLock((db) => {
      this.prepare(
        db,
        `INSERT OR IGNORE INTO jz_dependencies (sourcePath, targetPath, createdAt) VALUES (?, ?, ?)`,
      ).run(sourcePath, targetPath, now);
    });
  }

  /**
   * Detects if adding a dependency from source to target creates a cycle.
   * Uses Depth-First Search (DFS).
   */
  detectCycle(sourcePath: string, targetPath: string): string[] | null {
    if (sourcePath === targetPath) return [sourcePath, targetPath];

    const db = this.pool.acquireRead();
    const visited = new Set<string>();
    const path: string[] = [sourcePath];

    const dfs = (current: string): string[] | null => {
      if (current === sourcePath) return [...path, current];
      if (visited.has(current)) return null;

      visited.add(current);
      path.push(current);

      const deps = this.prepare(db, `SELECT targetPath FROM jz_dependencies WHERE sourcePath = ?`).all(
        current,
      ) as { targetPath: string }[];

      for (const dep of deps) {
        const result = dfs(dep.targetPath);
        if (result) return result;
      }

      path.pop();
      return null;
    };

    return dfs(targetPath);
  }

  async recordPerformance(filePath: string, durationMs: number): Promise<void> {
    const now = Date.now();
    await this.pool.withWriteLock((db) => {
      this.prepare(
        db,
        `INSERT INTO jz_performance (filePath, durationMs, createdAt) VALUES (?, ?, ?)`,
      ).run(filePath, durationMs, now);
    });
  }



  getSessionSummary(sessionKey: string): StoredSession | null {
    const db = this.pool.acquireRead();
    return (
      (this.prepare(
        db,
        `SELECT sessionKey, warningCount, blockCount, agentId, lastTool, firstSeen, lastSeen
           FROM jz_sessions WHERE sessionKey = ?`,
      ).get(sessionKey) as StoredSession | undefined) ?? null
    );
  }

  getHealthSummary(): JoyZoningHealthSummary {
    const db = this.pool.acquireRead();
    const violationCount = this.prepare(db, `SELECT COUNT(*) AS cnt FROM jz_violations`).get() as {
      cnt: number;
    };
    const warningCount = this.prepare(
      db,
      `SELECT COALESCE(SUM(warningCount), 0) AS cnt FROM jz_sessions`,
    ).get() as { cnt: number };
    const blockCount = this.prepare(
      db,
      `SELECT COALESCE(SUM(blockCount), 0) AS cnt FROM jz_sessions`,
    ).get() as { cnt: number };
    const strikeFiles = this.prepare(
      db,
      `SELECT COUNT(*) AS cnt FROM jz_strikes WHERE strikeCount > 0`,
    ).get() as { cnt: number };

    return {
      totalViolations: violationCount.cnt,
      totalWarnings: warningCount.cnt,
      totalBlocks: blockCount.cnt,
      filesWithStrikes: strikeFiles.cnt,
      topOffenders: this.getTopStrikes(5),
    };
  }

  /**
   * Decay strikes over time. Files with no violations for `olderThanMs`
   * have their strike counts decremented. If they reach 0, they are removed.
   */
  async decayStrikes(olderThanMs: number): Promise<number> {
    return await this.pool.withWriteLock((db) => {
      // Decrement strikes for files not touched in a long time
      this.prepare(
        db,
        `UPDATE jz_strikes SET strikeCount = strikeCount - 1, updatedAt = ?
         WHERE updatedAt < ? AND strikeCount > 0`,
      ).run(Date.now(), Date.now() - olderThanMs);

      // Remove entries that have decayed to 0
      const result = this.prepare(db, `DELETE FROM jz_strikes WHERE strikeCount <= 0`).run();
      return Number(result.changes);
    });
  }

  // ── Maintenance ─────────────────────────────────────────────────────────

  /**
   * Prune old violations to keep the DB from growing unbounded.
   * Keeps the most recent `keepCount` entries.
   */
  async pruneViolations(keepCount = 500): Promise<number> {
    return await this.pool.withWriteLock((db) => {
      const result = this.prepare(
        db,
        `DELETE FROM jz_violations WHERE id NOT IN (
           SELECT id FROM jz_violations ORDER BY createdAt DESC LIMIT ?
         )`,
      ).run(keepCount);
      return Number(result.changes);
    });
  }

  /**
   * Prune sessions older than a specific timestamp to prevent unbounded growth.
   */
  async pruneOldSessions(olderThanMs: number): Promise<number> {
    return await this.pool.withWriteLock((db) => {
      const result = this.prepare(db, `DELETE FROM jz_sessions WHERE lastSeen < ?`).run(olderThanMs);
      return Number(result.changes);
    });
  }

  /**
   * Runs VACUUM and ANALYZE to optimize the SQLite database.
   */
  async optimize(): Promise<void> {
    await this.pool.withWriteLock((db) => {
      db.exec("VACUUM; ANALYZE;");
    });
  }

  /**
   * Clear all data — useful for test cleanup.
   */
  async clear(): Promise<void> {
    await this.pool.withWriteLock((db) => {
      db.exec(`DELETE FROM jz_violations; DELETE FROM jz_strikes; DELETE FROM jz_sessions;`);
    });
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

let _defaultStore: JoyZoningStore | null = null;

/**
 * Get or create the default Joy-Zoning store.
 * The DB file is created at `~/.openclaw/joy-zoning/audit.sqlite`.
 */
export function getJoyZoningStore(dbPath?: string): JoyZoningStore {
  if (_defaultStore) return _defaultStore;

  const resolvedPath =
    dbPath ??
    path.join(
      process.env.OPENCLAW_STATE_DIR ?? path.join(process.env.HOME ?? "/tmp", ".openclaw"),
      "joy-zoning",
      "audit.sqlite",
    );

  try {
    const pool = getGlobalSqlitePool(resolvedPath);
    _defaultStore = new JoyZoningStore(pool);
    log.info(`Joy-Zoning audit store opened via pool at ${resolvedPath}`);
    return _defaultStore;
  } catch (err) {
    log.warn(`Failed to open Joy-Zoning store: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * Create an in-memory store for testing.
 */
export function createInMemoryStore(): JoyZoningStore {
  const pool = new SqliteConnectionPool({ dbPath: ":memory:" });
  return new JoyZoningStore(pool);
}

/** Reset the default singleton — for testing. */
export function resetDefaultStore(): void {
  _defaultStore = null;
}
