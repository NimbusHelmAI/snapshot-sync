#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# docker compose (v2) if present, otherwise the older docker-compose binary.
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
COMPOSE="$DC -f docker-compose.dev.yml"

# Backup disk on the host. Overridable; the same path is mounted into the API container.
export BACKUP_DISK="${BACKUP_DISK:-/mnt/Backup}"

# Settings, including the backup path, live in config.yml. Create it on first run.
[ -f config.yml ] || printf 'backupDisk: %s\n' "$BACKUP_DISK" > config.yml

echo "🧹 Cleaning up..."
pkill -f "vite\|ts-node\|nodemon" || true
$COMPOSE down --remove-orphans 2>/dev/null || true
sleep 2

echo "🧹 Clearing ports..."
# A port can be held by a root-owned process (a leftover docker-proxy, say), so
# sudo is used only for a busy port, and the script says which one.
for port in 3000 3001 3002; do
  if fuser "$port/tcp" >/dev/null 2>&1; then
    echo "   port $port is busy; stopping its process"
    sudo fuser -k "$port/tcp" >/dev/null 2>&1 || true
  fi
done
sleep 1

echo "✅ Starting API in Docker..."
# The API reads these host paths, so refuse to start without them rather
# than mount empty directories over them.
for p in /.snapshots /home/.snapshots /home/amitp/src/.snapshots; do
  [ -d "$p" ] || { echo "❌ $p is missing"; exit 1; }
done
mountpoint -q "$BACKUP_DISK" || echo "⚠️  $BACKUP_DISK is not mounted; the backup side will show no configs"
$COMPOSE up -d --build api
for i in $(seq 1 120); do
  curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1 || {
  echo "❌ API did not start:"; $COMPOSE logs --tail 40 api; exit 1; }
echo "API is up"

echo "✅ Starting frontend in Docker..."
$COMPOSE up -d --build web

echo ""
echo "🎉 Services ready:"
echo "   Frontend: http://localhost:3000"
echo "   Backend:  http://localhost:3001"
echo "   Ctrl-C stops both containers."
echo ""

trap '$COMPOSE stop >/dev/null 2>&1; exit 0' INT TERM
$COMPOSE logs -f
