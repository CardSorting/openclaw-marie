import fs from "node:fs/promises";
import path from "node:path";
import { vectorDimsForModel } from "../../extensions/memory-broccolidb/config.js";
// Import from the workspace package
import { AgentContext } from "../../extensions/memory-broccolidb/src/core/agent-context.js";
import { Connection } from "../../extensions/memory-broccolidb/src/core/connection.js";
import { AiService } from "../../extensions/memory-broccolidb/src/core/embedding.js";
import { Repository } from "../../extensions/memory-broccolidb/src/core/repository.js";
import { Workspace } from "../../extensions/memory-broccolidb/src/core/workspace.js";
import { dbPool } from "../../extensions/memory-broccolidb/src/infrastructure/db/BufferedDbPool.js";
import { MaintenanceService } from "../../extensions/memory-broccolidb/src/infrastructure/MaintenanceService.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedMemoryBackendConfig } from "./backend-config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
} from "./types.js";

const log = createSubsystemLogger("memory:broccolidb");

export class BroccoliDBMemoryManager implements MemorySearchManager {
  private agentContext: AgentContext;
  private repo: Repository;
  private maintenance: MaintenanceService;
  private workspace: Workspace;
  private connection: Connection;
  private aiService: AiService;

  constructor(
    private readonly params: {
      cfg: OpenClawConfig;
      agentId: string;
      resolved: ResolvedMemoryBackendConfig;
    },
  ) {
    const { broccolidb } = params.resolved;
    if (!broccolidb) {
      throw new Error("BroccoliDB config missing");
    }

    const resolvedDbPath = path.resolve(process.cwd(), broccolidb.dbPath || "broccolidb.db");
    const { model, dimensions } = broccolidb.embedding;

    // Hardening: Initialize native logging
    dbPool.setLogger(log);

    this.connection = new Connection({
      dbPath: resolvedDbPath,
    });

    this.workspace = new Workspace(this.connection.getPool(), "OpenClawUser", "default-workspace");

    this.aiService = new AiService({
      model,
      outputDimensionality: dimensions ?? vectorDimsForModel(model),
    });

    this.repo = new Repository(this.connection.getPool(), "openclaw-memories");

    this.agentContext = new AgentContext(this.workspace, 0, this.aiService, log);
    this.repo.agentContext = this.agentContext;

    this.maintenance = new MaintenanceService(this.connection.getPool(), log);
  }

  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
  }): Promise<BroccoliDBMemoryManager> {
    const manager = new BroccoliDBMemoryManager(params);
    void manager.maintenance.start();
    return manager;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const sessionKey = opts?.sessionKey || "default";
    const branch = `session/${sessionKey}`;

    // Ensure branch exists
    await this.repo.createBranch(branch).catch(() => {});

    // Search using agent context for graph-aware RAG
    const results = await this.agentContext.searchKnowledge(
      query,
      [],
      opts?.maxResults || 5,
      undefined,
      {
        augmentWithGraph: true,
      },
    );

    return results.map((r) => ({
      path: `broccolidb://${r.itemId}`,
      startLine: 0,
      endLine: 0,
      score: r.confidence,
      snippet: r.content,
      source: "memory" as const,
      citation: r.metadata?.source as string,
    }));
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    if (params.relPath.startsWith("broccolidb://")) {
      const id = params.relPath.replace("broccolidb://", "");
      const item = await this.agentContext.getKnowledge(id);
      if (item) {
        return { text: item.content, path: params.relPath };
      }
      throw new Error(`BroccoliDB memory item not found: ${id}`);
    }

    // Fallback to real filesystem if it's a real path
    const workspaceDir = resolveAgentWorkspaceDir(this.params.cfg, this.params.agentId);
    const fullPath = path.resolve(workspaceDir, params.relPath);
    const text = await fs.readFile(fullPath, "utf-8");
    return { text, path: params.relPath };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "broccolidb",
      provider: "broccolidb",
      model: this.params.resolved.broccolidb?.embedding.model,
      workspaceDir: resolveAgentWorkspaceDir(this.params.cfg, this.params.agentId),
      dbPath: this.params.resolved.broccolidb?.dbPath,
      vector: {
        enabled: true,
        available: true,
        dims: this.params.resolved.broccolidb?.embedding.dimensions,
      },
      custom: {
        maintenance: "running",
      },
    };
  }

  async sync(): Promise<void> {
    await this.maintenance.runMaintenance();
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: true };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.maintenance.stop();
    await this.connection.getPool().stop();
  }
}
