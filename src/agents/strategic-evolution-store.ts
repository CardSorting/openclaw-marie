import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

const log = createSubsystemLogger("agents/strategic-evolution-store");

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
  private db: DatabaseSync;
  private stmtCache = new Map<string, any>();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(SCHEMA_SQL);
  }

  private prepare(sql: string): any {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  public recordMetric(params: {
    sessionKey: string;
    type: MetricType;
    value: number;
    metadata?: any;
  }): string {
    const id = randomUUID();
    const now = Date.now();
    const metadataStr = params.metadata ? JSON.stringify(params.metadata) : null;

    this.prepare(
      `INSERT INTO sev_metrics (id, sessionKey, type, value, metadata, createdAt) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, params.sessionKey, params.type, params.value, metadataStr, now);

    return id;
  }

  public recordRecallHit(sessionKey: string, lineHash: string): void {
    const now = Date.now();
    this.prepare(
      `INSERT INTO sev_recall_hits (sessionKey, lineHash, hitCount, lastRecallTs)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(sessionKey, lineHash) DO UPDATE SET
       hitCount = hitCount + 1,
       lastRecallTs = ?`
    ).run(sessionKey, lineHash, now, now);
  }

  public getRecallHits(sessionKey: string, lineHash: string): number {
    const row = this.prepare(
        `SELECT hitCount FROM sev_recall_hits WHERE sessionKey = ? AND lineHash = ?`
    ).get(sessionKey, lineHash) as { hitCount: number } | undefined;
    return row?.hitCount ?? 0;
  }

  public getRecentMetrics(params: {
    sessionKey: string;
    type?: MetricType;
    limit?: number;
  }): StoredMetric[] {
    let sql = `SELECT * FROM sev_metrics WHERE sessionKey = ?`;
    const args: any[] = [params.sessionKey];

    if (params.type) {
      sql += ` AND type = ?`;
      args.push(params.type);
    }

    sql += ` ORDER BY createdAt DESC LIMIT ?`;
    args.push(params.limit ?? 50);

    return this.prepare(sql).all(...args) as StoredMetric[];
  }

  public getStats(params: { sessionKey: string; type: MetricType }): { mean: number; stdDev: number; count: number } {
    const rows = this.prepare(
      `SELECT value FROM sev_metrics WHERE sessionKey = ? AND type = ? ORDER BY createdAt DESC LIMIT 100`
    ).all(params.sessionKey, params.type) as { value: number }[];

    if (rows.length === 0) return { mean: 0, stdDev: 0, count: 0 };

    const values = rows.map(r => r.value);
    const count = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / count;
    const sqDiffs = values.map(v => Math.pow(v - mean, 2));
    const stdDev = Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / count);

    return { mean, stdDev, count };
  }

  public setSessionState(sessionKey: string, key: string, value: any): void {
    const now = Date.now();
    const valStr = typeof value === "string" ? value : JSON.stringify(value);
    this.prepare(
      `INSERT INTO sev_session_state (sessionKey, stateKey, stateValue, updatedAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(sessionKey, stateKey) DO UPDATE SET
       stateValue = excluded.stateValue,
       updatedAt = excluded.updatedAt`
    ).run(sessionKey, key, valStr, now);
  }

  public getSessionState<T = any>(sessionKey: string, key: string): T | null {
    const row = this.prepare(
      `SELECT stateValue FROM sev_session_state WHERE sessionKey = ? AND stateKey = ?`
    ).get(sessionKey, key);

    if (!row) return null;
    const val = (row as any).stateValue;
    try {
      return JSON.parse(val) as T;
    } catch {
      return val as unknown as T;
    }
  }

  public saveBashHistory(session: PersistentBashSession): void {
    this.prepare(
      `INSERT OR REPLACE INTO sev_bash_history (
        id, command, scopeKey, sessionKey, startedAt, endedAt, cwd, status, exitCode, exitSignal, aggregated, tail, truncated, totalOutputChars
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      session.totalOutputChars
    );
  }

  public getBashHistory(limit = 100): PersistentBashSession[] {
    const rows = this.prepare(
      `SELECT * FROM sev_bash_history ORDER BY endedAt DESC LIMIT ?`
    ).all(limit);

    return (rows as any[]).map((row) => ({
      id: row.id,
      command: row.command,
      scopeKey: row.scopeKey,
      sessionKey: row.sessionKey,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      cwd: row.cwd,
      status: row.status,
      exitCode: row.exitCode,
      exitSignal: row.exitSignal,
      aggregated: row.aggregated,
      tail: row.tail,
      truncated: Boolean(row.truncated),
      totalOutputChars: row.totalOutputChars,
    }));
  }

  public pruneBashHistory(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    this.prepare(`DELETE FROM sev_bash_history WHERE endedAt < ?`).run(cutoff);
  }
}

let _defaultStore: StrategicEvolutionStore | null = null;

export function getStrategicEvolutionStore(dbPath?: string): StrategicEvolutionStore {
  if (_defaultStore) return _defaultStore;

  const resolvedPath =
    dbPath ??
    path.join(
      process.env.OPENCLAW_STATE_DIR ?? path.join(process.env.HOME ?? "/tmp", ".openclaw"),
      "evolution",
      "strategic.sqlite"
    );

  try {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(resolvedPath);
    _defaultStore = new StrategicEvolutionStore(db);
    log.info(`Strategic Evolution store opened at ${resolvedPath}`);
    return _defaultStore;
  } catch (err) {
    log.warn(
      `Failed to open Strategic Evolution store: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export function resetStrategicEvolutionStoreForTest(): void {
  const store = _defaultStore as any;
  if (store) {
    try {
      store.db?.close?.();
    } catch {}
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
