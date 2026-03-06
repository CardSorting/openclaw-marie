import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("security/injection-scanner");

export type ThreatSeverity = "critical" | "warn" | "info";

export type ThreatCategory =
  | "prompt-injection"
  | "memory-poisoning"
  | "cross-session"
  | "tool-spoofing"
  | "role-escalation"
  | "supply-chain"
  | "memory-overflow"
  | "vector-poisoning"
  | "key-exfiltration"
  | "sandbox-escape"
  | "data-leak";

export interface ThreatPattern {
  id: string;
  severity: ThreatSeverity;
  pattern: RegExp;
  description: string;
  category: ThreatCategory;
}

export interface ThreatFinding {
  patternId: string;
  severity: ThreatSeverity;
  category: ThreatCategory;
  match: string;
  description: string;
}

export interface ScanResult {
  blocked: boolean;
  findings: ThreatFinding[];
  sanitized: string;
}

/**
 * 14+ Threat patterns covering Marie's production architecture security requirements.
 */
const THREAT_PATTERNS: ThreatPattern[] = [
  {
    id: "prompt-in-memory-injection",
    severity: "critical",
    pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
    description: "Attempt to override system instructions via memory content.",
    category: "prompt-injection",
  },
  {
    id: "cross-session-poisoning",
    severity: "critical",
    pattern: /\[\s*(System|Assistant|User)\s+Session:\s+[a-f0-9-]+\s*\]/i,
    description: "Attempt to bleed data or instructions between different sessions.",
    category: "cross-session",
  },
  {
    id: "tool-result-spoofing",
    severity: "critical",
    pattern: /Tool\s+Result:\s*\{[\s\S]*?"status"\s*:\s*"success"[\s\S]*?\}/i,
    description: "Attempt to spoof tool output within a memory write.",
    category: "tool-spoofing",
  },
  {
    id: "role-escalation-echo",
    severity: "critical",
    pattern: /You\s+are\s+now\s+(a|an|the)\s+(root|admin|system|superuser)/i,
    description: "Attempt to escalate privileges by redefining agent role.",
    category: "role-escalation",
  },
  {
    id: "skill-supply-chain-malice",
    severity: "critical",
    pattern: /curl\s+.*?\|\s+(bash|sh|python|node)/i,
    description: "Potential supply-chain attack: piping remote content to a shell.",
    category: "supply-chain",
  },
  {
    id: "memory-overflow-attack",
    severity: "warn",
    pattern: /(?:.{1000,})/s, // Handled primarily by hard caps, but tracked here
    description: "Exceptionally large single-block write attempt.",
    category: "memory-overflow",
  },
  {
    id: "vector-poisoning-override",
    severity: "critical",
    pattern: /confidence\s*:\s*1\.0|always\s+prefer\s+this\s+entry/i,
    description: "Attempt to artificially inflate vector search priority.",
    category: "vector-poisoning",
  },
  {
    id: "key-exfiltration-attempt",
    severity: "critical",
    pattern: /(?:sk-[a-zA-Z0-9]{32,}|AIza[a-zA-Z0-9_-]{35})/,
    description: "Potential API key exfiltration attempt (OpenAI/Google).",
    category: "key-exfiltration",
  },
  {
    id: "sandbox-escape-indicator",
    severity: "critical",
    pattern: /\/var\/run\/docker\.sock|\/etc\/shadow|\/proc\/self\/environ/i,
    description: "Attempt to access sensitive host paths or escape sandbox.",
    category: "sandbox-escape",
  },
  {
    id: "instruction-shaped-memory",
    severity: "critical",
    pattern: /^\s*(?:Note|Instruction|Rule):\s+/im,
    description: "Content in memory shaped like an imperative instruction.",
    category: "prompt-injection",
  },
  {
    id: "system-prompt-fragment",
    severity: "critical",
    pattern: /##\s+(?:Tooling|Safety|Skills|Memory\s+Recall)/i,
    description: "Attempt to inject system prompt headers into memory.",
    category: "prompt-injection",
  },
  {
    id: "base64-payload-injection",
    severity: "warn",
    pattern: /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{200,}/i,
    description: "Large base64 payload which may hide malicious instructions.",
    category: "prompt-injection",
  },
  {
    id: "encoded-instruction-bypass",
    severity: "critical",
    pattern: /eval\(Buffer\.from\(.*?'base64'\)\)/i,
    description: "Attempt to bypass scanners via base64 decoding in scripts.",
    category: "supply-chain",
  },
  {
    id: "raw-memory-echo-leak",
    severity: "critical",
    pattern: /echo\s+['"]?#\s+MEMORY\.md/i,
    description: "Attempt to leak raw memory contents to the user.",
    category: "data-leak",
  },
];

/**
 * Scan input content for threat patterns.
 *
 * Failure mode: block-and-log on critical, warn on lower severity.
 */
export function scanInput(content: string, context?: string): ScanResult {
  const findings: ThreatFinding[] = [];
  let blocked = false;

  for (const threat of THREAT_PATTERNS) {
    const match = content.match(threat.pattern);
    if (match) {
      const finding: ThreatFinding = {
        patternId: threat.id,
        severity: threat.severity,
        category: threat.category,
        match: match[0].slice(0, 100), // Truncate match for logging
        description: threat.description,
      };
      findings.push(finding);

      if (threat.severity === "critical") {
        blocked = true;
      }

      log.warn(`Threat detected [${threat.id}] in ${context || "unknown"}: ${threat.description}`);
    }
  }

  return {
    blocked,
    findings,
    sanitized: content, // Initially a passthrough for sanitized, could add redaction later
  };
}
