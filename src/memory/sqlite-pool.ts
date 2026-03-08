import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { requireNodeSqlite, type DatabaseSync } from "./sqlite.js";

const log = createSubsystemLogger("memory/sqlite-pool");

export interface SqlitePoolConfig {
  dbPath: string;
  poolSize?: number;
  busyTimeout?: number;
}

/**
 * A connection pool for node:sqlite DatabaseSync instances.
 * Provides a WriteMutex to serialize writes and prevent SQLITE_BUSY errors.
 */
export class SqliteConnectionPool {
  private readonly config: SqlitePoolConfig;
  private readonly connections: DatabaseSync[] = [];
  private readonly writeMutex = new WriteMutex();
  private initialized = false;
  private readIndex = 0;

  constructor(config: SqlitePoolConfig) {
    this.config = {
      poolSize: 1,
      busyTimeout: 5000,
      ...config,
    };
  }

  private initPromise: Promise<void> | null = null;

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        const sqlite = requireNodeSqlite();
        const poolSize = Math.max(1, this.config.poolSize || 1);

        // Ensure parent directory exists for non-memory databases
        if (this.config.dbPath !== ":memory:") {
          const dir = path.dirname(this.config.dbPath);
          if (!fs.existsSync(dir)) {
            log.info(`Creating missing database directory: ${dir}`);
            fs.mkdirSync(dir, { recursive: true });
          }
        }

        this.connections.length = 0;

        for (let i = 0; i < poolSize; i++) {
          try {
            const db = new sqlite.DatabaseSync(this.config.dbPath);
            this.setupConnection(db);
            this.connections.push(db);
          } catch (err) {
            log.error(
              `Failed to open SQLite connection ${i} at ${this.config.dbPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
            throw err;
          }
        }

        if (this.connections.length === 0) {
          throw new Error(
            `Failed to initialize SQLite pool: no connections established for ${this.config.dbPath}`,
          );
        }

        this.initialized = true;
        log.info(
          `Initialized SQLite pool at ${this.config.dbPath} with ${this.connections.length} connections.`,
        );
      } catch (err) {
        this.initPromise = null; // Allow retry on failure
        throw err;
      }
    })();

    return this.initPromise;
  }

  private setupConnection(db: DatabaseSync): void {
    db.exec(`PRAGMA journal_mode = WAL;`);
    db.exec(`PRAGMA synchronous = NORMAL;`);
    db.exec(`PRAGMA busy_timeout = ${this.config.busyTimeout};`);
    db.exec(`PRAGMA foreign_keys = ON;`);
    db.exec(`PRAGMA temp_store = MEMORY;`);
  }

  /**
   * Acquire a connection for a read operation.
   * Uses round-robin selection.
   */
  public acquireRead(): DatabaseSync {
    if (!this.initialized) {
      throw new Error(`SqliteConnectionPool not initialized. Path: ${this.config.dbPath}`);
    }

    const conn = this.connections[this.readIndex];
    this.readIndex = (this.readIndex + 1) % this.connections.length;
    return conn;
  }

  /**
   * Execute a write operation protected by the WriteMutex.
   */
  public async withWriteLock<T>(op: (db: DatabaseSync) => T): Promise<T> {
    if (!this.initialized) {
      await this.initialize();
    }
    await this.writeMutex.lock();
    try {
      // Writes always use the first connection ("Master") to minimize fragmentation/lock contention
      return op(this.connections[0]);
    } finally {
      this.writeMutex.unlock();
    }
  }

  /**
   * Execute a transaction protected by the WriteMutex.
   */
  public async transaction<T>(op: (db: DatabaseSync) => T): Promise<T> {
    return this.withWriteLock((db) => {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const result = op(db);
        db.exec("COMMIT;");
        return result;
      } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
      }
    });
  }

  public getStatus() {
    return {
      initialized: this.initialized,
      dbPath: this.config.dbPath,
      poolSize: this.connections.length,
      lockWaiting: this.writeMutex.isLocked(),
    };
  }

  public close(): void {
    for (const db of this.connections) {
      try {
        db.close();
      } catch (err) {
        log.warn(`Error closing connection: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.connections.length = 0;
    this.initialized = false;
    this.initPromise = null;
    this.readIndex = 0;
  }
}

/**
 * A simple queue-based mutex to ensure fairness and prevent thundering herds.
 */
class WriteMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async lock(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  unlock(): void {
    const next = this.queue.shift();
    if (next) {
      // If there's someone waiting, they get the lock immediately.
      // We don't set locked = false here because the lock is passed directly to 'next'.
      next();
    } else {
      this.locked = false;
    }
  }

  isLocked(): boolean {
    return this.locked;
  }
}

// Global pool registry to ensure multiple stores sharing the same file use the SAME pool.
const globalPools = new Map<string, SqliteConnectionPool>();

export function getGlobalSqlitePool(dbPath: string): SqliteConnectionPool {
  const resolvedPath = dbPath === ":memory:" ? dbPath : path.resolve(dbPath);
  let pool = globalPools.get(resolvedPath);
  if (!pool) {
    pool = new SqliteConnectionPool({ dbPath: resolvedPath });
    globalPools.set(resolvedPath, pool);
  }
  return pool;
}
