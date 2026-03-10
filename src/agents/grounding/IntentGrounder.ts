import fs from "node:fs/promises";
import path from "node:path";
import { streamSimple, type Model, type Api, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import { z } from "zod";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { resolveGroundingModel } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.js";
import { getApiKeyForModel } from "../model-auth.js";
import type { GroundedSpec, GroundingContext } from "./types.js";

const GroundedSpecSchema = z.object({
  intent: z.string().describe("The fully refined and grounded intent string"),
  rules: z.array(z.string()).describe("List of specific project rules or guidelines observed"),
  environmentMarkers: z
    .array(z.string())
    .describe("The most critical context markers for this task"),
  confidence: z.number().min(0).max(1).describe("Confidence score for the grounding (0-1)"),
  missingInfo: z
    .array(z.string())
    .optional()
    .describe("Optional list of crucial information still required"),
});

export class IntentGrounder {
  constructor(private config: OpenClawConfig) {}

  /**
   * Grounds a user intent by auditing the environment and matching it against project rules.
   * This follows a 5-pass hardening process to ensure the intent is robust and well-defined.
   * @param intent The user intent to ground.
   * @param context The grounding context (workspace, agent, etc).
   * @param parentSpec Optional grounded spec from a parent agent to inherit context from.
   */
  async ground(
    intent: string,
    context: GroundingContext,
    parentSpec?: GroundedSpec,
  ): Promise<GroundedSpec> {
    const startedAt = Date.now();

    // Pass 1: Discovery
    const environmentMarkers = await this.discoverEnvironment(context.workspaceDir);

    // Pass 2-5: Inference, Self-Correction, Verification, Grounding
    const grounded = await this.hardenIntent(intent, environmentMarkers, context, parentSpec);

    return {
      ...grounded,
      metadata: {
        model: grounded.metadata?.model,
        latencyMs: Date.now() - startedAt,
        timestamp: Date.now(),
      },
    };
  }

  private async discoverEnvironment(workspaceDir: string): Promise<string[]> {
    // ... (rest of the method stays the same, omitted for brevity but should be preserved)
    const markers: string[] = [];
    try {
      const files = await fs.readdir(workspaceDir);

      // Project Type Discovery
      if (files.includes("package.json")) {
        markers.push("Node.js project");
        try {
          const pkg = JSON.parse(
            await fs.readFile(path.join(workspaceDir, "package.json"), "utf8"),
          );
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps["next"]) {
            markers.push("Next.js framework detected");
          }
          if (deps["react"]) {
            markers.push("React library detected");
          }
          if (deps["vue"]) {
            markers.push("Vue framework detected");
          }
          if (deps["typescript"]) {
            markers.push("TypeScript project");
          }
        } catch {}
      }

      if (files.includes("pnpm-workspace.yaml") || files.includes("lerna.json")) {
        markers.push("Monorepo detected");
      }

      if (files.includes("tsconfig.json")) {
        markers.push("TypeScript config present");
      }
      if (files.includes("src")) {
        markers.push("Source directory (src/) present");
      }
      if (files.includes(".openclaw")) {
        markers.push("OpenClaw configuration (.openclaw/) present");
      }

      // Documentation & Context Discovery
      const contextFiles = [
        "README.md",
        "AGENTS.md",
        "VISION.md",
        "MEMORY.md",
        "USER.md",
        "TODO.md",
      ];
      for (const file of contextFiles) {
        if (files.includes(file)) {
          markers.push(`Context file found: ${file}`);
        }
      }

      // Rule Discovery
      const ruleFiles = [
        ".cursorrules",
        ".windsurfrules",
        ".clinerules",
        ".agentrules",
        ".openclawrules",
      ];
      for (const file of ruleFiles) {
        if (files.includes(file)) {
          markers.push(`Project rules file found: ${file}`);
        }
      }

      // Look for project rules in common directories
      const possibleRulesPaths = [
        path.join(workspaceDir, ".openclaw", "rules"),
        path.join(workspaceDir, ".agents", "rules"),
        path.join(workspaceDir, "rules"),
        path.join(workspaceDir, "docs", "rules"),
      ];

      for (const rulesPath of possibleRulesPaths) {
        try {
          const rulesFiles = await fs.readdir(rulesPath);
          if (rulesFiles.length > 0) {
            markers.push(
              `Project rules directory found: ${path.relative(workspaceDir, rulesPath)} (${rulesFiles.length} files)`,
            );
          }
        } catch {}
      }
    } catch (err) {
      markers.push(`Discovery error: ${String(err)}`);
    }
    return markers;
  }

  private async readRuleFiles(
    workspaceDir: string,
    intent: string,
    agentId?: string,
  ): Promise<string> {
    const agentConfig = agentId ? resolveAgentConfig(this.config, agentId) : undefined;
    const ruleFiles = agentConfig?.groundingRules ??
      this.config.agents?.defaults?.groundingRules ?? [
        ".cursorrules",
        ".openclawrules",
        "AGENTS.md",
        "CLAUDE.md",
        "README.md",
      ];

    let combinedRules = "";

    for (const file of ruleFiles) {
      try {
        const fullPath = path.isAbsolute(file) ? file : path.join(workspaceDir, file);
        const content = await fs.readFile(fullPath, "utf-8");
        const filtered = this.markdownSectionFilter(content, intent);
        if (filtered) {
          combinedRules += `\n--- [FILE: ${file}] ---\n${filtered}\n`;
        }
      } catch {
        // Skip if file doesn't exist
      }
    }
    return combinedRules;
  }

  private markdownSectionFilter(content: string, intent: string): string {
    const keywords = intent
      .toLowerCase()
      .split(/\W+/)
      .filter((k) => k.length > 3);
    const sections = content.split(/\n(?=#+\s)/);
    const relevantSections: string[] = [];

    for (const section of sections) {
      if (keywords.some((k) => section.toLowerCase().includes(k))) {
        relevantSections.push(section);
      }
    }

    if (relevantSections.length === 0) {
      return this.contextualFilter(content, intent);
    }

    return relevantSections.join("\n").substring(0, 4000);
  }

  private contextualFilter(content: string, intent: string): string {
    const keywords = intent
      .toLowerCase()
      .split(/\W+/)
      .filter((k) => k.length > 3);
    const lines = content.split("\n");
    const relevantLines = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (keywords.some((k) => line.includes(k))) {
        // Grab context (2 lines before and after)
        for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
          relevantLines.add(lines[j]);
        }
      }
    }

    if (relevantLines.size === 0) {
      return content.substring(0, 500) + "... (no specific keyword match)";
    }

    return Array.from(relevantLines).join("\n").substring(0, 3000);
  }

  private securityAudit(intent: string): { warning?: string; confidenceAdjustment: number } {
    const highRiskPatterns = [
      { pattern: /\bsudo\b/i, warning: "Sudo usage detected" },
      { pattern: /\brm\b\s+-[rf]/i, warning: "Recursive deletion detected" },
      { pattern: />\s*\/dev\/sd/i, warning: "Direct disk access detected" },
    ];

    for (const { pattern, warning } of highRiskPatterns) {
      if (pattern.test(intent)) {
        return { warning, confidenceAdjustment: 0.4 };
      }
    }
    return { confidenceAdjustment: 1.0 };
  }

  private calculateSimilarity(s1: string, s2: string): number {
    const w1 = new Set(
      s1
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3),
    );
    const w2 = new Set(
      s2
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3),
    );
    if (w1.size === 0) {
      return 1.0;
    }
    const intersection = new Set([...w1].filter((x) => w2.has(x)));
    return intersection.size / w1.size;
  }

  private async hardenIntent(
    intent: string,
    environmentMarkers: string[],
    context: GroundingContext,
    parentSpec?: GroundedSpec,
    retryCount = 0,
  ): Promise<GroundedSpec> {
    const startTime = Date.now();
    let promptStartTime: number | undefined;
    let llmStartTime: number | undefined;

    try {
      promptStartTime = Date.now();
      const modelRef = resolveGroundingModel({
        cfg: this.config,
        agentId: context.agentId,
      });

      const auth = await getApiKeyForModel({
        model: { provider: modelRef.provider, id: modelRef.model } as unknown as Model<Api>,
        cfg: this.config,
      });

      if (!auth.apiKey) {
        throw new Error(`No API key for grounding model: ${modelRef.provider}/${modelRef.model}`);
      }

      const ruleContent = await this.readRuleFiles(context.workspaceDir, intent, context.agentId);
      const parentContext = parentSpec
        ? `<parent_grounding>
- Intent: ${parentSpec.intent}
- Rules: ${parentSpec.rules?.join(", ") || "None"}
- Confidence: ${parentSpec.confidence}
</parent_grounding>`
        : "";

      const alignmentHistory =
        context.history && context.history.length > 0
          ? `<alignment_history>
${context.history
  .slice(-3)
  .map((h, i) => `[Turn ${i + 1}] ${h.intent}`)
  .join("\n")}
</alignment_history>`
          : "";

      const retryHint =
        retryCount > 0
          ? `<retry_advisory>
Your previous attempt failed validation or had low confidence. Be more precise and adhere strictly to the JSON schema and rule context.
</retry_advisory>`
          : "";

      // Hard-coded Elite Rules as a safety net
      const eliteRules = [
        "Use repository-root relative paths only (e.g., src/main.ts).",
        "Avoid absolute paths or home directory shortcuts (~/...).",
        "Follow the JoyZoning pillars (Skill Evolution, SecretRef, etc.).",
        "Prefer Bun for TypeScript execution if available.",
        "Maintain turn-over-turn alignment with the provided alignment history.",
      ];

      const systemPrompt = `You are the OpenClaw Intent Grounder, a state-of-the-art orchestration pass.
Your objective is to "ground" the user intent against the project environment to prevent hallucinations, tool misuse, and architectural drift.

<context_markers>
${environmentMarkers.map((m) => `- ${m}`).join("\n")}
</context_markers>

${parentContext}
${alignmentHistory}
${retryHint}

<project_rules>
${ruleContent || "No project-specific rule files found."}
</project_rules>

<elite_security_rules>
${eliteRules.map((r) => `- ${r}`).join("\n")}
</elite_security_rules>

### The 5-Pass Hardening Protocol
1. **DISCOVERY**: Contextualize the intent using the markers, rules, and alignment history provided above.
2. **INFERENCE**: Deduce technical stack, coding standards, and project-specific abstractions (e.g. JoyZoning, SecretRef).
3. **SELF-CORRECTION**: Identify if the user intent makes assumptions that contradict the environment or rules.
4. **VERIFICATION**: Perform a safety and alignment audit. Ensure no established boundaries (like no relative paths in chat) are violated.
5. **GROUNDING**: Synthesize a robust, technically accurate specification.

### Grounding Advisor Pass
As the final step before emitting JSON, perform a "Grounding Advisor" pass:
- If you are unsure about a file path, **do not guess**. List it in "missingInfo".
- If the intent requires a tool that is not suitable for the task, suggest the correct tool in the grounded "intent".
- If the intent violates a core project rule, flag it in "rules" and adjust the "intent" to comply.

### Response Requirements
- Output ONLY valid JSON.
- Be extremely specific. Use concrete paths and tool names.
- In "rules", list ONLY the project guidelines that MUST be followed for this SPECIFIC task.
- If the intent is ambiguous or requires more info, list specific questions in "missingInfo".

### Output Schema (JSON)
{
  "intent": "string",
  "rules": ["string"],
  "environmentMarkers": ["string"],
  "confidence": number,
  "missingInfo": ["string"]
}`;

      llmStartTime = Date.now();
      const stream = streamSimple(
        {
          provider: modelRef.provider,
          id: modelRef.model,
          apiKey: auth.apiKey,
        } as unknown as Model<Api>,
        {
          messages: [
            {
              role: "user" as const,
              content: `System Instructions: ${systemPrompt}\n\nORIGINAL INTENT: ${intent}`,
              timestamp: Date.now(),
            },
          ],
        },
        { json: true } as unknown as SimpleStreamOptions,
      );

      const message = await stream.result();
      const content =
        typeof message.content === "string" ? message.content : JSON.stringify(message.content);

      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      const jsonContent = jsonMatch[1] || content;

      const parsed = GroundedSpecSchema.parse(JSON.parse(jsonContent));

      // Pass 6: Security Audit
      const securityResult = this.securityAudit(parsed.intent);
      if (securityResult.warning) {
        console.warn(`[IntentGrounder] Security Warning: ${securityResult.warning}`);
        parsed.confidence *= securityResult.confidenceAdjustment;
      }

      // Pass 5: Path Sanity Check
      const suspiciousPaths = parsed.intent.match(/\s(\/|[A-Z]:\\)[\w\-./]+/g);
      if (suspiciousPaths && suspiciousPaths.length > 0) {
        console.warn(
          `[IntentGrounder] Potential absolute path detected in grounded intent: ${suspiciousPaths.join(", ")}`,
        );
        parsed.confidence = Math.min(parsed.confidence, 0.4);
      }

      // Pass 5: Similarity-based Drift Detection
      const similarity = this.calculateSimilarity(intent, parsed.intent);
      const drift = similarity < 0.3;

      // Self-Correction: If confidence is too low and we haven't retried yet, try one more time
      if (parsed.confidence < 0.5 && retryCount < 1) {
        return this.hardenIntent(intent, environmentMarkers, context, parentSpec, retryCount + 1);
      }

      return {
        ...parsed,
        metadata: {
          model: `${modelRef.provider}/${modelRef.model}`,
          timestamp: Date.now(),
          latencyMs: Date.now() - startTime,
          latencyBreakdown: {
            prompt: (llmStartTime || 0) - (promptStartTime || 0),
            llm: Date.now() - (llmStartTime || 0),
          },
          drift,
          similarity,
          retryCount,
        },
      };
    } catch (err) {
      if (retryCount < 1) {
        return this.hardenIntent(intent, environmentMarkers, context, parentSpec, retryCount + 1);
      }

      console.warn(`[IntentGrounder] Grounding fallback active: ${String(err)}`);
      return {
        intent,
        rules: [],
        environmentMarkers,
        confidence: 0.1,
        metadata: {
          timestamp: Date.now(),
          latencyMs: Date.now() - startTime,
          error: String(err),
          retryCount,
        },
      };
    }
  }
}
