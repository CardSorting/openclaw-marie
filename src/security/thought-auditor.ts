import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("security/thought-auditor");

export interface ThoughtAuditResult {
  suspicious: boolean;
  reason?: string;
  intent?: string;
}

const MALICIOUS_INTENTS = [
  { pattern: /jailbreak|ignore.*?instruction|system.*?prompt.*?override/i, intent: "jailbreak-attempt" },
  { pattern: /exfiltrate|leak|steal|copy.*?external/i, intent: "data-theft" },
  { pattern: /bypass.*?security|disable.*?sandbox|remove.*?seccomp/i, intent: "security-bypass" },
  { pattern: /ssh-keygen|cat.*?\.ssh|authorized_keys|\/etc\/passwd|\/etc\/shadow/i, intent: "unauthorized-access" },
  { pattern: /curl.*?\|.*?bash|wget.*?\|.*?sh|nc\s+-l/i, intent: "remote-code-execution" },
  { pattern: /social.*?engineering|manipulate.*?user|pretend.*?to.*?be/i, intent: "social-engineering" },
];

/**
 * Audits the agent's internal reasoning (<think> block) for malicious intent.
 */
export function auditThoughts(thought: string): ThoughtAuditResult {
  if (!thought) return { suspicious: false };

  for (const entry of MALICIOUS_INTENTS) {
    if (entry.pattern.test(thought)) {
      log.warn(`Suspicious thought patterns detected [${entry.intent}]: ${thought.substring(0, 100)}...`);
      return {
        suspicious: true,
        reason: `Malicious intent detected in reasoning: ${entry.intent}`,
        intent: entry.intent
      };
    }
  }

  return { suspicious: false };
}
