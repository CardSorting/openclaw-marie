import fs from "node:fs/promises";
import path from "node:path";
import { IntentGrounder } from "./src/agents/grounding/IntentGrounder.js";
import { GroundedSpec } from "./src/agents/grounding/types.js";

async function runVerification() {
  console.log("--- Starting Pass 6 (Mastery) Hardening Verification ---\n");

  const mockConfig: Record<string, unknown> = {
    agents: {
      defaults: {
        groundingRules: [".customrules.md"],
      },
    },
  };

  const grounder = new IntentGrounder(mockConfig);
  const workspaceDir = process.cwd();

  // 1. Setup mock rule file with markdown headers
  const customRulesPath = path.join(workspaceDir, ".customrules.md");
  const markdownRules = `
# Project Structure
Use src/ for all source files.

# Security
Never use sudo in commands.
Always use relative paths.

# Unrelated Section
This section should not be matched.
  `;
  await fs.writeFile(customRulesPath, markdownRules);

  try {
    // 2. Test Markdown-aware filtering & Security Guardrails
    console.log("Test 1: Markdown-aware filtering & Security Guardrail (sudo)...");
    const spec1 = await grounder.ground("sudo rm -rf src/old-code", {
      workspaceDir,
      agentId: "test-agent",
    });

    console.log(`Grounded Intent: ${spec1.intent}`);
    console.log(`Confidence: ${spec1.confidence}`);
    console.log(`Rules found: ${spec1.rules.length}`);

    const rulesLower = spec1.rules.map((r) => r.toLowerCase());
    const hasSecurityRule = rulesLower.some((r) => r.includes("security") || r.includes("sudo"));
    console.log(
      `Logic check: Contains security section headers? ${hasSecurityRule ? "YES" : "NO"}`,
    );

    if (spec1.confidence < 0.5) {
      console.log("SUCCESS: Security guardrail lowered confidence for risky command.");
    } else {
      console.log("FAILURE: Confidence not lowered for risky command.");
    }

    // 3. Test Alignment Memory (History)
    console.log("\nTest 2: Alignment Memory (History)...");
    const history: GroundedSpec[] = [
      {
        intent: "Initialize a new React component in src/components",
        rules: ["Use functional components"],
        environmentMarkers: ["React detected"],
        confidence: 0.9,
        metadata: { timestamp: Date.now(), latencyMs: 100 },
      },
    ];

    const spec2 = await grounder.ground("Add a button to it", {
      workspaceDir,
      agentId: "test-agent",
      history,
    });

    console.log(`Grounded Intent: ${spec2.intent}`);
    console.log(
      `Aligned with history? ${spec2.intent.toLowerCase().includes("component") || spec2.intent.toLowerCase().includes("src/components") ? "Likely YES" : "NO"}`,
    );
  } catch (err) {
    console.error("Verification failed:", err);
  } finally {
    // Cleanup
    await fs.unlink(customRulesPath).catch(() => {});
    console.log("\n--- Verification Complete ---");
  }
}

void runVerification();
