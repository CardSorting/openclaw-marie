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
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
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
  private db: DatabaseSync;
  private stmtCache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.initialize();
    this.ensureSchema();
  }

  private initialize(): void {
    const db = this.db;
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA synchronous = NORMAL;");

    // Strikes table: persistent per-file architectural debt count
    db.exec(`
      CREATE TABLE IF NOT EXISTS jz_strikes (
        filePath TEXT PRIMARY KEY,
        strikeCount INTEGER NOT NULL DEFAULT 0,
        lastViolation TEXT,
        updatedAt INTEGER NOT NULL
      )
    `);

    // Violations log: immutable record of every audit failure
    db.exec(`
      CREATE TABLE IF NOT EXISTS jz_violations (
        id TEXT PRIMARY KEY,
        sessionKey TEXT NOT NULL,
        filePath TEXT NOT NULL,
        layer TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        correctionHint TEXT,
        agentId TEXT,
        thoughtSnippet TEXT,
        createdAt INTEGER NOT NULL
      )
    `);

    // Dependencies table: for graph-based circularity detection
    db.exec(`
      CREATE TABLE IF NOT EXISTS jz_dependencies (
        sourcePath TEXT NOT NULL,
        targetPath TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (sourcePath, targetPath)
      )
    `);

    // Sessions table: track agent state across tool calls
    db.exec(`
      CREATE TABLE IF NOT EXISTS jz_sessions (
        sessionKey TEXT PRIMARY KEY,
        warningCount INTEGER NOT NULL DEFAULT 0,
        blockCount INTEGER NOT NULL DEFAULT 0,
        agentId TEXT,
        firstSeen INTEGER NOT NULL,
        lastSeen INTEGER NOT NULL
      )
    `);

    db.exec("CREATE INDEX IF NOT EXISTS idx_violations_session ON jz_violations(sessionKey);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_violations_file ON jz_violations(filePath);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_deps_source ON jz_dependencies(sourcePath);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_deps_target ON jz_dependencies(targetPath);");
  }

  /**
   * Ensures the database schema is up-to-date by adding missing columns.
   */
  private ensureSchema(): void {
    const tables = {
      jz_violations: ["agentId", "severity", "toolName", "thoughtSnippet"],
      jz_sessions: ["agentId", "lastTool"],
    };

    for (const [table, columns] of Object.entries(tables)) {
      try {
        const info = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        const existing = new Set(info.map((c) => c.name));

        for (const col of columns) {
          if (!existing.has(col)) {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
            this.db.exec(`PRAGMA user_version = ${Date.now()}`);
          }
        }
      } catch (err) {
        // Silently continue if pragma check fails
      }
    }
  }

  private prepare(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  private runInTransaction<T>(fn: () => T): T {
    const MAX_RETRIES = 5;
    let lastErr: any;

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        this.db.exec("BEGIN IMMEDIATE"); // Use IMMEDIATE to lock early and prevent deadlocks
        try {
          const result = fn();
          this.db.exec("COMMIT");
          return result;
        } catch (err) {
          this.db.exec("ROLLBACK");
          throw err;
        }
      } catch (err: any) {
        lastErr = err;
        if (err?.code === "SQLITE_BUSY" || String(err).includes("busy")) {
          const delay = 50 * Math.pow(2, i) + Math.random() * 50;
          log.warn(`Joy-Zoning store busy (retry ${i + 1}/${MAX_RETRIES}), waiting ${delay.toFixed(0)}ms`);
          // Busy wait since DatabaseSync is synchronous
          const start = Date.now();
          while (Date.now() - start < delay) {
            // spin
          }
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  // ── Violations ──────────────────────────────────────────────────────────

  recordViolation(params: {
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
  }): string {
    return this.runInTransaction(() => {
      const id = randomUUID();
      const now = Date.now();
      this.prepare(
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
      this.upsertSession(params.sessionKey, params.level, now, params.agentId);

      return id;
    });
  }

  private upsertSession(
    sessionKey: string,
    level: "warning" | "block",
    timestamp: number,
    agentId?: string,
  ): void {
    const existing = this.prepare(
      `SELECT warningCount, blockCount FROM jz_sessions WHERE sessionKey = ?`,
    ).get(sessionKey) as { warningCount: number; blockCount: number } | undefined;

    if (existing) {
      const warningInc = level === "warning" ? 1 : 0;
      const blockInc = level === "block" ? 1 : 0;
      this.prepare(
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
    return this.prepare(
      `SELECT id, sessionKey, filePath, layer, level, message, correctionHint, agentId, thoughtSnippet, createdAt
         FROM jz_violations
         WHERE sessionKey = ?
         ORDER BY createdAt DESC
         LIMIT ?`,
    ).all(sessionKey, limit) as StoredViolation[];
  }

  getViolationsByFile(filePath: string, limit = 20): StoredViolation[] {
    return this.prepare(
      `SELECT id, sessionKey, filePath, layer, level, message, correctionHint, createdAt
         FROM jz_violations
         WHERE filePath = ?
         ORDER BY createdAt DESC
         LIMIT ?`,
    ).all(filePath, limit) as StoredViolation[];
  }

  // ── Strikes ─────────────────────────────────────────────────────────────

  getOrIncrementStrike(filePath: string, violationMessage?: string): number {
    const now = Date.now();
    return this.runInTransaction(() => {
      const existing = this.prepare(`SELECT strikeCount FROM jz_strikes WHERE filePath = ?`).get(
        filePath,
      ) as { strikeCount: number } | undefined;

      if (existing) {
        const newCount = existing.strikeCount + 1;
        this.prepare(
          `UPDATE jz_strikes SET strikeCount = ?, lastViolation = ?, updatedAt = ? WHERE filePath = ?`,
        ).run(newCount, violationMessage ?? null, now, filePath);
        return newCount;
      }

      this.prepare(
        `INSERT INTO jz_strikes (filePath, strikeCount, lastViolation, updatedAt) VALUES (?, 1, ?, ?)`,
      ).run(filePath, violationMessage ?? null, now);
      return 1;
    });
  }

  getStrikeCount(filePath: string): number {
    const row = this.prepare(`SELECT strikeCount FROM jz_strikes WHERE filePath = ?`).get(
      filePath,
    ) as { strikeCount: number } | undefined;
    return row?.strikeCount ?? 0;
  }

  resetStrike(filePath: string): void {
    this.prepare(`DELETE FROM jz_strikes WHERE filePath = ?`).run(filePath);
  }

  getTopStrikes(limit = 10): StoredStrike[] {
    return this.prepare(
      `SELECT filePath, strikeCount, lastViolation, updatedAt
         FROM jz_strikes
         ORDER BY strikeCount DESC
         LIMIT ?`,
    ).all(limit) as StoredStrike[];
  }

  // ── Dependencies & Circularity ──────────────────────────────────────────

  recordDependency(sourcePath: string, targetPath: string): void {
    const now = Date.now();
    this.prepare(
      `INSERT OR IGNORE INTO jz_dependencies (sourcePath, targetPath, createdAt) VALUES (?, ?, ?)`,
    ).run(sourcePath, targetPath, now);
  }

  /**
   * Detects if adding a dependency from source to target creates a cycle.
   * Uses Depth-First Search (DFS).
   */
  detectCycle(sourcePath: string, targetPath: string): string[] | null {
    if (sourcePath === targetPath) return [sourcePath, targetPath];

    const visited = new Set<string>();
    const path: string[] = [sourcePath];

    const dfs = (current: string): string[] | null => {
      if (current === sourcePath) return [...path, current];
      if (visited.has(current)) return null;

      visited.add(current);
      path.push(current);

      const deps = this.prepare(`SELECT targetPath FROM jz_dependencies WHERE sourcePath = ?`).all(
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

  recordPerformance(filePath: string, durationMs: number): void {
    const now = Date.now();
    this.prepare(
      `INSERT INTO jz_performance (filePath, durationMs, createdAt) VALUES (?, ?, ?)`,
    ).run(filePath, durationMs, now);
  }



  getSessionSummary(sessionKey: string): StoredSession | null {
    return (
      (this.prepare(
        `SELECT sessionKey, warningCount, blockCount, agentId, lastTool, firstSeen, lastSeen
           FROM jz_sessions WHERE sessionKey = ?`,
      ).get(sessionKey) as StoredSession | undefined) ?? null
    );
  }

  getHealthSummary(): JoyZoningHealthSummary {
    const violationCount = this.prepare(`SELECT COUNT(*) AS cnt FROM jz_violations`).get() as {
      cnt: number;
    };
    const warningCount = this.prepare(
      `SELECT COALESCE(SUM(warningCount), 0) AS cnt FROM jz_sessions`,
    ).get() as { cnt: number };
    const blockCount = this.prepare(
      `SELECT COALESCE(SUM(blockCount), 0) AS cnt FROM jz_sessions`,
    ).get() as { cnt: number };
    const strikeFiles = this.prepare(
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
  decayStrikes(olderThanMs: number): number {
    return this.runInTransaction(() => {
      // Decrement strikes for files not touched in a long time
      this.prepare(
        `UPDATE jz_strikes SET strikeCount = strikeCount - 1, updatedAt = ?
         WHERE updatedAt < ? AND strikeCount > 0`,
      ).run(Date.now(), Date.now() - olderThanMs);

      // Remove entries that have decayed to 0
      const result = this.prepare(`DELETE FROM jz_strikes WHERE strikeCount <= 0`).run();
      return Number(result.changes);
    });
  }

  // ── Maintenance ─────────────────────────────────────────────────────────

  /**
   * Prune old violations to keep the DB from growing unbounded.
   * Keeps the most recent `keepCount` entries.
   */
  pruneViolations(keepCount = 500): number {
    return this.runInTransaction(() => {
      const result = this.prepare(
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
  pruneOldSessions(olderThanMs: number): number {
    return this.runInTransaction(() => {
      const result = this.prepare(`DELETE FROM jz_sessions WHERE lastSeen < ?`).run(olderThanMs);
      return Number(result.changes);
    });
  }

  /**
   * Runs VACUUM and ANALYZE to optimize the SQLite database.
   */
  optimize(): void {
    this.db.exec("VACUUM; ANALYZE;");
  }

  /**
   * Clear all data — useful for test cleanup.
   */
  clear(): void {
    this.db.exec(`DELETE FROM jz_violations; DELETE FROM jz_strikes; DELETE FROM jz_sessions;`);
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
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(resolvedPath);
    _defaultStore = new JoyZoningStore(db);
    log.info(`Joy-Zoning audit store opened at ${resolvedPath}`);
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
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(":memory:");
  return new JoyZoningStore(db);
}

/** Reset the default singleton — for testing. */
export function resetDefaultStore(): void {
  _defaultStore = null;
}
