import * as crypto from "node:crypto";
import { Kysely, sql, CompiledQuery } from "kysely";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { executor } from "../../core/executor.js";
import { getDb, type Schema } from "./Config.js";

// Robust Mutex implementation for production
class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  constructor(public name: string) {}

  async acquire(): Promise<() => void> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        next();
      } else {
        this.locked = false;
      }
    };
  }
}

export type DbLayer = "domain" | "infrastructure" | "ui" | "plumbing";

type WhereCondition = {
  column: string;
  value: string | number | string[] | number[] | null;
  operator?: "=" | "<" | ">" | "<=" | ">=" | "!=" | "IN";
};

export type Increment = { _type: "increment"; value: number };

export type WriteOp = {
  type: "insert" | "update" | "delete" | "upsert";
  table: keyof Schema;
  values?: Record<string, any | Increment>;
  where?: WhereCondition | WhereCondition[];
  agentId?: string;
  layer?: DbLayer;
};

const LAYER_PRIORITY: Record<DbLayer, number> = {
  domain: 0,
  infrastructure: 1,
  ui: 2,
  plumbing: 3,
};

const MAX_BUFFER_SIZE = 1000;
const MAX_AGENT_SHADOW_OPS = 500;

function normalizeWhere(where: WhereCondition | WhereCondition[] | undefined): WhereCondition[] {
  if (!where) return [];
  return Array.isArray(where) ? where : [where];
}

export class BufferedDbPool {
  private globalBuffer: WriteOp[] = [];
  private inFlightOps: WriteOp[] = [];
  private agentShadows = new Map<string, { ops: WriteOp[]; affectedFiles: Set<string> }>();
  private stateMutex = new Mutex("DbStateMutex");
  private flushMutex = new Mutex("DbFlushMutex");
  private flushInterval: NodeJS.Timeout | null = null;
  private db: Kysely<Schema> | null = null;
  private logger: PluginLogger | null = null;

  constructor() {
    this.startFlushLoop();
  }

  public setLogger(logger: PluginLogger) {
    this.logger = logger;
  }

  private log(level: keyof PluginLogger, msg: string) {
    if (this.logger) {
      const logFn = this.logger[level];
      if (typeof logFn === "function") {
        logFn(`[DbPool] ${msg}`);
      }
    } else if (level === "error" || level === "warn") {
      console[level](`[DbPool] ${msg}`);
    }
  }

  private async ensureDb(): Promise<Kysely<Schema>> {
    if (!this.db) {
      this.db = await getDb();
      this.log("info", "Database connection initialized");
    }
    return this.db;
  }

  private startFlushLoop() {
    if (this.flushInterval) return;
    this.flushInterval = setInterval(() => this.flush(), 100);
  }

  public async beginWork(agentId: string) {
    const release = await this.stateMutex.acquire();
    try {
      if (!this.agentShadows.has(agentId)) {
        this.agentShadows.set(agentId, { ops: [], affectedFiles: new Set() });
      }
    } finally {
      release();
    }
  }

  public async push(op: WriteOp, agentId?: string, affectedFile?: string) {
    let shouldFlush = false;
    const release = await this.stateMutex.acquire();
    try {
      if (agentId) {
        let shadow = this.agentShadows.get(agentId);
        if (!shadow) {
          shadow = { ops: [], affectedFiles: new Set() };
          this.agentShadows.set(agentId, shadow);
        }

        if (shadow.ops.length >= MAX_AGENT_SHADOW_OPS) {
          this.log(
            "warn",
            `Agent ${agentId} reached max shadow ops (${MAX_AGENT_SHADOW_OPS}). Committing current shadow to global buffer.`,
          );
          this.globalBuffer.push(...shadow.ops);
          shadow.ops = [];
        }

        shadow.ops.push({ ...op, agentId });
        if (affectedFile) shadow.affectedFiles.add(affectedFile);
      } else {
        if (this.globalBuffer.length >= MAX_BUFFER_SIZE) {
          this.log(
            "error",
            `Global buffer full (${MAX_BUFFER_SIZE}). Dropping oldest op to make room.`,
          );
          this.globalBuffer.shift();
        }
        this.globalBuffer.push(op);
      }
      shouldFlush = this.globalBuffer.length > 50;
    } finally {
      release();
    }

    if (shouldFlush) {
      this.flush().catch((e) => this.log("error", `Auto-flush error: ${e}`));
    }
  }

