# 🛡️ Security Model & Architectural Safety

MarieCoder is designed with a **Trust-But-Verify** model. Since the agent can connect to real messaging surfaces, inbound data is treated as untrusted input.

## 🛡️ Key Security Features

### 1. Sandbox Mode

MarieCoder uses Docker to run non-main sessions in isolated containers.

- **Default:** Tools run on the host for the **main** session (trust level 1).
- **Non-Main Sessions:** For groups, public channels, or unknown senders, set `agents.defaults.sandbox.mode: "non-main"`. This runs the execution environment inside a per-session Docker sandbox.
- **Granular Controls:** You can independently allowlist/denylist tools like `bash`, `browser`, `canvas`, etc., per security profile.

### 2. DM Pairing (Anti-Spam/Auth)

Prevents unauthorized access on public channels (WhatsApp, Telegram, etc.) via a secure pairing protocol.

- **`pairing` Policy:** Unknown senders receive a short pairing code. MarieCoder will not process their messages until you approve.
- **Approval:** Approve with `openclaw pairing approve <channel> <code>`.
- **Allowlist:** Approved senders are added to a local store.

### 3. Elevated Access

Per-session toggles for host-level permissions are protected by **JoyZoning** policies.

- Use `/elevated on|off` to toggle permissions.
- Access is restricted to trusted/allowlisted users only.

### 4. SecretRef Protection

Enterprise-grade security ensuring API keys and tokens are never stored in plaintext within configuration files.

---

## 🏗️ Technical Implementation

- **Trust-But-Verify:** All inbound messages from public surfaces are quarantined or filtered unless they explicitly pass pairing/policy checks.
- **Durable Identity:** Agents use ACP Topics to maintain context safely across restarts without leaking session data.
- **Volume Isolation:** Docker containers use restricted mounts for `/home/node/.openclaw` to prevent host file system escalation.
