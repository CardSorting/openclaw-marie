import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { emitDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { resolveAgentWorkspaceDir } from "../agent-scope.js";
import { extractEntities } from "../evolutionary-pilot.js";
import { readMemoryState, writeMemory, writeUserModel } from "../marie-memory.js";
import { getStrategicEvolutionStore } from "../strategic-evolution-store.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const MarieMemoryUpdateSchema = Type.Object({
  memory: Type.Optional(Type.String({ description: "Updated content for MEMORY.md" })),
  userModel: Type.Optional(Type.String({ description: "Updated content for USER.md" })),
});

/**
 * Implementation of the missing marie_memory_update tool.
 * This tool is the critical 'effector' of the Nervous System, enabling
 * autonomous subagents to commit memory changes while tracking Semantic Fragility.
 */
export function createMarieMemoryUpdateTool(options: {
  agentSessionKey?: string;
  agentId?: string;
}): AnyAgentTool {
  return {
    label: "Marie Memory Update",
    name: "marie_memory_update",
    description:
      "Commit updated memory content. Calculates Semantic Fragility by comparing entity integrity before and after the update. Use only during autonomous compaction or repair cycles.",
    parameters: MarieMemoryUpdateSchema,
    execute: async (_toolCallId, params) => {
      const memoryUpdate = readStringParam(params, "memory");
      const userModelUpdate = readStringParam(params, "userModel");

      if (!memoryUpdate && !userModelUpdate) {
        return jsonResult({ ok: false, error: "No update provided." });
      }

      const cfg = loadConfig();
      const agentId = options.agentId || "marie"; // Default to marie
      const agentDir = resolveAgentWorkspaceDir(cfg, agentId);

      // 1. Capture Pre-Update State for Fragility Analysis
      const preState = await readMemoryState(agentDir);
      const preEntities = extractEntities(`${preState.memory}\n${preState.userModel}`);

      // 2. Apply Updates
      let memoryOk = true;
      let userModelOk = true;
      let error: string | undefined;

      if (memoryUpdate) {
        const res = await writeMemory(agentDir, memoryUpdate);
        memoryOk = res.ok;
        if (!res.ok) {
          error = res.error;
        }
      }

      if (userModelUpdate) {
        const res = await writeUserModel(agentDir, userModelUpdate);
        userModelOk = res.ok;
        if (!res.ok) {
          error = res.error;
        }
      }

      // 3. Post-Update Analysis (Cognitive Fragility)
      const postState = await readMemoryState(agentDir);
      const postEntities = extractEntities(`${postState.memory}\n${postState.userModel}`);

      const lostEntities = preEntities.filter((e) => !postEntities.includes(e));
      const fragility = preEntities.length > 0 ? lostEntities.length / preEntities.length : 0;

      // 4. Report back to the Nervous System (StrategicEvolutionStore)
      const store = await getStrategicEvolutionStore();
      if (options.agentSessionKey) {
        await store.recordMetric({
          sessionKey: options.agentSessionKey,
          type: "semantic_fragility",
          value: fragility,
          metadata: {
            lostCount: lostEntities.length,
            totalPre: preEntities.length,
            lostSample: lostEntities.slice(0, 5),
          },
        });

        // Trigger diagnostic event for the pilot
        emitDiagnosticEvent({
          type: "strategic.metric",
          sessionKey: options.agentSessionKey,
          metricType: "semantic_fragility",
          value: fragility,
        });
      }

      return jsonResult({
        ok: memoryOk && userModelOk,
        error,
        fragility: Number(fragility.toFixed(3)),
        lostEntities: lostEntities.slice(0, 10),
      });
    },
  };
}
