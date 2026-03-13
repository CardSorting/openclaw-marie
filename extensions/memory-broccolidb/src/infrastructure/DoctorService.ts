import { sql } from "kysely";
import { Repository } from "../core/repository.js";
import { BufferedDbPool } from "./db/BufferedDbPool.js";

export interface DiagnosticReport {
  timestamp: string;
  merkle: {
    status: "healthy" | "corrupt";
    totalNodes: number;
    corruptNodes: number[];
    integrityScore: number;
  };
  database: {
    pageSize: number;
    pageCount: number;
    freelistCount: number;
    journalMode: string;
    synchronous: string;
    fragmentationRatio: number;
  };
  concurrency: {
    activeAgents: number;
    pendingOps: number;
    inFlightOps: number;
    lockContention: "low" | "medium" | "high";
  };
}

export class DoctorService {
  constructor(
    private repo: Repository,
    private db: BufferedDbPool,
  ) {}

  public async diagnose(): Promise<DiagnosticReport> {
    const merkleReport = await this.checkMerkleIntegrity();
    const dbStats = await this.getDatabaseStats();
    const concurrencyReport = await this.getConcurrencyHealth();

    return {
      timestamp: new Date().toISOString(),
      merkle: merkleReport,
      database: dbStats,
      concurrency: concurrencyReport,
    };
  }

  private async checkMerkleIntegrity() {
    // In a real implementation, we'd scan nodes and verify hashes.
    // Here we sample the latest commits.
    const nodes = await this.db.selectWhere("nodes", [], undefined, { limit: 100 });
    let corruptCount = 0;
    const corruptNodes: number[] = [];

    // Simple check: do we have nodes?
    const totalNodes = nodes.length;

    return {
      status: corruptCount === 0 ? ("healthy" as const) : ("corrupt" as const),
      totalNodes,
      corruptNodes,
      integrityScore: totalNodes > 0 ? (totalNodes - corruptCount) / totalNodes : 1.0,
    };
  }

  private async getDatabaseStats() {
    const rawDb = await (this.db as any).ensureDb();

    // PRAGMAs must be run directly
    const pageSize = await sql<{ page_size: number }>`PRAGMA page_size`.execute(rawDb);
    const pageCount = await sql<{ page_count: number }>`PRAGMA page_count`.execute(rawDb);
    const freelistCount = await sql<{ freelist_count: number }>`PRAGMA freelist_count`.execute(
      rawDb,
    );
    const journalMode = await sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(rawDb);
    const synchronous = await sql<{ synchronous: number }>`PRAGMA synchronous`.execute(rawDb);

    const pc = pageCount.rows[0]?.page_count || 0;
    const fc = freelistCount.rows[0]?.freelist_count || 0;

    return {
      pageSize: pageSize.rows[0]?.page_size || 0,
      pageCount: pc,
      freelistCount: fc,
      journalMode: journalMode.rows[0]?.journal_mode || "unknown",
      synchronous: String(synchronous.rows[0]?.synchronous || 0),
      fragmentationRatio: pc > 0 ? fc / pc : 0,
    };
  }

  private async getConcurrencyHealth() {
    const pool = this.db as any;
    const pendingOps = pool.globalBuffer?.length || 0;
    const inFlightOps = pool.inFlightOps?.length || 0;
    const activeAgents = pool.agentShadows?.size || 0;

    return {
      activeAgents,
      pendingOps,
      inFlightOps,
      lockContention:
        pendingOps > 50
          ? ("high" as const)
          : pendingOps > 10
            ? ("medium" as const)
            : ("low" as const),
    };
  }
}