  public async commitWork(agentId: string) {
    const release = await this.stateMutex.acquire();
    let shadow: { ops: WriteOp[]; affectedFiles: Set<string> } | undefined;
    try {
      shadow = this.agentShadows.get(agentId);
      if (!shadow || shadow.ops.length === 0) return;
      this.agentShadows.delete(agentId);
    } finally {
      release();
    }

    if (!shadow) return;

    const releaseForPush = await this.stateMutex.acquire();
    try {
      this.globalBuffer.push(...shadow.ops);
      if (this.globalBuffer.length > MAX_BUFFER_SIZE) {
        this.globalBuffer = this.globalBuffer.slice(-MAX_BUFFER_SIZE);
      }
    } finally {
      releaseForPush();
    }
    await this.flush();
  }

  public async rollbackWork(agentId: string) {
    const release = await this.stateMutex.acquire();
    try {
      this.agentShadows.delete(agentId);
    } finally {
      release();
    }
  }

  /**
   * Performs database maintenance including ANALYZE and incremental vacuum.
   */
  public async runMaintenance(): Promise<void> {
    await executor.execute("maintenance", async () => {
      this.log("info", "Running SQLite maintenance (PRAGMA optimize, incremental_vacuum)...");

      const db = await this.ensureDb();
      // ANALYZE gathers statistics about tables and indices for the query planner
      await db.executeQuery(CompiledQuery.raw("PRAGMA optimize"));

      // Incremental vacuum (if auto_vacuum = INCREMENTAL)
      await db.executeQuery(CompiledQuery.raw("PRAGMA incremental_vacuum(100)"));

      this.log("info", "SQLite maintenance completed.");
    });
  }

  public async runTransaction<T>(callback: (agentId: string) => Promise<T>): Promise<T> {
    const agentId = `trx-${crypto.randomUUID()}`;
    await this.beginWork(agentId);
    try {
      const result = await callback(agentId);
      await this.commitWork(agentId);
      return result;
    } catch (e) {
      await this.rollbackWork(agentId);
      throw e;
    }
  }

  public async flush() {
    const releaseFlush = await this.flushMutex.acquire();
    let flushReleased = false;
    let opsToFlush: WriteOp[] = [];
    try {
      const releaseState = await this.stateMutex.acquire();
      try {
        if (this.globalBuffer.length === 0) {
          releaseFlush();
          flushReleased = true;
          return;
        }
        opsToFlush = [...this.globalBuffer].sort((a, b) => {
          const pA = LAYER_PRIORITY[a.layer || "plumbing"];
          const pB = LAYER_PRIORITY[b.layer || "plumbing"];
          return pA - pB;
        });
        this.globalBuffer = [];
        this.inFlightOps = opsToFlush;
      } finally {
        releaseState();
      }

      this.log("debug", `Flushing ${opsToFlush.length} operations`);
      const db = await this.ensureDb();

      await db.transaction().execute(async (trx: any) => {
        for (const op of opsToFlush) {
          const conditions = normalizeWhere(op.where);
          if (op.type === "insert" && op.values) {
            await trx
              .insertInto(op.table as any)
              .values(op.values as any)
              .execute();
          } else if (op.type === "upsert" && op.values) {
            const valuesWithNoIncrements: any = {};
            const increments: Record<string, number> = {};
            for (const [k, v] of Object.entries(op.values)) {
              if (v && typeof v === "object" && (v as any)._type === "increment") {
                increments[k] = (v as any).value;
              } else {
                valuesWithNoIncrements[k] = v;
              }
            }

            let query = trx
              .insertInto(op.table as any)
              .values(valuesWithNoIncrements as any)
              .onConflict((oc: any) => {
                const conflictTarget =
                  conditions.length > 0 ? conditions.map((c) => c.column) : ["id"];

                let updateSet: any = { ...valuesWithNoIncrements };
                for (const [k, v] of Object.entries(increments)) {
                  updateSet[k] = sql`${sql.ref(k)} + ${v}`;
                }
                return oc.columns(conflictTarget).doUpdateSet(updateSet);
              });
            await query.execute();
          } else if (op.type === "update" && op.values) {
            let query = trx.updateTable(op.table as any);
            const sets: any = {};
            for (const [k, v] of Object.entries(op.values)) {
              if (v && typeof v === "object" && (v as any)._type === "increment") {
                sets[k] = sql`${sql.ref(k)} + ${v.value}`;
              } else {
                sets[k] = v;
              }
            }
            query = query.set(sets);
            for (const cond of conditions) {
              query = query.where(cond.column as any, "=", cond.value as any);
            }
            await query.execute();
          } else if (op.type === "delete") {
            let query = trx.deleteFrom(op.table as any);
            for (const cond of conditions) {
              const opStr = cond.operator || "=";
              query = query.where(cond.column as any, opStr as any, cond.value as any);
            }
            await query.execute();
          }
        }
      });

      const releaseStateClear = await this.stateMutex.acquire();
      try {
        this.inFlightOps = [];
      } finally {
        releaseStateClear();
      }
    } catch (e) {
      this.log("error", `Flush failed, restoring ops to buffer: ${e}`);
      const releaseState = await this.stateMutex.acquire();
      try {
        this.globalBuffer.unshift(...opsToFlush);
        this.inFlightOps = [];
      } finally {
        releaseState();
      }
    } finally {
      if (!flushReleased) {
        releaseFlush();
      }
    }
  }

