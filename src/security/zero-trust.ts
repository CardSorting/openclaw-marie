import { getJoyZoningStore } from "../infra/joy-zoning-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("security/zero-trust");

const TRUST_STRIKE_LIMIT = 2;

/**
 * Validates if the current session trust level allows executing high-risk commands.
 * High-risk commands (like network tools or disk wipers) are blocked if the session
 * has ANY previous security strikes.
 */
export function authorizeToolExecution(command: string): { authorized: boolean; reason?: string } {
    const jzStore = getJoyZoningStore();
    
    // Check global session health or specific tool strikes
    // For God-Mode, we block "extreme" commands if there's any record of suspicious behavior
    const extremeCommands = /curl|wget|nc|nmap|rm -rf \/|chmod|chown|sudo/i;
    
    if (extremeCommands.test(command)) {
        // High-risk command detected. Check for any strikes in the session.
        // We'll check the health summary for any blocks/warnings.
        const health = jzStore.getHealthSummary();
        if (health.totalBlocks > 0 || health.totalWarnings > TRUST_STRIKE_LIMIT) {
            log.warn(`Zero-Trust Violation: Blocking extreme command '${command}' due to poor session health.`);
            return {
                authorized: false,
                reason: "Zero-Trust policy: Session health too low for privileged tool execution."
            };
        }
    }
    
    return { authorized: true };
}

/**
 * Network Tarpitting: Introduces artificial latency for networkbound tools
 * if the session has any security strikes. This slows down automated exfiltration.
 */
export async function tarpitNetworkTool(command: string): Promise<void> {
    const jzStore = getJoyZoningStore();
    const health = jzStore.getHealthSummary();
    
    // If there's any recorded suspicion, tarpit network tools
    if (health.totalWarnings > 0 || health.totalBlocks > 0) {
        const networkTools = /\b(curl|wget|git|nc|netcat|nmap|ping|ssh|scp|ftp)\b/i;
        if (networkTools.test(command)) {
            const delay = Math.min(10000, 2000 + (health.totalWarnings * 1000)); // Dynamic delay up to 10s
            log.warn(`Tarpitting network tool '${command}' for ${delay}ms due to low session trust.`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
