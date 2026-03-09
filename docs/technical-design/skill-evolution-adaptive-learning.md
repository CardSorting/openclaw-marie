# 🧬 Skill Evolution: Adaptive Learning Strategy

## 🏗️ The Problem: Static Agent Reasoning

Standard AI agents are often "static"—they start every session with the same base knowledge and reasoning patterns. They don't learn from their mistakes or project-specific nuances unless manually prompted. This leads to redundant errors, high latency, and a "reset" effect every time the agent's context window fills up.

## 🧠 The Theory: Empirical Reinforcement Learning

Skill Evolution is built on the theory of **Continuous Behavioral Adaptation**. By treating an agent as a "living" entity, we can track its successes and failures over time. Instead of just "executing," the agent "evolves" its approach based on project-specific metrics.

### Core Principles

1.  **Metric-Driven Meta-Cognition**: The agent tracks its own performance (latency, user sentiment, discovery rate) to identify which tools or paths are the most efficient.
2.  **Stateful Memory Persistence**: Unlike "oneshot" agents, Skill Evolution maintains a long-term "Strategic Evolution Store" in SQLite that survives process restarts.
3.  **Cross-Session Correlation**: The agent correlates past terminal command history and user feedback to refine its "vibe" and tool-selection strategy.

---

## 🛠️ The Implementation: How it Works

### 1. Empirical Metric Tracking

The `StrategicEvolutionStore` in `src/agents/strategic-evolution-store.ts` manages a dedicated SQLite database (`strategic.sqlite`) to store:

- **Sentiment**: Captures user reactions to agent responses.
- **Discovery**: Tracks how many new areas of the codebase the agent correctly identified.
- **Latency**: Measures tool execution speeds to optimize for performance.
- **Success Rate**: Records which tool calls led to a desired outcome.

### 2. Line-Level Recall Hits

The system tracks `sev_recall_hits`—indexing the most effective reasoning steps and code blocks. When an agent "recalls" a successful pattern, the hit count increases. This allows the system to prioritize high-confidence behaviors in future sessions.

### 3. Bash & Command Analysis

Every terminal command executed through `openclaw` is recorded in `sev_bash_history`. The system tracks:

- **Context (CWD)**: Where the command was run.
- **Exit Status**: Whether it succeeded or failed.
- **Output Profiles**: How much output was generated and if it was truncated.
- **Pattern Recognition**: Over time, the agent learns that certain commands (like `npm install`) are "heavy" and should be run with specific flags in its current environment.

### 4. Statistical Distributions

The store doesn't just return raw data; it calculates **Mean**, **Standard Deviation**, and **Count** for metrics. This provides the agent with a "statistical intuition" about its own capabilities. If its "latency" for a specific tool is high, it may autonomously choose a more lightweight alternative.

### 5. Session State Persistence

The `sev_session_state` table stores per-agent logical flags. These are injected into the agent's environment, allowing it to "remember" its current project-wide objectives and preferred tools across multiple disconnected turns.

---

## 📈 Impact on Development

- **Reduced Redundancy**: The agent stops making the same mistakes once it "learns" a project's constraints.
- **Optimized Performance**: Latency-heavy tools are used more sparingly or with better parameters.
- **Deep Personalization**: The more you use MarieCoder, the more it aligns with your specific coding style and environment.
