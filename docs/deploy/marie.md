# Hardened Marie Deployment Guide

This guide covers the deployment of a production-hardened Marie agent using Docker.

## Production Profile

The production environment is configured with the following hardening measures:

- **Multi-Stage Build**: Minimized image size and reduced attack surface.
- **Read-Only Root Filesystem**: The container filesystem is locked down.
- **Resource Limits**: CPU and memory limits are enforced via Docker Compose.
- **Non-Root Execution**: Runs as the `node` user with dropped capabilities.
- **JS Health Check**: Robust health monitoring via a dedicated internal probe.

## Advanced Security

The production deployment includes several "Double Down" security measures:

- **Custom Seccomp Profile**: Restricts host syscalls to the bare minimum required by Node.js.
- **PII Redaction**: Automatically scrubs emails and API keys from agent memory before persistence.
- **Deep Injection Scanning**: Active detection of many-shot jailbreaks and obfuscation attempts.
- **Network Isolation**: Uses internal Docker networks to prevent unnecessary exposure.
- **Persistent Security Audit**: All security violations and redactions are logged to `~/.openclaw/security/audit.sqlite` for long-term tracking.

## Quick Start (Production)

1. **Configure Environment**:
   Create a `.env` file with your production tokens:

   ```bash
   OPENCLAW_GATEWAY_TOKEN=your-secure-token
   OPENCLAW_CONFIG_DIR=./data/config
   OPENCLAW_WORKSPACE_DIR=./data/workspace
   ```

2. **Run Setup**:
   Use the hardened setup script:

   ```bash
   ./docker-setup.sh --prod
   ```

3. **Verify Security**:
   Check that the gateway is healthy and running in read-only mode:
   ```bash
   docker inspect --format='{{.State.Health.Status}}' openclaw-gateway
   ```

## Secrets Management

For maximum security, avoid plaintext tokens in `.env`. OpenClaw supports `SecretRef`:

- **Environment**: `${MY_SECRET_VAR}`
- **Files**: `{"source": "file", "provider": "default", "id": "/run/secrets/my_secret"}`

## Persistence

Marie's core identity (`MEMORY.md`, `USER.md`) is stored in the volume mounted to `/home/node/.openclaw`. Ensure this directory is backed up regularly.
