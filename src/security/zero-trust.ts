import { getJoyZoningStore } from "../infra/joy-zoning-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("security/zero-trust");

/**
 * Validates if the current session trust level allows executing high-risk commands.
 * Phase 6: Blocks high-risk tools (nc, nmap, etc.) if ANY strikes or warnings exist.
 */
export function authorizeToolExecution(command: string): { authorized: boolean; reason?: string } {
    const jzStore = getJoyZoningStore();
    const health = jzStore.getHealthSummary();
    
    // God-Mode Phase 6: Zero-Tolerance for high-risk tools in suspicious sessions.
    // If any strikes (file-level) or warnings/blocks (session-level) exist, we block high-risk tools.
    const isSuspicious = health.totalWarnings > 0 || health.totalBlocks > 0 || health.filesWithStrikes > 0;
    
    if (isSuspicious) {
        const highRiskTools = /\b(nc|netcat|nmap|ssh|scp|ftp|rsync|base64|xxd|sudo)\b/i;
        if (highRiskTools.test(command)) {
            log.warn(`Zero-Trust Block: Prevented execution of high-risk tool '${command}' in suspicious session.`);
            return {
                authorized: false,
                reason: "Zero-Trust Policy: High-risk tool blocked due to low session trust."
            };
        }
    }
    
    // Traditional architectural block for extreme commands regardless of trust
    const extremeCommands = /rm -rf \/|chmod|chown/i;
    if (extremeCommands.test(command)) {
         return {
            authorized: false,
            reason: "Security Policy: Privileged destructive command blocked."
        };
    }

    return { authorized: true };
}

/**
 * Network Tarpitting: Introduces artificial latency for network-bound tools
 * if the session has any security strikes. This slows down automated exfiltration.
 */
export async function tarpitNetworkTool(command: string): Promise<void> {
    const jzStore = getJoyZoningStore();
    const health = jzStore.getHealthSummary();
    
    const isSuspicious = health.totalWarnings > 0 || health.totalBlocks > 0 || health.filesWithStrikes > 0;
    
    if (isSuspicious) {
        const networkTools = /\b(curl|wget|git|nc|netcat|nmap|ping|ssh|scp|ftp)\b/i;
        if (networkTools.test(command)) {
            // Dynamic delay: 2s base + 1s per warning, capped at 10s.
            const delay = Math.min(10000, 2000 + (health.totalWarnings * 1000));
            log.warn(`Tarpitting network tool '${command}' for ${delay}ms due to low session trust.`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
