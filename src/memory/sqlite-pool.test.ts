import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getGlobalSqlitePool, SqliteConnectionPool } from "./sqlite-pool.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

describe("SqliteConnectionPool Hardening", () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-pool-test-"));
    });

    afterEach(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("should automatically create missing database directories", async () => {
        const dbPath = path.join(testDir, "deep/path/to/db.sqlite");
        const pool = new SqliteConnectionPool({ dbPath });
        
        await pool.initialize();
        
        expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
        expect(fs.existsSync(dbPath)).toBe(true);
        pool.close();
    });

    it("should handle concurrent initializations gracefully", async () => {
        const dbPath = path.join(testDir, "concurrent.sqlite");
        const pool = new SqliteConnectionPool({ dbPath });
        
        const init1 = pool.initialize();
        const init2 = pool.initialize();
        
        await Promise.all([init1, init2]);
        
        expect(pool.getStatus().initialized).toBe(true);
        pool.close();
    });

    it("should provide fair write locking with queue-based mutex", async () => {
        const dbPath = ":memory:";
        const pool = new SqliteConnectionPool({ dbPath, poolSize: 1 });
        await pool.initialize();
        
        const results: number[] = [];
        
        // Grab the lock first to block others
        await pool.withWriteLock(async () => {
            const writeOp = async (id: number) => {
                await pool.withWriteLock(async () => {
                    results.push(id);
                });
            };

            // These will now definitely queue up in order
            const p1 = writeOp(1);
            // Small delay to ensure they are registered in the mutex queue in order
            await new Promise(r => setTimeout(r, 10));
            const p2 = writeOp(2);
            await new Promise(r => setTimeout(r, 10));
            const p3 = writeOp(3);

            // Wait a bit to ensure they are all waiting
            await new Promise(r => setTimeout(r, 50));
            
            // Release the master lock
        });

        // Now wait for the queued ones to finish
        // We need to wait for them because release of master lock triggers the NEXT one.
        // Each release triggers the next in a chain.
        let iterations = 0;
        while (results.length < 3 && iterations < 20) {
            await new Promise(r => setTimeout(r, 10));
            iterations++;
        }

        expect(results).toEqual([1, 2, 3]);
        pool.close();
    });

    it("should round-robin read connections", async () => {
        const dbPath = ":memory:";
        const pool = new SqliteConnectionPool({ dbPath, poolSize: 2 });
        await pool.initialize();
        
        const conn1 = pool.acquireRead();
        const conn2 = pool.acquireRead();
        const conn3 = pool.acquireRead();
        
        expect(conn1).not.toBe(conn2);
        expect(conn1).toBe(conn3); // Wrapped back to first connection
        
        pool.close();
    });

    it("should handle global pool registration with resolved paths", () => {
        const dbPath = "relative.sqlite";
        const pool1 = getGlobalSqlitePool(dbPath);
        const pool2 = getGlobalSqlitePool("./relative.sqlite");
        
        expect(pool1).toBe(pool2);
        pool1.close();
    });
});
