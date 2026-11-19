#!/usr/bin/env bash
# Installs the snapshot delete units and creates the request and result folders.
# It copies scripts/delete_requests.py to /usr/local/lib/snapshot-sync, and the
# service runs that copy, so the host does not depend on this checkout.
# Run on the host, as root, from the repo. Re-running it is safe, and it is how
# the host script is updated after delete_requests.py changes.
#
# Usage: sudo ./scripts/install_delete_units.sh [--backup-disk <path>] [--delete-dir <path>]
# Defaults: backup disk /mnt/Backup, delete folder /var/lib/snapshot-sync/delete.
set -euo pipefail

BACKUP_DISK="/mnt/Backup"
DELETE_DIR="/var/lib/snapshot-sync/delete"
while [ $# -gt 0 ]; do
  case "$1" in
    --backup-disk) BACKUP_DISK="${2:?--backup-disk needs a path}"; shift 2 ;;
    --delete-dir) DELETE_DIR="${2:?--delete-dir needs a path}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root, for example with sudo" >&2
  exit 1
fi
case "$BACKUP_DISK" in /*) ;; *) echo "--backup-disk must be an absolute path" >&2; exit 2 ;; esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
UNITS="$REPO/scripts/systemd"
LIB_DIR="/usr/local/lib/snapshot-sync"
SCRIPT="$LIB_DIR/delete_requests.py"

mkdir -p "$DELETE_DIR/requests" "$DELETE_DIR/results"
chmod 0755 "$DELETE_DIR"

# The service runs a root-owned copy of the script, never a file in a checkout:
# a checkout can be deleted or switched to another branch, and its owner can edit it.
install -d -o root -g root -m 0755 "$LIB_DIR"
install -o root -g root -m 0755 "$REPO/scripts/delete_requests.py" "$SCRIPT"

fill() {
  sed -e "s#@SCRIPT@#$SCRIPT#g" -e "s#@BACKUP_DISK@#$BACKUP_DISK#g" -e "s#@DELETE_DIR@#$DELETE_DIR#g" "$1"
}
fill "$UNITS/snapshot-delete.service" > /etc/systemd/system/snapshot-delete.service
fill "$UNITS/snapshot-delete.path" > /etc/systemd/system/snapshot-delete.path
chmod 0644 /etc/systemd/system/snapshot-delete.service /etc/systemd/system/snapshot-delete.path

systemctl daemon-reload
systemctl enable --now snapshot-delete.path
echo "installed: snapshot-delete.path is watching $DELETE_DIR/requests"
echo "backup disk: $BACKUP_DISK"
echo "host script: $SCRIPT (copied from $REPO)"
