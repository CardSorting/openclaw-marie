import { randomUUID } from "node:crypto";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { SqliteConnectionPool, getGlobalSqlitePool } from "../memory/sqlite-pool.js";
import { type DatabaseSync } from "../memory/sqlite.js";

const log = createSubsystemLogger("agents/strategic-evolution-store");

type StatementSync = ReturnType<DatabaseSync["prepare"]>;

export type MetricType = "sentiment" | "discovery" | "surprise" | "latency" | "success_rate";

export interface StoredMetric {
  id: string;
  sessionKey: string;
  type: MetricType;
  value: number;
  metadata: string | null;
  createdAt: number;
}

export interface RecallHit {
  sessionKey: string;
  lineHash: string;
  hitCount: number;
  lastRecallTs: number;
}

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS sev_metrics (
  id TEXT PRIMARY KEY,
  sessionKey TEXT NOT NULL,
  type TEXT NOT NULL,
  value REAL NOT NULL,
  metadata TEXT,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sev_recall_hits (
  sessionKey TEXT NOT NULL,
  lineHash TEXT NOT NULL,
  hitCount INTEGER NOT NULL DEFAULT 0,
  lastRecallTs INTEGER NOT NULL,
  PRIMARY KEY (sessionKey, lineHash)
);

CREATE TABLE IF NOT EXISTS sev_session_state (
  sessionKey TEXT NOT NULL,
  stateKey TEXT NOT NULL,
  stateValue TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (sessionKey, stateKey)
);

CREATE INDEX IF NOT EXISTS idx_metrics_session ON sev_metrics(sessionKey);
CREATE INDEX IF NOT EXISTS idx_metrics_type ON sev_metrics(type);
CREATE INDEX IF NOT EXISTS idx_metrics_created ON sev_metrics(createdAt);
CREATE INDEX IF NOT EXISTS idx_recall_session ON sev_recall_hits(sessionKey);
CREATE INDEX IF NOT EXISTS idx_recall_ts ON sev_recall_hits(lastRecallTs);
CREATE INDEX IF NOT EXISTS idx_session_state ON sev_session_state(sessionKey);
CREATE TABLE IF NOT EXISTS sev_bash_history (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  scopeKey TEXT,
  sessionKey TEXT,
  startedAt INTEGER NOT NULL,
  endedAt INTEGER NOT NULL,
  cwd TEXT,
  status TEXT NOT NULL,
  exitCode INTEGER,
  exitSignal TEXT,
  aggregated TEXT,
  tail TEXT,
  truncated INTEGER NOT NULL,
  totalOutputChars INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bash_history_session ON sev_bash_history(sessionKey);
CREATE INDEX IF NOT EXISTS idx_bash_history_ended ON sev_bash_history(endedAt);
`;

export class StrategicEvolutionStore {
  private pool: SqliteConnectionPool;
  private stmtCache = new Map<string, StatementSync>();

  private constructor(pool: SqliteConnectionPool) {
    this.pool = pool;
  }

  public static async create(pool: SqliteConnectionPool): Promise<StrategicEvolutionStore> {
    const store = new StrategicEvolutionStore(pool);
    await store.initialize();
    return store;
  }

  private async initialize(): Promise<void> {
    await this.pool.initialize();
    await this.pool.withWriteLock((db) => {
      db.exec(SCHEMA_SQL);
    });
  }

  private prepare(db: DatabaseSync, sql: string): StatementSync {
    // Statement caching is still database-specific if using multiple connections.
    // However, since we use a shared pool and node:sqlite is synchronous,
    // we can either cache per-connection or just prepare fresh.
    // For simplicity with the pool, we'll prepare fresh for now or implement a better cache.
    return db.prepare(sql);
  }

  public async recordMetric(params: {
    sessionKey: string;
    type: MetricType;
    value: number;
    metadata?: unknown;
  }): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    const metadataStr = params.metadata ? JSON.stringify(params.metadata) : null;

    await this.pool.withWriteLock((db) => {
      this.prepare(
        db,
        `INSERT INTO sev_metrics (id, sessionKey, type, value, metadata, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, params.sessionKey, params.type, params.value, metadataStr, now);
    });

    return id;
  }

  public async recordRecallHit(sessionKey: string, lineHash: string): Promise<void> {
    const now = Date.now();
    await this.pool.withWriteLock((db) => {
      this.prepare(
        db,
        `INSERT INTO sev_recall_hits (sessionKey, lineHash, hitCount, lastRecallTs)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(sessionKey, lineHash) DO UPDATE SET
         hitCount = hitCount + 1,
         lastRecallTs = ?`,
      ).run(sessionKey, lineHash, now, now);
    });
  }

  public getRecallHits(sessionKey: string, lineHash: string): number {
    const db = this.pool.acquireRead();
    const row = this.prepare(
      db,
      `SELECT hitCount FROM sev_recall_hits WHERE sessionKey = ? AND lineHash = ?`,
    ).get(sessionKey, lineHash) as { hitCount: number } | undefined;
    return row?.hitCount ?? 0;
  }

  public getRecentMetrics(params: {
    sessionKey: string;
    type?: MetricType;
    limit?: number;
  }): StoredMetric[] {
    let sql = `SELECT * FROM sev_metrics WHERE sessionKey = ?`;
    const args: (string | number)[] = [params.sessionKey];

    if (params.type) {
      sql += ` AND type = ?`;
      args.push(params.type);
    }

    sql += ` ORDER BY createdAt DESC LIMIT ?`;
    args.push(params.limit ?? 50);

    const db = this.pool.acquireRead();
    return this.prepare(db, sql).all(...args) as unknown as StoredMetric[];
  }

  public getStats(params: { sessionKey?: string; type: MetricType }): {
    mean: number;
    stdDev: number;
    count: number;
  } {
    const db = this.pool.acquireRead();
    let sql = `SELECT value FROM sev_metrics WHERE type = ?`;
    const args: (string | number | null)[] = [params.type];

    if (params.sessionKey) {
      sql += ` AND sessionKey = ?`;
      args.push(params.sessionKey);
    }

    sql += ` ORDER BY createdAt DESC LIMIT 100`;
    const rows = this.prepare(db, sql).all(...args) as { value: number }[];

    if (rows.length === 0) {
      return { mean: 0, stdDev: 0, count: 0 };
    }

    const values = rows.map((r) => r.value);
    const count = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / count;
    const sqDiffs = values.map((v) => Math.pow(v - mean, 2));
    const stdDev = Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / count);

    return { mean, stdDev, count };
  }

  public async setSessionState(sessionKey: string, key: string, value: unknown): Promise<void> {
    const now = Date.now();
    const valStr = typeof value === "string" ? value : JSON.stringify(value);
    await this.pool.withWriteLock((db) => {
      this.prepare(
        db,
        `INSERT INTO sev_session_state (sessionKey, stateKey, stateValue, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(sessionKey, stateKey) DO UPDATE SET
         stateValue = excluded.stateValue,
         updatedAt = excluded.updatedAt`,
      ).run(sessionKey, key, valStr, now);
    });
  }

  public getSessionState<T = unknown>(sessionKey: string, key: string): T | null {
    const db = this.pool.acquireRead();
    const row = this.prepare(
      db,
      `SELECT stateValue FROM sev_session_state WHERE sessionKey = ? AND stateKey = ?`,
    ).get(sessionKey, key);

    if (!row) {
      return null;
    }
    const val = (row as Record<string, unknown>).stateValue;
    if (typeof val !== "string") {
      return val as T;
    }
    try {
      return JSON.parse(val) as T;
    } catch {
      return val as unknown as T;
    }
  }

  /**
   * Acquires a persistent lock for a session/resource with a TTL.
   * Returns true if lock was acquired, false if already held and not expired.
   */
  public async acquireLock(sessionKey: string, resource: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const lockKey = `lock:${resource}`;
    const existing = this.getSessionState<{ expiresAt: number }>(sessionKey, lockKey);

    if (existing && existing.expiresAt > now) {
      return false;
    }

    await this.setSessionState(sessionKey, lockKey, { expiresAt: now + ttlMs });
    return true;
  }

  /**
   * Checks if a persistent lock is currently held and valid.
   */
  public isLockHeld(sessionKey: string, resource: string): boolean {
    const now = Date.now();
    const lockKey = `lock:${resource}`;
    const existing = this.getSessionState<{ expiresAt: number }>(sessionKey, lockKey);
    return !!(existing && existing.expiresAt > now);
  }

  public async saveBashHistory(session: PersistentBashSession): Promise<void> {
    await this.pool.withWriteLock((db) => {
      this.prepare(
        db,
        `INSERT OR REPLACE INTO sev_bash_history (
          id, command, scopeKey, sessionKey, startedAt, endedAt, cwd, status, exitCode, exitSignal, aggregated, tail, truncated, totalOutputChars
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        session.id,
        session.command,
        session.scopeKey ?? null,
        session.sessionKey ?? null,
        session.startedAt,
        session.endedAt,
        session.cwd ?? null,
        session.status,
        session.exitCode ?? null,
        session.exitSignal !== undefined ? String(session.exitSignal) : null,
        session.aggregated,
        session.tail,
        session.truncated ? 1 : 0,
        session.totalOutputChars,
      );
    });
  }

  public getBashHistory(limit = 100): PersistentBashSession[] {
    const db = this.pool.acquireRead();
    const rows = this.prepare(
      db,
      `SELECT * FROM sev_bash_history ORDER BY endedAt DESC LIMIT ?`,
    ).all(limit);

    return (rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      command: String(row.command),
      scopeKey: row.scopeKey as string | undefined,
      sessionKey: row.sessionKey as string | undefined,
      startedAt: Number(row.startedAt),
      endedAt: Number(row.endedAt),
      cwd: row.cwd as string | undefined,
      status: String(row.status),
      exitCode: row.exitCode as number | undefined,
      exitSignal: row.exitSignal as string | number | undefined,
      aggregated: String(row.aggregated),
      tail: String(row.tail),
      truncated: Boolean(row.truncated),
      totalOutputChars: Number(row.totalOutputChars),
    }));
  }

  public async pruneBashHistory(olderThanMs: number): Promise<void> {
    const cutoff = Date.now() - olderThanMs;
    await this.pool.withWriteLock((db) => {
      this.prepare(db, `DELETE FROM sev_bash_history WHERE endedAt < ?`).run(cutoff);
    });
  }

  /**
   * Performs autonomous maintenance on the store.
   */
  public async maintenance(): Promise<void> {
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000; // 30 days
    await this.pool.withWriteLock((db) => {
      // 1. Prune ancient metrics
      db.prepare(`DELETE FROM sev_metrics WHERE createdAt < ?`).run(cutoff);
      // 2. Prune session state
      db.prepare(`DELETE FROM sev_session_state WHERE updatedAt < ?`).run(cutoff);
      // 3. Vacuum
      db.exec("VACUUM;");
    });
    log.info("Strategic Evolution store maintenance completed (Pruned & Vacuumed).");
  }
}

let _defaultStore: StrategicEvolutionStore | null = null;

export async function getStrategicEvolutionStore(
  dbPath?: string,
): Promise<StrategicEvolutionStore> {
  if (_defaultStore) {
    return _defaultStore;
  }

  const resolvedPath =
    dbPath ??
    path.join(
      process.env.OPENCLAW_STATE_DIR ?? path.join(process.env.HOME ?? "/tmp", ".openclaw"),
      "evolution",
      "strategic.sqlite",
    );

  try {
    const pool = getGlobalSqlitePool(resolvedPath);
    _defaultStore = await StrategicEvolutionStore.create(pool);
    log.info(`Strategic Evolution store opened via pool at ${resolvedPath}`);
    return _defaultStore;
  } catch (err) {
    log.warn(
      `Failed to open Strategic Evolution store: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export function resetStrategicEvolutionStoreForTest(): void {
  const store = _defaultStore;
  if (store) {
    _defaultStore = null;
  }
}

export interface PersistentBashSession {
  id: string;
  command: string;
  scopeKey?: string;
  sessionKey?: string;
  startedAt: number;
  endedAt: number;
  cwd?: string;
  status: string;
  exitCode?: number | null;
  exitSignal?: string | number | null;
  aggregated: string;
  tail: string;
  truncated: boolean;
  totalOutputChars: number;
}
