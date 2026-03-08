#!/bin/sh
set -e

# --- Environment Defaults ---
export DOCKER_ENV=1
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
export OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-18790}"
export OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
export OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-/home/node/.openclaw}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/home/node/.openclaw/workspace}"

BOOTSTRAP_LOCK="$OPENCLAW_CONFIG_DIR/.bootstrapping"
touch "$BOOTSTRAP_LOCK"

# --- Resource Monitoring ---
MEM_TOTAL_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}' || echo "0")
if [ "$MEM_TOTAL_KB" -gt 0 ] && [ "$MEM_TOTAL_KB" -lt 1500000 ]; then
    echo "WARNING: System memory is low (${MEM_TOTAL_KB}KB). OpenClaw and its agents may be unstable."
fi

# --- Load internal .env ---
if [ -f "$OPENCLAW_CONFIG_DIR/.env" ]; then
    echo "==> Loading environment from $OPENCLAW_CONFIG_DIR/.env"
    # shellcheck disable=SC2046
    export $(grep -v '^#' "$OPENCLAW_CONFIG_DIR/.env" | xargs)
fi

# --- Tailscale Detect ---
# If Tailscale sidecar is present in the same network namespace and has an IP,
# we might want to bind to it by default if requested.
if [ "$OPENCLAW_GATEWAY_BIND" = "lan" ] && ip addr show tailscale0 >/dev/null 2>&1; then
    echo "==> Tailscale detected. Using 'tailnet' bind mode for remote access."
    export OPENCLAW_GATEWAY_BIND="tailnet"
fi

# --- Permission Fixes ---
if [ "$(id -u)" = '0' ]; then
    echo "==> Adjusting permissions for $OPENCLAW_CONFIG_DIR"
    mkdir -p "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR"
    chown -R node:node "$OPENCLAW_CONFIG_DIR"
    exec gosu node "$0" "$@"
fi

# --- Validation ---
if [ -n "$OPENCLAW_GATEWAY_TOKEN" ] && [ ${#OPENCLAW_GATEWAY_TOKEN} -lt 16 ]; then
    echo "WARNING: OPENCLAW_GATEWAY_TOKEN is very short (< 16 chars). Consider a stronger token."
fi

# --- Bootstrapping ---
echo "==> Bootstrapping OpenClaw environment"

# Generate Gateway Token if missing
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
    CONFIG_TOKEN=$(node -e "
        try {
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_CONFIG_DIR/openclaw.json', 'utf8'));
            console.log(cfg?.gateway?.auth?.token || '');
        } catch (e) { console.log(''); }
    ")
    if [ -n "$CONFIG_TOKEN" ]; then
        export OPENCLAW_GATEWAY_TOKEN="$CONFIG_TOKEN"
        echo "Reusing gateway token from config."
    else
        export OPENCLAW_GATEWAY_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
        echo "Generated new OPENCLAW_GATEWAY_TOKEN."
    fi
fi

# Generate Age Secret Key if missing
if [ -z "$OPENCLAW_AGE_SECRET_KEY" ]; then
    if command -v age-keygen >/dev/null 2>&1; then
        export OPENCLAW_AGE_SECRET_KEY=$(age-keygen 2>/dev/null | grep "^AGE-SECRET-KEY-" || echo "")
    fi
    if [ -z "$OPENCLAW_AGE_SECRET_KEY" ]; then
        export OPENCLAW_AGE_SECRET_KEY="AGE-SECRET-KEY-$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")"
        echo "Generated fallback OPENCLAW_AGE_SECRET_KEY."
    else
        echo "Generated new OPENCLAW_AGE_SECRET_KEY via age-keygen."
    fi
fi

# Seed initial configuration if missing
if [ ! -f "$OPENCLAW_CONFIG_DIR/openclaw.json" ]; then
    echo "==> Seeding initial configuration"
    node openclaw.mjs onboard --mode local --no-install-daemon --token "$OPENCLAW_GATEWAY_TOKEN"
fi

# Ensure workspace structure
mkdir -p "$OPENCLAW_CONFIG_DIR/identity"
mkdir -p "$OPENCLAW_CONFIG_DIR/agents/main/agent"
mkdir -p "$OPENCLAW_CONFIG_DIR/agents/main/sessions"

rm -f "$BOOTSTRAP_LOCK"
echo "==> OpenClaw is ready"
echo "Gateway Token: $OPENCLAW_GATEWAY_TOKEN"
echo "------------------------------------------------"

# --- Execute CMD ---
exec node openclaw.mjs "$@"
