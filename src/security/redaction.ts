import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("security/redaction");

export interface RedactionResult {
  content: string;
  redactedCount: number;
}

/**
 * Standard pattern-based PII redaction for Marie's memory and logs.
 */
const REDACTION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "email",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },
  {
    name: "api-key-openai",
    pattern: /sk-[a-zA-Z0-9]{32,}/g,
  },
  {
    name: "api-key-google",
    pattern: /AIza[a-zA-Z0-9_-]{35}/g,
  },
  {
    name: "api-key-anthropic",
    pattern: /ant-api-sk03-[a-zA-Z0-9-_]{80,}/g,
  },
  {
    name: "generic-token",
    pattern: /(?:token|password|secret|key)["']?\s*[:=]\s*["']?([a-zA-Z0-9\-._~+/]{24,})["']?/gi,
  },
];

/**
 * Scrub PII from content before persistence or display.
 */
export function redactPII(content: string): RedactionResult {
  let redacted = content;
  let totalCount = 0;

  for (const { name, pattern } of REDACTION_PATTERNS) {
    const matches = redacted.match(pattern);
    if (matches) {
      totalCount += matches.length;
      redacted = redacted.replace(pattern, (match) => {
        log.debug(`Redacted ${name} pattern.`);
        // If it's a KV pair pattern like "key: value", try to preserve the key
        if (name === "generic-token") {
          return match.replace(/([a-zA-Z0-9\-._~+/]{24,})$/, "[REDACTED]");
        }
        return `[REDACTED_${name.toUpperCase()}]`;
      });
    }
  }

  return {
    content: redacted,
    redactedCount: totalCount,
  };
}
