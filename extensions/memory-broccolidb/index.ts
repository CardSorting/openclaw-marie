/**
 * OpenClaw Memory (BroccoliDB) Plugin
 *
 * Versioned reasoning and long-term memory with Merkle-tree persistence.
 * Maps OpenClaw sessions to native BroccoliDB branches for isolated,
 * version-controlled context.
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-broccolidb";
import {
  broccolidbConfigSchema,
  vectorDimsForModel,
  DEFAULT_CAPTURE_MAX_CHARS,
  MEMORY_CATEGORIES,
  type MemoryCategory,
} from "./config.js";
import { AgentContext } from "./src/core/agent-context.js";
import { Connection } from "./src/core/connection.js";
import { AiService } from "./src/core/embedding.js";
import { AgentGitError } from "./src/core/errors.js";
import { executor } from "./src/core/executor.js";
// Import ported core logic
import { Repository } from "./src/core/repository.js";
import { Workspace } from "./src/core/workspace.js";
import { dbPool } from "./src/infrastructure/db/BufferedDbPool.js";
import { MaintenanceService } from "./src/infrastructure/MaintenanceService.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const broccolidbPlugin = {
  id: "memory-broccolidb",
  name: "Memory (BroccoliDB)",
  description: "Versioned reasoning and memory with Merkle-tree branching",
  kind: "memory" as const,
  configSchema: broccolidbConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = broccolidbConfigSchema.parse(api.pluginConfig);
    const resolvedDbPath = api.resolvePath(cfg.dbPath!);
    const { model, dimensions } = cfg.embedding;

    // Hardening: Initialize native logging in infrastructure
    dbPool.setLogger(api.logger);
    executor.setLogger(api.logger);

    // Initialize BroccoliDB Core
    const connection = new Connection({
      dbPath: resolvedDbPath,
    });

    // Workspace silo - in the future, we can map userId dynamically
    const workspace = new Workspace(connection.getPool(), "OpenClawUser", "default-workspace");

    // AiService for embeddings and logic relationship auditing
    const aiService = new AiService({
      model,
      outputDimensionality: dimensions ?? vectorDimsForModel(model),
    });

    const repo = new Repository(connection.getPool(), "openclaw-memories");

    // Inject native logger into AgentContext for service-wide telemetry
    const agentContext = new AgentContext(workspace, 0, aiService, api.logger);
    repo.agentContext = agentContext;

    // Phase 2: Native Maintenance Service
    const maintenance = new MaintenanceService(connection.getPool(), api.logger);

    /**
     * Unified Error Mapping: Maps internal AgentGitError to structured tool responses.
     */
    const wrapTool = async (fn: () => Promise<any>) => {
      try {
        return await fn();
      } catch (err: any) {
        const isAgentGitError = err instanceof AgentGitError;
        const code = isAgentGitError ? err.code : "INTERNAL_ERROR";
        const message = err.message || "An unexpected error occurred in BroccoliDB.";

        api.logger.error(
          `[broccolidb] Tool error [${code}]: ${message}${isAgentGitError ? ` | Conflicts: ${err.conflicts?.join(", ")}` : ""}`,
        );

        return {
          content: [{ type: "text", text: `BroccoliDB Error [${code}]: ${message}` }],
          isError: true,
          details: {
            error: message,
            code,
            conflicts: isAgentGitError ? err.conflicts : undefined,
          },
        };
      }
    };

    api.logger.info(
      `memory-broccolidb: production infrastructure initialized (db: ${resolvedDbPath})`,
    );

    /**
     * Helper to resolve the branch name for a given session key.
     * This provides thread-level isolation and versioning.
     */
    const resolveBranch = (sessionKey: string) => `session/${sessionKey}`;

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "broccolidb_recall",
        label: "BroccoliDB Recall",
        description: "Recall memories using semantic search and knowledge graph traversal.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results" })),
          sessionKey: Type.String({ description: "Current session key for branch-aware recall" }),
        }),
        async execute(_toolCallId: string, params: any) {
          return wrapTool(async () => {
            const {
              query,
              limit = 5,
              sessionKey,
            } = params as { query: string; limit?: number; sessionKey: string };
            const branch = resolveBranch(sessionKey);

            // Ensure branch exists
            await repo.createBranch(branch).catch(() => {});

            // Search using agent context for graph-aware RAG
            const results = await agentContext.searchKnowledge(query, [], limit);

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No relevant memories found." }],
                details: { count: 0 },
              };
            }

            const text = results
              .map((r, i) => `${i + 1}. [${r.confidence.toFixed(2)}] ${r.content}`)
              .join("\n");
            return {
              content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }],
              details: { count: results.length, memories: results },
            };
          });
        },
      },
      { name: "memory_recall" },
    );

    api.registerTool(
      {
        name: "broccolidb_store",
        label: "BroccoliDB Store",
        description: "Store information in a versioned knowledge graph.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to store" }),
          category: Type.Optional(
            Type.Unsafe<MemoryCategory>({ type: "string", enum: [...MEMORY_CATEGORIES] }),
          ),
          sessionKey: Type.String({ description: "Current session key for branch-aware storage" }),
        }),
        async execute(_toolCallId: string, params: any) {
          return wrapTool(async () => {
            const {
              text,
              category = "fact",
              sessionKey,
            } = params as { text: string; category?: string; sessionKey: string };
            const branch = resolveBranch(sessionKey);

            await repo.createBranch(branch).catch(() => {});

            // Add to knowledge graph
            const id = await agentContext.addKnowledge("auto", category as any, text, {
              source: `session:${sessionKey}`,
            });

            // Commit the state change to the branch
            await repo.commit(
              branch,
              { factId: id },
              "OpenClaw",
              `Stored memory: ${text.slice(0, 50)}...`,
              {
                type: "snapshot",
              },
            );

            return {
              content: [{ type: "text", text: `Stored memory with ID: ${id}` }],
              details: { id },
            };
          });
        },
      },
      { name: "memory_store" },
    );

    api.registerTool(
      {
        name: "broccolidb_branch_hypothesis",
        label: "Branch Hypothesis",
        description:
          "Create a new reasoning branch to explore a hypothesis without affecting the main session.",
        parameters: Type.Object({
          baseSessionKey: Type.String({ description: "The session key to fork from" }),
          hypothesisName: Type.String({ description: "Short descriptive name for the hypothesis" }),
          message: Type.String({ description: "Reason for branching" }),
        }),
        async execute(_toolCallId, params) {
          return wrapTool(async () => {
            const { baseSessionKey, hypothesisName, message } = params as {
              baseSessionKey: string;
              hypothesisName: string;
              message: string;
            };
            const baseBranch = resolveBranch(baseSessionKey);
            const hypBranch = `hypothesis/${hypothesisName}/${randomUUID().slice(0, 8)}`;

            await repo.branchHypothesis(baseBranch, hypBranch);
            await repo.commit(hypBranch, { hypothesis: hypothesisName }, "OpenClaw", message, {
              type: "hypothesis",
            });
            return {
              content: [
                { type: "text", text: `Successfully branched hypothesis to: ${hypBranch}` },
              ],
              details: { branch: hypBranch },
            };
          });
        },
      },
      { name: "branch_hypothesis" },
    );

    api.registerTool({
      name: "broccolidb_traverse_graph",
      label: "Traverse Graph",
      description: "Traverse graph edges to find interconnected knowledge nodes.",
      parameters: Type.Object({
        kbId: Type.String({ description: "The starting Knowledge Base item ID" }),
        maxDepth: Type.Optional(Type.Number({ description: "Max hops" })),
        direction: Type.Optional(
          Type.Unsafe({ type: "string", enum: ["outbound", "inbound", "both"] }),
        ),
      }),
      async execute(_toolCallId, params) {
        return wrapTool(async () => {
          const { kbId, maxDepth = 2, direction = "outbound" } = params as any;
          const results = await agentContext.traverseGraph(kbId, maxDepth, { direction });
          return {
            content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
            details: { count: results.length },
          };
        });
      },
    });

    api.registerTool({
      name: "broccolidb_audit_reasoning",
      label: "Audit Reasoning",
      description: "Scan the knowledge graph for logical contradictions.",
      parameters: Type.Object({
        startId: Type.String({ description: "Node ID to start the audit from" }),
        depth: Type.Optional(Type.Number({ description: "Traversal depth" })),
      }),
      async execute(_toolCallId, params) {
        return wrapTool(async () => {
          const { startId, depth = 3 } = params as any;
          const reports = await agentContext.detectContradictions(startId, depth);
          if (reports.length === 0)
            return {
              content: [{ type: "text", text: "No logical contradictions detected." }],
              details: { count: 0 },
            };

          let output = `[Audit Report] Found ${reports.length} potential contradictions:\n`;
          for (const r of reports) {
            output += ` - Conflict between ${r.nodeId} and ${r.conflictingNodeId} (Score: ${r.confidence.toFixed(2)})\n`;
          }
          return {
            content: [{ type: "text", text: output }],
            details: { count: reports.length, reports },
          };
        });
      },
    });

    api.registerTool({
      name: "broccolidb_claim_file",
      label: "Claim File",
      description: "Claim a file for exclusive editing to prevent swarm merge conflicts.",
      parameters: Type.Object({
        path: Type.String({ description: "File path to claim" }),
        sessionKey: Type.String({ description: "Current session key" }),
        author: Type.String({ description: "Agent ID claiming the file" }),
      }),
      async execute(_toolCallId, params) {
        return wrapTool(async () => {
          const { path, sessionKey, author } = params as any;
          const branch = resolveBranch(sessionKey);
          await repo.files().claimFile(branch, path, author);
          return {
            content: [{ type: "text", text: `Successfully claimed ${path} for ${author}` }],
            details: { path, author },
          };
        });
      },
    });

    api.registerTool({
      name: "broccolidb_release_file",
      label: "Release File",
      description: "Release an exclusive file claim.",
      parameters: Type.Object({
        path: Type.String({ description: "File path to release" }),
        sessionKey: Type.String({ description: "Current session key" }),
        author: Type.String({ description: "Agent ID releasing the file" }),
      }),
      async execute(_toolCallId, params) {
        const { path, sessionKey, author } = params as any;
        const branch = resolveBranch(sessionKey);
        try {
          await repo.files().releaseFile(branch, path, author);
          return {
            content: [{ type: "text", text: `Successfully released ${path} for ${author}` }],
            details: { path, author },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Release failed: ${err.message}` }],
            isError: true,
            details: { error: err.message },
          };
        }
      },
    });

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================
    // Auto-recall: inject relevant memories before agent starts
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event: any) => {
        const sessionKey = event.sessionKey || "default";
        const branch = resolveBranch(sessionKey);

        try {
          // Ensure branch exists and isolate search context
          await repo.createBranch(branch).catch(() => {});

          // Rank memories by relevance to current prompt
          const results = await agentContext.searchKnowledge(event.prompt || "", [], 5, undefined, {
            augmentWithGraph: true,
          });

          if (results.length > 0) {
            const memories = results.map((r) => `[RECALLED] (${r.type}) ${r.content}`).join("\n");
            const logFn = api.logger.debug;
            if (typeof logFn === "function") {
              logFn(
                `Effective cognitive recall for session ${sessionKey}: ${results.length} nodes injected.`,
              );
            }
            return { prependContext: `<broccolidb-context>\n${memories}\n</broccolidb-context>` };
          }
        } catch (err) {
          api.logger.warn(
            `memory-broccolidb: auto-recall failed for session ${sessionKey}: ${String(err)}`,
          );
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-broccolidb",
      start: () => {
        api.logger.info(`memory-broccolidb: service starting (db: ${resolvedDbPath})`);
        maintenance.start();
      },
      stop: async () => {
        api.logger.info("memory-broccolidb: flushing database and stopping service...");
        maintenance.stop();
        await dbPool.stop();
        api.logger.info("memory-broccolidb: service stopped cleanly.");
      },
    });
  },
};

export default broccolidbPlugin;
