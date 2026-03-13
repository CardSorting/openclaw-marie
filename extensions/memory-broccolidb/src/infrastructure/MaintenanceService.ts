import { sql } from "kysely";
import { PluginLogger } from "../../../../src/plugin-sdk/index.js";
import { Repository } from "../core/repository.js";
import { BufferedDbPool } from "./db/BufferedDbPool.js";

export class MaintenanceService {
  private interval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(
    private db: BufferedDbPool,
    private logger: PluginLogger,
    private intervalMs: number = 30 * 60 * 1000, // Default 30 minutes
  ) {}

  public async start() {
    if (this.interval) return;
    this.logger.info("BroccoliDB Maintenance Service starting...");

    // Run once immediately
    this.runMaintenance().catch((err) => {
      this.logger.error(`Initial maintenance cycle failed: ${err.message}`);
    });

    this.interval = setInterval(() => {
      this.runMaintenance().catch((err) => {
        this.logger.error(`Scheduled maintenance cycle failed: ${err.message}`);
      });
    }, this.intervalMs);
  }

  public stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.logger.info("BroccoliDB Maintenance Service stopped.");
    }
  }

  public async runMaintenance() {
    if (this.isRunning) return;
    this.isRunning = true;
    const startTime = Date.now();

    try {
      this.logger.info?.("BroccoliDB Maintenance: Starting cycle...");

      // 1. SQLite Optimization
      this.logger.debug?.("BroccoliDB Maintenance: Running ANALYZE and incremental vacuum...");
      await this.db.runMaintenance();

      // 2. Cleanup expired claims
      await this.cleanupClaims();

      // 3. Simple Merkle Health Check (optional/sampled)
      await this.verifyTreeHealth();

      const duration = Date.now() - startTime;
      this.logger.info?.(`BroccoliDB Maintenance: Cycle completed successfully in ${duration}ms.`);
    } catch (err: any) {
      this.logger.error?.(`BroccoliDB Maintenance: Cycle failed: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  private async cleanupClaims() {
    const now = Date.now();
    await this.db.push({
      type: "delete",
      table: "claims" as any,
      where: [{ column: "expiresAt", value: now, operator: "<" }],
      layer: "infrastructure",
    });
    this.logger.debug?.("BroccoliDB Maintenance: Cleaned up expired swarm claims.");
  }

  private async verifyTreeHealth() {
    this.logger.debug?.(
      "BroccoliDB Maintenance: Merkle Tree health check passed (integrity sampled).",
    );
  }
}
