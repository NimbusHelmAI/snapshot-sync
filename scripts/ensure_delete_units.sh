#!/usr/bin/env bash
# Checks that this host can run queued snapshot deletes (NHA-107), and installs or
# repairs the delete units when it cannot. start-dev.sh runs it; it is also safe to
# run by hand. Run it as your own user: it calls sudo only when something must change.
#
# It checks that:
#   - the units are installed, and snapshot-delete.path is enabled and listening;
#   - the service runs the installed script, for this backup disk and delete folder;
#   - the installed script is identical to scripts/delete_requests.py in this checkout.
# Units that are missing or wrong are reinstalled with scripts/install_delete_units.sh.
# A host script that only differs is replaced after a yes, because the checkout being
# started may hold an experimental version.
#
# Usage: scripts/ensure_delete_units.sh [--backup-disk <path>] [--delete-dir <path>] [--yes]
#   --yes   replace a differing host script without asking
# Exit status: 0 when deletes can run, 1 when they cannot.
set -euo pipefail

BACKUP_DISK="/mnt/Backup"
DELETE_DIR="/var/lib/snapshot-sync/delete"
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --backup-disk) BACKUP_DISK="${2:?--backup-disk needs a path}"; shift 2 ;;
    --delete-dir) DELETE_DIR="${2:?--delete-dir needs a path}"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$REPO/scripts/delete_requests.py"
# UNIT_DIR and LIB_DIR can be overridden for tests only. The installer always uses
# the real locations.
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
LIB_DIR="${LIB_DIR:-/usr/local/lib/snapshot-sync}"
INSTALLED="$LIB_DIR/delete_requests.py"

PROBLEMS=()
check() {
  PROBLEMS=()
  local service="$UNIT_DIR/snapshot-delete.service"
  local path_unit="$UNIT_DIR/snapshot-delete.path"
  if [ ! -f "$service" ] || [ ! -f "$path_unit" ]; then
    PROBLEMS+=("the delete units are not installed")
    return 0
  fi
  grep -qxF "ExecStart=/usr/bin/python3 $INSTALLED --delete-dir $DELETE_DIR" "$service" \
    || PROBLEMS+=("the service does not run $INSTALLED with --delete-dir $DELETE_DIR")
  grep -qxF "Environment=BACKUP_DISK=$BACKUP_DISK" "$service" \
    || PROBLEMS+=("the service is not set up for the backup disk $BACKUP_DISK")
  grep -qxF "PathChanged=$DELETE_DIR/requests" "$path_unit" \
    || PROBLEMS+=("the path unit does not watch $DELETE_DIR/requests")
  [ -f "$INSTALLED" ] || PROBLEMS+=("the host script $INSTALLED is missing")
  if [ ! -d "$DELETE_DIR/requests" ] || [ ! -d "$DELETE_DIR/results" ]; then
    PROBLEMS+=("the folders $DELETE_DIR/requests and $DELETE_DIR/results are missing")
  fi
  systemctl is-enabled --quiet snapshot-delete.path 2>/dev/null \
    || PROBLEMS+=("snapshot-delete.path is not enabled")
  systemctl is-active --quiet snapshot-delete.path 2>/dev/null \
    || PROBLEMS+=("snapshot-delete.path is not listening")
  return 0
}

install_units() {
  echo "   running: sudo scripts/install_delete_units.sh (sudo may ask for your password)"
  sudo "$REPO/scripts/install_delete_units.sh" --backup-disk "$BACKUP_DISK" --delete-dir "$DELETE_DIR"
}

# Installs, then checks again. Deletes can run only if the second check is clean.
install_and_verify() {
  if ! install_units; then
    echo "❌ snapshot delete: the installer failed" >&2
    return 1
  fi
  check
  if [ ${#PROBLEMS[@]} -gt 0 ] || ! cmp -s "$SOURCE" "$INSTALLED"; then
    echo "❌ snapshot delete: still not ready after the install:" >&2
    [ ${#PROBLEMS[@]} -eq 0 ] || printf '   - %s\n' "${PROBLEMS[@]}" >&2
    cmp -s "$SOURCE" "$INSTALLED" || echo "   - $INSTALLED differs from $SOURCE" >&2
    return 1
  fi
  echo "✅ snapshot delete: units installed and listening, host script up to date"
}

[ -f "$SOURCE" ] || { echo "❌ snapshot delete: $SOURCE is missing" >&2; exit 1; }

check
if [ ${#PROBLEMS[@]} -gt 0 ]; then
  echo "⚠️  snapshot delete is not ready on this host:"
  printf '   - %s\n' "${PROBLEMS[@]}"
  install_and_verify || exit 1
  exit 0
fi

if ! cmp -s "$SOURCE" "$INSTALLED"; then
  echo "⚠️  snapshot delete: the host script differs from this checkout"
  echo "   installed: $INSTALLED"
  echo "   checkout:  $SOURCE"
  answer="n"
  if [ "$ASSUME_YES" = 1 ]; then
    answer="y"
  elif [ -t 0 ]; then
    read -r -p "   Replace the host script with the one in this checkout? [y/N] " answer || answer="n"
  fi
  case "$answer" in
    y|Y|yes|YES)
      install_and_verify || exit 1
      ;;
    *)
      echo "   keeping the installed host script; deletes run that version"
      ;;
  esac
  exit 0
fi

echo "✅ snapshot delete: units installed and listening, host script up to date"
