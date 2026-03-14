# 🏗️ Engineering Pillars & Advanced Features

MarieCoder is built on three core technical pillars and advanced features that ensure architectural integrity, performance, and security.

## ✨ Core Pillars

### 🛡️ JoyZoning (Architectural Integrity)

Maintain absolute architectural purity. JoyZoning enforces strict layer boundaries and dependency rules in real-time. Using a "strike-based" system, it prevents architectural regressions and protects against library-boundary violations, ensuring your codebase evolves with integrity.

- **[Deep Dive: JoyZoning Architectural Design](../technical-design/joyzoning-architectural-integrity.md)**
- **Enforces Layer Boundaries**: Prevents business logic from leaking into UI components or database layers.
- **Dependency Guarding**: Blocks unauthorized third-party library injections in real-time.
- **Strike-Based Protection**: Identifies and halts regressive patterns before they reach your git history.

### 🧠 Skill Evolution (Adaptive Learning)

Driven by the `StrategicEvolutionStore`, the agent evolves its behavior based on your feedback:

- **[Deep Dive: Skill Evolution Strategy](../technical-design/skill-evolution-adaptive-learning.md)**
- **Metric Tracking**: Monitors sentiment, discovery rates, and tool success to refine its approach.
- **Autonomous Adaptation**: Dynamically adjusts tool parameters and execution strategies to minimize latency and maximize accuracy.
- **Persistent Memory**: Learns your project's nuances over time, becoming more efficient with every session.

### 🗄️ DBPooling (High-Performance SQLite)

Experience industrial-grade reliability with the `SqliteConnectionPool`:

- **[Deep Dive: DBPooling Concurrency Strategy](../technical-design/dbpooling-high-performance-persistence.md)**
- **Thread-Safe Concurrency**: Uses WAL (Write-Ahead Logging) for lightning-fast reads and writes.
- **Write-Mutex Serialization**: Guarantees data integrity during high-concurrency operations.
- **Atomic Persistence**: Ensures your agent's state and memory are never corrupted, even during hard restarts.

### 🤖 Existential Autonomy (Self-Regulating Substrate)

Marie's most advanced state: zero-touch engineering governed by systemic health and resource monitors.

- **[Deep Dive: Existential Autonomy Strategy](../design/existential-autonomy.md)**
- **Systemic Governance**: Autonomous load balancing that throttles activity based on CPU/Memory utilization.
- **Critique-Driven Remediation**: Self-correcting cycles that learn from failure without model escalation.
- **Health Steering**: Adaptive guardrails that respond to global systemic health metrics.
- **Zero-Touch Maintenance**: Self-healing builds and architectural deadlock resolution.

### 🥦 BroccoliDB (Versioned Reasoning & Memory)

OpenClaw's elite memory engine, BroccoliDB, introduces Merkle-tree persistence and versioned reasoning.

- **Merkle-Tree Branching**: Isolated, version-controlled context for sessions, enabling agents to explore branching hypotheses and isolated "what-if" scenarios.
- **Unified Knowledge Graph**: Semantic recall and graph traversal ensure deep, contextually relevant memory retrieval across long-running projects.
- **Audit & Reasoning Analysis**: Built-in `AuditService` proactively detects logical contradictions and enforces multi-turn alignment.
- **Broccoli Doctor**: Industrial-grade `DoctorService` monitors Merkle health, database integrity, and concurrency performance.
- **Auto-Recall & Swarm Claims**: Proactively injects historical context while using "swarm claims" to prevent file-editing conflicts in multi-agent environments.

---

## 🛠️ Advanced Features

### 🌐 ACP Topics (Agent Control Plane)

MarieCoder introduces **ACP Topics**, enabling persistent channel and thread bindings.

- **[Deep Dive: ACP Durable Routing Design](../technical-design/acp-topics-durable-agent-routing.md)**
- **Durable Routing**: Bind specific Discord channels or Telegram topics to dedicated agents.
- **Context Continuity**: Agent configurations and session states survive restarts, ensuring consistent behavior across distributed interfaces.

### 🔐 SecretRef Support

Enterprise-grade security for your credentials.

- **[Deep Dive: SecretRef Security Architecture](../technical-design/secretref-enterprise-security.md)**
- **Zero-Leaked Keys**: Support for `SecretRef` across 60+ credential targets.
- **Granular Management**: Use `openclaw secrets` to plan, apply, and audit your API keys and tokens without ever exposing them in plaintext configs.

---

## 🎨 Workspace & Customization

MarieCoder is highly customizable via your workspace configuration.

- **[Deep Dive: Workspace & Identity Strategy](../technical-design/workspace-customization-identity.md)**
- **Workspace Root:** `~/.openclaw/workspace` (configurable via `agents.defaults.workspace`).
- **Prompt Files:** You can inject custom behaviors by editing the following files in your workspace:
  - `AGENTS.md`: Defines the global agent personality and constraints.
  - `SOUL.md`: Deep identity and behavioral traits for the "Molty" space lobster persona.
  - `TOOLS.md`: Custom tool descriptions and execution hints.
- **Skills:** Add custom skills in `~/.openclaw/workspace/skills/<skill>/SKILL.md`.
