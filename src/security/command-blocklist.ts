import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("security/command-blocklist");

export interface BlocklistResult {
  blocked: boolean;
  reason?: string;
}

const BLOCKED_COMMANDS = [
  // Network tools (prevent exfiltration)
  { pattern: /\b(nc|netcat|ncat|tcpdump|nmap|wireshark|tshark)\b/i, label: "network-recon" },
  { pattern: /\b(curl|wget|fetch|axios|request)\b/i, label: "unauthorized-download" },
  
  // Privilege escalation
  { pattern: /\b(sudo|su|doas|pkexec)\b/i, label: "privilege-escalation" },
  
  // Sandbox escape / Container tools
  { pattern: /\b(docker|kubectl|helm|nerdctl|crictl|ctr)\b/i, label: "container-management" },
  
  // Sensitive path access (beyond what seccomp catches)
  { pattern: /\/(etc\/(shadow|gshadow|ssh)|proc\/self\/environ|root\/\.ssh)/i, label: "sensitive-path-access" },
  
  // Destructive / cleanup bypassing
  { pattern: /\b(rm\s+-[rf]{1,2}\s+\/)\b/i, label: "system-destruction" },
];

/**
 * Validates a shell command against a high-security blocklist.
 */
export function validateCommand(command: string): BlocklistResult {
  for (const entry of BLOCKED_COMMANDS) {
    if (entry.pattern.test(command)) {
      log.warn(`Blocked command execution [${entry.label}]: ${command}`);
      return {
        blocked: true,
        reason: `Command execution blocked: detected restricted tool or pattern (${entry.label}).`
      };
    }
  }

  return { blocked: false };
}