  public async selectWhere<T extends keyof Schema>(
    table: T,
    where: WhereCondition | WhereCondition[],
    agentId?: string,
    options?: {
      orderBy?: { column: keyof Schema[T]; direction: "asc" | "desc" };
      limit?: number;
    },
  ): Promise<Schema[T][]> {
    const release = await this.stateMutex.acquire();
    try {
      const db = await this.ensureDb();
      const conditions = normalizeWhere(where);

      let query = db.selectFrom(table as any).selectAll();
      for (const cond of conditions) {
        const opStr = cond.operator || "=";
        if (Array.isArray(cond.value)) {
          query = query.where(cond.column as any, "in", cond.value as any);
        } else {
          query = query.where(cond.column as any, opStr as any, cond.value as any);
        }
      }

      if (options?.orderBy) {
        query = query.orderBy(options.orderBy.column as any, options.orderBy.direction);
      }
      if (options?.limit) {
        query = query.limit(options.limit);
      }

      const diskResults = (await query.execute()) as Schema[T][];

      const applyOps = (ops: WriteOp[], base: Schema[T][]) => {
        let results = [...base];
        for (const op of ops) {
          if (op.table !== table) continue;

          if ((op.type === "insert" || op.type === "upsert") && op.values) {
            const rec = op.values as unknown as Schema[T];
            const upsertConds = normalizeWhere(op.where);
            const pkMatch = (r: any) => {
              if (upsertConds.length > 0) {
                return upsertConds.every((c) => r[c.column] === c.value);
              }
              if ((r as any).id && (rec as any).id) return r.id === (rec as any).id;
              return false;
            };
            const existingIdx = results.findIndex(pkMatch);
            if (existingIdx >= 0) {
              results[existingIdx] = { ...results[existingIdx], ...rec };
            } else {
              results.push(rec);
            }
          } else if (op.type === "delete" && op.where) {
            const delConds = normalizeWhere(op.where);
            results = results.filter((r) => {
              const rec = r as Record<string, unknown>;
              return !delConds.every((c) => rec[c.column] === c.value);
            });
          } else if (op.type === "update" && op.where && op.values) {
            const updConds = normalizeWhere(op.where);
            results = results.map((r) => {
              const rec = r as Record<string, unknown>;
              const match = updConds.every((c) => {
                const val = rec[c.column];
                const opStr = c.operator || "=";
                if (opStr === "=") return val === c.value;
                if (opStr === "!=") return val !== c.value;
                if (opStr === ">") return (val as any) > (c.value as any);
                if (opStr === "<") return (val as any) < (c.value as any);
                if (opStr === ">=") return (val as any) >= (c.value as any);
                if (opStr === "<=") return (val as any) <= (c.value as any);
                if (opStr === "IN" && Array.isArray(c.value))
                  return (c.value as any[]).includes(val as any);
                return false;
              });
              if (match) {
                return { ...r, ...op.values } as unknown as Schema[T];
              }
              return r;
            });
          }
        }
        return results;
      };

      let finalResults = applyOps(this.inFlightOps, diskResults);
      finalResults = applyOps(this.globalBuffer, finalResults);
      if (agentId) {
        const shadow = this.agentShadows.get(agentId);
        if (shadow) {
          finalResults = applyOps(shadow.ops, finalResults);
        }
      }

      if (options?.orderBy) {
        const col = options.orderBy.column as string;
        const dir = options.orderBy.direction;
        finalResults.sort((a: any, b: any) => {
          if (a[col] < b[col]) return dir === "asc" ? -1 : 1;
          if (a[col] > b[col]) return dir === "asc" ? 1 : -1;
          return 0;
        });
      }
      if (options?.limit) {
        finalResults = finalResults.slice(0, options.limit);
      }

      return finalResults;
    } finally {
      release();
    }
  }

  public async selectOne<T extends keyof Schema>(
    table: T,
    where: WhereCondition | WhereCondition[],
    agentId?: string,
  ): Promise<Schema[T] | null> {
    const results = await this.selectWhere(table, where, agentId);
    return results.length > 0 ? (results[results.length - 1] as Schema[T]) : null;
  }

  public static increment(value: number): Increment {
    return { _type: "increment", value };
  }

  public async stop() {
    this.log("info", "Stopping Database Pool");
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();
    if (this.db) {
      await this.db.destroy();
      this.db = null;
    }
  }
}

export const dbPool = new BufferedDbPool();
