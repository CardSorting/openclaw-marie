import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { SqliteConnectionPool, getGlobalSqlitePool } from "../memory/sqlite-pool.js";

const log = createSubsystemLogger("infra/security-audit-store");

export type SecurityFindingEntry = {
  id: string;
  category: string;
  severity: string;
  description: string;
  matchSnippet: string | null;
  context: string | null;
  timestamp: number;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS security_findings (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  description TEXT NOT NULL,
  matchSnippet TEXT,
  context TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_timestamp ON security_findings(timestamp);
CREATE INDEX IF NOT EXISTS idx_findings_category ON security_findings(category);
`;

export class SecurityAuditStore {
  private pool: SqliteConnectionPool;

  constructor(pool: SqliteConnectionPool) {
    this.pool = pool;
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.pool.withWriteLock((db) => {
      db.exec(SCHEMA_SQL);
    });
  }

  async recordFinding(params: {
    category: string;
    severity: string;
    description: string;
    matchSnippet?: string;
    context?: string;
  }): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    await this.pool.transaction((db) => {
      db.prepare(
        `INSERT INTO security_findings (id, category, severity, description, matchSnippet, context, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        params.category,
        params.severity,
        params.description,
        params.matchSnippet ?? null,
        params.context ?? null,
        now,
      );
    });
    log.info(`Recorded security finding: [${params.category}] ${params.description}`);
    return id;
  }

  getRecentFindings(limit = 50): SecurityFindingEntry[] {
    const db = this.pool.acquireRead();
    return db
      .prepare(`SELECT * FROM security_findings ORDER BY timestamp DESC LIMIT ?`)
      .all(limit) as SecurityFindingEntry[];
  }

  /**
   * Forensic Seal: Encrypts the database at rest using 'age'.
   * This should be called on session end or when the store is closed.
   */
  async seal(): Promise<void> {
    const poolAny = this.pool as unknown as { options?: { dbPath?: string }; dbPath?: string };
    const dbPath = poolAny.options?.dbPath || poolAny.dbPath;
    if (!dbPath || dbPath === ":memory:") {
      return;
    }

    const ageKey = process.env.OPENCLAW_AGE_SECRET_KEY;
    if (!ageKey) {
      log.warn("Forensic seal skipped: OPENCLAW_AGE_SECRET_KEY not set.");
      return;
    }

    log.info(`Forensically sealing audit log at ${dbPath}...`);

    return new Promise((resolve, reject) => {
      const encryptedPath = `${dbPath}.age`;
      const child = spawn("age", [
        "--encrypt",
        "--recipient",
        ageKey,
        "--output",
        encryptedPath,
        dbPath,
      ]);

      child.on("close", (code) => {
        if (code === 0) {
          log.info(`Audit log sealed and encrypted at ${encryptedPath}`);
          resolve();
        } else {
          reject(new Error(`Forensic seal failed with code ${code}`));
        }
      });
    });
  }
}

let _defaultStore: SecurityAuditStore | null = null;

export function getSecurityAuditStore(dbPath?: string): SecurityAuditStore {
  if (_defaultStore) {
    return _defaultStore;
  }

  const resolvedPath =
    dbPath ??
    path.join(
      process.env.OPENCLAW_STATE_DIR ?? path.join(process.env.HOME ?? "/tmp", ".openclaw"),
      "security",
      "audit.sqlite",
    );

  try {
    const pool = getGlobalSqlitePool(resolvedPath);
    _defaultStore = new SecurityAuditStore(pool);
    return _defaultStore;
  } catch (err) {
    log.warn(
      `Failed to open security audit store: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
