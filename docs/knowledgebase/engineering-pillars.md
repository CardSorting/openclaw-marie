# 🏗️ Engineering Pillars & Advanced Features

MarieCoder is built on three core technical pillars and advanced features that ensure architectural integrity, performance, and security.

## ✨ Core Pillars

### 🛡️ JoyZoning (Architectural Integrity)

Maintain absolute architectural purity. JoyZoning enforces strict layer boundaries and dependency rules in real-time. Using a "strike-based" system, it prevents architectural regressions and protects against library-boundary violations, ensuring your codebase evolves with integrity.

- **Enforces Layer Boundaries**: Prevents business logic from leaking into UI components or database layers.
- **Dependency Guarding**: Blocks unauthorized third-party library injections in real-time.
- **Strike-Based Protection**: Identifies and halts regressive patterns before they reach your git history.

### 🧠 Skill Evolution (Adaptive Learning)

Driven by the `StrategicEvolutionStore`, the agent evolves its behavior based on your feedback:

- **Metric Tracking**: Monitors sentiment, discovery rates, and tool success to refine its approach.
- **Autonomous Adaptation**: Dynamically adjusts tool parameters and execution strategies to minimize latency and maximize accuracy.
- **Persistent Memory**: Learns your project's nuances over time, becoming more efficient with every session.

### 🗄️ DBPooling (High-Performance SQLite)

Experience industrial-grade reliability with the `SqliteConnectionPool`:

- **Thread-Safe Concurrency**: Uses WAL (Write-Ahead Logging) for lightning-fast reads and writes.
- **Write-Mutex Serialization**: Guarantees data integrity during high-concurrency operations.
- **Atomic Persistence**: Ensures your agent's state and memory are never corrupted, even during hard restarts.

---

## 🛠️ Advanced Features

### 🌐 ACP Topics (Agent Control Plane)

MarieCoder introduces **ACP Topics**, enabling persistent channel and thread bindings.

- **Durable Routing**: Bind specific Discord channels or Telegram topics to dedicated agents.
- **Context Continuity**: Agent configurations and session states survive restarts, ensuring consistent behavior across distributed interfaces.

### 🔐 SecretRef Support

Enterprise-grade security for your credentials.

- **Zero-Leaked Keys**: Support for `SecretRef` across 60+ credential targets.
- **Granular Management**: Use `openclaw secrets` to plan, apply, and audit your API keys and tokens without ever exposing them in plaintext configs.

---

## 🎨 Workspace & Customization

MarieCoder is highly customizable via your workspace configuration.

- **Workspace Root:** `~/.openclaw/workspace` (configurable via `agents.defaults.workspace`).
- **Prompt Files:** You can inject custom behaviors by editing the following files in your workspace:
  - `AGENTS.md`: Defines the global agent personality and constraints.
  - `SOUL.md`: Deep identity and behavioral traits for the "Molty" space lobster persona.
  - `TOOLS.md`: Custom tool descriptions and execution hints.
- **Skills:** Add custom skills in `~/.openclaw/workspace/skills/<skill>/SKILL.md`.
