# 🌐 ACP Topics: Durable Agent Routing Strategy

## 🏗️ The Problem: The "Context-Free" Messaging Gap

Standard AI agents are often designed for a single conversation thread. However, when agents are deployed across diverse messaging surfaces (WhatsApp, Telegram, Slack, Discord), they need a way to maintain **Durable Identity** and **Topic Continuity**. A conversation in a specific WhatsApp group or a Discord thread must always map to the same logical agent, profile, and state—even after the Gateway service restarts.

## 🧠 The Theory: Agent Control Plane (ACP)

ACP Topics are based on the theory of **Decoupled Messaging Channels & Persistent Session Identification**. The Gateway acts as a "hub" for multiple concurrent logical agents. Instead of direct connections, messaging surfaces communicate via a "Control Plane" that routes inbound messages to the correct logical topic.

### Core Principles

1.  **Durable Routing**: Every conversation thread is uniquely bound to an "ACP Topic," which persists in the session store.
2.  **Session Isolation**: Each topic has its own logical `AgentId`, `Config Profile`, and `Thinking Level`.
3.  **Cross-Surface Uniformity**: Whether you talk to an agent on Telegram or WebChat, the agent's behavior and context are consistent if they are bound to the same topic.
4.  **Runtime-Agnostic Execution**: The ACP can bridge to different execution environments (local shells, Docker sandboxes, remote nodes) without changing the message routing logic.

---

## 🛠️ The Implementation: How it Works

### 1. The ACP Session Manager

The `AcpSessionManager` (`src/acp/control-plane/manager.core.ts`) is the brain of the Control Plane. It manages the lifecycle of every active agent topic, including:

- **Initialization**: Setting up a new durable topic with a specific backend (e.g., Docker) and agent profile.
- **Routing**: Mapping inbound message IDs (e.g., a WhatsApp message from a specific sender) to its corresponding ACP Topic.
- **Lifecycle Control**: Suspending, resuming, or closing agent sessions to conserve system resources.

### 2. Topic Persistence & Reconciliation

On startup, the manager performs **Identity Reconciliation**. It scans the persistent session store for topics that have "Pending" identities (e.g., sessions created while the system was offline) and automatically restores their bindings. This ensures that an agent never "forgets" who it's talking to.

### 3. Queue-Based Actor Model

To prevent race conditions, every ACP Topic operates as an **Actor**. Inbound messages for a specific topic are queued and processed sequentially. This prevents the "thundering herd" effect where multiple messages in the same thread cause the agent to conflict with its own state.

### 4. Advanced Runtime Controls

Through the ACP, developers can send "Control Messages" to specific topics:

- **`session/set_mode`**: Dynamically toggle between `oneshot` (single-turn) and `persistent` modes.
- **`session/set_config_option`**: Update agent-specific settings (like `thinkingLevel` or `verboseMode`) on-the-fly without restarting the Gateway.

### 5. Observability & Performance

The ACP provides a detailed "Observability Snapshot," tracking:

- **Average & Max Turn Latency**: How long the agent takes to respond per-topic.
- **Queue Depth**: How many messages are waiting to be processed across all active topics.
- **Runtime Cache Health**: How many idle sessions are being managed and when they are evicted.

---

## 📈 Impact on Development

- **Distributed Collaboration**: Multiple agents can work on the same project via different messaging surfaces.
- **High Reliability**: Critical conversation context is never lost during service restarts.
- **Seamless Scaling**: The Actor model and Runtime Cache allow a single Gateway to manage hundreds of concurrent agent topics with minimal overhead.
