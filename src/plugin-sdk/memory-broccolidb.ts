// Narrow plugin-sdk surface for the bundled memory-broccolidb plugin.
// Keep this list additive and scoped to symbols used under extensions/memory-broccolidb.

export type { OpenClawPluginApi, PluginLogger } from "../plugins/types.js";
export type { BroccoliDBConfig, MemoryCategory } from "../config/types.memory.js";
export { MEMORY_CATEGORIES } from "../config/types.memory.js";
export type { FileLockHandle, FileLockOptions } from "./file-lock.js";
export { acquireFileLock, withFileLock } from "./file-lock.js";
export { retryAsync, type RetryInfo, type RetryOptions } from "../infra/retry.js";
