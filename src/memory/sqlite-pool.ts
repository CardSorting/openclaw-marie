import { requireNodeSqlite } from "./sqlite.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

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
  private readonly connections: any[] = [];
  private readonly writeMutex = new WriteMutex();
  private initialized = false;

  constructor(config: SqlitePoolConfig) {
    this.config = {
      poolSize: 1,
      busyTimeout: 5000,
      ...config,
    };
  }

  private initPromise: Promise<void> | null = null;

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const sqlite = requireNodeSqlite();
      const poolSize = Math.max(1, this.config.poolSize || 1);

      this.connections.length = 0;

      for (let i = 0; i < poolSize; i++) {
        try {
          const db = new sqlite.DatabaseSync(this.config.dbPath);
          this.setupConnection(db);
          this.connections.push(db);
        } catch (err) {
          log.error(`Failed to open SQLite database at ${this.config.dbPath}: ${err instanceof Error ? err.message : String(err)}`);
          this.initPromise = null;
          throw err;
        }
      }

      if (this.connections.length === 0) {
        this.initPromise = null;
        throw new Error(`Failed to initialize SQLite pool: no connections established for ${this.config.dbPath}`);
      }

      this.initialized = true;
      log.info(`Initialized SQLite pool at ${this.config.dbPath} with ${this.connections.length} connections.`);
    })();

    return this.initPromise;
  }

  private setupConnection(db: any): void {
    db.exec(`PRAGMA journal_mode = WAL;`);
    db.exec(`PRAGMA synchronous = NORMAL;`);
    db.exec(`PRAGMA busy_timeout = ${this.config.busyTimeout};`);
    db.exec(`PRAGMA foreign_keys = ON;`);
    db.exec(`PRAGMA temp_store = MEMORY;`);
  }

  /**
   * Acquire a connection for a read operation.
   * In a synchronous pool, this just returns an available connection.
   */
  public acquireRead(): any {
    if (!this.initialized) {
      // Synchronous acquireRead cannot await initialization.
      // Callers should ensure the pool is initialized before calling this,
      // or we should make this async. For now, throw if not ready.
      throw new Error(`SqliteConnectionPool not initialized. Path: ${this.config.dbPath}`);
    }
    // For now, just rotate through connections (simple round-robin)
    const conn = this.connections.shift();
    this.connections.push(conn);
    return conn;
  }

  /**
   * Execute a write operation protected by the WriteMutex.
   */
  public async withWriteLock<T>(op: (db: any) => T): Promise<T> {
    if (!this.initialized) await this.initialize();
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
  public async transaction<T>(op: (db: any) => T): Promise<T> {
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
  }
}

class WriteMutex {
  private promise?: Promise<void>;
  private resolve?: () => void;

  async lock(): Promise<void> {
    while (this.promise) {
      await this.promise;
    }
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  unlock(): void {
    const resolve = this.resolve;
    this.promise = undefined;
    this.resolve = undefined;
    resolve?.();
  }
}

// Global pool registry to ensure multiple stores sharing the same file use the SAME pool.
const globalPools = new Map<string, SqliteConnectionPool>();

export function getGlobalSqlitePool(dbPath: string): SqliteConnectionPool {
  let pool = globalPools.get(dbPath);
  if (!pool) {
    pool = new SqliteConnectionPool({ dbPath });
    globalPools.set(dbPath, pool);
  }
  return pool;
}
