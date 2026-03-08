import path from "node:path";
import fs from "node:fs/promises";
import { getJoyZoningStore } from "../infra/joy-zoning-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("security/quarantine");

/**
 * Shadow Mirroring: Redirects file writes to a temporary overlay
 * if the session has accumulated security strikes.
 */
export async function getQuarantinePath(originalPath: string): Promise<string> {
    const jzStore = getJoyZoningStore();
    const health = jzStore.getHealthSummary();
    
    // If the session is suspicious (trust < 100 or strikes > 1), we quarantine.
    // We use a low threshold for Phase 6 "God-Mode" active containment.
    if (health.totalWarnings > 0 || health.totalBlocks > 0) {
        const stateDir = process.env.OPENCLAW_STATE_DIR || "/tmp/.openclaw";
        const quarantineRoot = path.join(stateDir, "quarantine", "shadow_overlay");
        
        await fs.mkdir(quarantineRoot, { recursive: true });
        
        // Map the original path into the quarantine root
        // We'll use a simple hash or just flattened path for the demo.
        const flattened = originalPath.replace(/[\/\\]/g, "_");
        const redirected = path.join(quarantineRoot, flattened);
        
        log.info(`Shadow Mirroring ACTIVE: Redirecting ${originalPath} -> ${redirected}`);
        return redirected;
    }
    
    return originalPath;
}

/**
 * Checks if a command should be executed in a quarantined environment.
 */
export function isQuarantineRequired(): boolean {
    const jzStore = getJoyZoningStore();
    const health = jzStore.getHealthSummary();
    return health.totalWarnings > 0 || health.totalBlocks > 0;
}

/**
 * Command Path Redirection: Transparently reroutes file paths in shell commands.
 */
export function redirectCommandPaths(command: string): string {
    if (!isQuarantineRequired()) return command;

    // Simple redirection: replace common workspace paths with quarantined versions
    // For God-Mode, we target the .openclaw and workspace directories.
    const workspacePattern = /(\/home\/node\/\.openclaw|\.\.\/|\/tmp\/)/g;
    const redirected = command.replace(workspacePattern, (match) => {
        return `/tmp/quarantine/shadow${match.replace(/\//g, "_")}`;
    });

    if (redirected !== command) {
        log.info(`Command path redirected for quarantine: ${command} -> ${redirected}`);
    }
    return redirected;
}

/**
 * Live Forensic Stream: Writes security events to a live JSONL for monitoring.
 */
export async function emitForensicEvent(event: any): Promise<void> {
    const stateDir = process.env.OPENCLAW_STATE_DIR || "/tmp/.openclaw";
    const forensicLog = path.join(stateDir, "security", "forensic_stream.jsonl");
    
    await fs.mkdir(path.dirname(forensicLog), { recursive: true });
    const payload = JSON.stringify({ ts: Date.now(), ...event }) + "\n";
    await fs.appendFile(forensicLog, payload, "utf-8");
}
