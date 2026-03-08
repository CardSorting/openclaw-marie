#!/bin/bash
set -euo pipefail

# OpenClaw Docker Backup Tool
# Usage: ./scripts/docker-backup.sh [backup_file.tar.gz]

BACKUP_FILE="${1:-openclaw-backup-$(date +%Y%m%d-%H%M%S).tar.gz}"
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"

echo "==> OpenClaw Docker Backup"

if [ ! -d "$CONFIG_DIR" ]; then
    echo "ERROR: Config directory $CONFIG_DIR not found." >&2
    exit 1
fi

echo "==> Creating backup of $CONFIG_DIR to $BACKUP_FILE"

# Expose session locks and temporary files to exclude from backup
tar --exclude='*.lock' --exclude='tmp' -czf "$BACKUP_FILE" -C "$(dirname "$CONFIG_DIR")" "$(basename "$CONFIG_DIR")"

echo "==> Backup complete: $BACKUP_FILE"
echo "To restore: tar -xzf $BACKUP_FILE -C /path/to/restore"
