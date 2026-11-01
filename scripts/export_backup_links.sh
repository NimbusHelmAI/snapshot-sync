#!/usr/bin/env bash
# Writes the parent links of each backup config to <output-folder>/<config>.json,
# for the dev API to read. Runs btrfs as root on the host, so the API container
# needs no extra privilege. Read-only on the backup disk; writes only the output folder.
#
# Run from root's crontab, for example every 5 minutes:
#   */5 * * * * /path/to/scripts/export_backup_links.sh /mnt/Backup /var/lib/snapshot-sync/links
#
# Usage: sudo ./scripts/export_backup_links.sh <backup-disk> <output-folder>
set -euo pipefail

DISK="${1:?usage: $0 <backup-disk> <output-folder>}"
OUT="${2:?usage: $0 <backup-disk> <output-folder>}"
BTRFS="${BTRFS_BIN:-btrfs}"
CONFIGS=(root home src)

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root, for example with sudo" >&2
  exit 1
fi
# EXPORT_SKIP_MOUNT_CHECK is for tests only; cron must not set it.
if [ -z "${EXPORT_SKIP_MOUNT_CHECK:-}" ] && ! mountpoint -q "$DISK"; then
  echo "$DISK is not mounted; keeping the previous links" >&2
  exit 1
fi

mkdir -p "$OUT"
LISTING="$(mktemp)"
trap 'rm -f "$LISTING"' EXIT
# -a: all subvolumes, -u: UUID, -q: parent UUID, -R: received UUID.
# If btrfs fails, set -e stops here and the previous JSON files stay as they are.
"$BTRFS" subvolume list -a -u -q -R "$DISK" > "$LISTING"

python3 - "$LISTING" "$DISK" "$OUT" "${CONFIGS[@]}" <<'PY'
import datetime, json, os, re, sys

listing, disk, out, *configs = sys.argv[1:]
row = re.compile(r"^ID \d+ .*?parent_uuid (\S+)\s+received_uuid (\S+)\s+uuid (\S+)\s+path (.+)$")
rows = []
with open(listing, encoding="utf-8") as f:
    for line in f:
        m = row.match(line.rstrip("\n"))
        if m:
            parent, _, uuid, subvol = m.groups()
            rows.append((uuid, None if parent == "-" else parent, subvol))

stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
for config in configs:
    member = re.compile(rf"(?:^|/){re.escape(config)}/(\d+)$")
    ids = {}      # uuid -> snapshot id, for this config only
    parents = {}  # snapshot id -> parent uuid
    for uuid, parent_uuid, subvol in rows:
        m = member.search(subvol)
        if m:
            ids[uuid] = m.group(1)
            parents[m.group(1)] = parent_uuid
    parent_of = {sid: (ids.get(pu) if pu else None) for sid, pu in parents.items()}
    doc = {"path": disk, "config": config, "exportedAt": stamp, "parentOf": parent_of}
    target = os.path.join(out, f"{config}.json")
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
    os.chmod(tmp, 0o644)
    os.replace(tmp, target)  # atomic: the API never reads a half-written file
    print(f"ok  {target}: {len(parent_of)} snapshot(s)")
PY
