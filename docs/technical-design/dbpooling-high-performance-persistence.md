# ⚡ DBPooling: High-Performance Persistence Strategy

## 🏗️ The Problem: The SQLite "Concurrency Gap"

Standard SQLite databases are powerful but limited by a single writer and potentially slow concurrent reads. In a multi-agent or high-volume gateway environment, concurrent database access can lead to the dreaded `SQLITE_BUSY` error, especially when multiple agents are writing metrics, logging history, and updating session states simultaneously.

## 🧠 The Theory: Centralized Mutex & WAL Orchestration

DBPooling is based on the theory of **Serialized-Write / Parallel-Read Concurrency**. By layering a custom connection pool over `node:sqlite`'s `DatabaseSync`, we can achieve industrial-grade reliability while keeping the simplicity and portability of a single-file database.

### Core Principles

1.  **Write Mutex (Serialization)**: A single, queue-based mutex ensures that only one write operation occurs at any given time across the entire application process.
2.  **Round-Robin Reads (Parallelism)**: Multiple read connections are maintained, allowing the gateway to handle high-read volumes without blocking.
3.  **Journaling Strategy (WAL)**: Uses SQLite's Write-Ahead Logging (WAL) to allow readers to proceed while a writer is active.
4.  **Global Pool Registry**: Ensures that different subsystems (Evolution Store, JoyZoning, Gateway) share the _same_ pool and mutex when accessing a specific file.

---

## 🛠️ The Implementation: How it Works

### 1. Connection Lifecycle

The `SqliteConnectionPool` (`src/memory/sqlite-pool.ts`) initializes a pool of `DatabaseSync` connections. It defaults to a `poolSize` of 1 but can be tuned for high-volume environments.

### 2. Mandatory PRAGMAs

Every connection in the pool is initialized with strict architectural safeguards:

- `PRAGMA journal_mode = WAL;` (Concurrent read/write)
- `PRAGMA synchronous = NORMAL;` (Safe but faster commits)
- `PRAGMA busy_timeout = 5000;` (Wait up to 5s before failing if a lock is held)
- `PRAGMA foreign_keys = ON;` (Referential integrity)
- `PRAGMA temp_store = MEMORY;` (Faster temporary operations)

### 3. Queue-Based Write Mutex

Instead of relying on SQLite's internal locking (which can have "thundering herd" issues), we implement a fair, queue-based `WriteMutex` in TypeScript. This ensures that:

- Write requests are processed in the order they were received.
- The `SQLITE_BUSY` error is virtually eliminated by preventing concurrent write attempts from ever reaching the SQLite layer.

### 4. Master Connection

All write operations are routed exclusively through the first connection in the pool (`connections[0]`). This reduces file fragmentation and improves commit performance by keeping the WAL file state consistent.

### 5. Deterministic Addressing

The `getGlobalSqlitePool` utilityUses normalized, absolute paths as keys in a global map. If two separate modules ask for a pool at `~/.openclaw/evolution/strategic.sqlite`, they will always receive the **same** instance, ensuring perfect synchronization across the codebase.

---

## 📈 Impact on Development

- **Zero-Config Reliability**: No manual database tuning is required for multi-agent support.
- **Industrial Scalability**: The system can handle hundreds of concurrent read requests and a steady stream of writes without performance degradation.
- **Data Integrity**: By centralizing the write-mutex, the risk of database corruption due to concurrent file-level access is removed.
