#!/usr/bin/env bash
# Writes each config's local snapshot UUIDs and parent UUIDs to
# <output-folder>/local-<config>.json, for the dev API's delete check.
# Runs btrfs as root on the host, so the API container needs no extra privilege.
# Read-only: it never changes a snapshot.
#
# Runs after the backup links export, from snapshot-links-export.service.
#
# Usage: sudo ./scripts/export_local_links.sh <output-folder>
set -euo pipefail

OUT="${1:?usage: $0 <output-folder>}"
BTRFS="${BTRFS_BIN:-btrfs}"
ROOT_SNAPSHOTS="${ROOT_SNAPSHOTS:-/.snapshots}"
HOME_SNAPSHOTS="${HOME_SNAPSHOTS:-/home/.snapshots}"
SRC_SNAPSHOTS="${SRC_SNAPSHOTS:-/home/amitp/src/.snapshots}"

if [ -z "${EXPORT_SKIP_ROOT_CHECK:-}" ] && [ "$(id -u)" -ne 0 ]; then
  echo "run as root, for example with sudo" >&2
  exit 1
fi

mkdir -p "$OUT"

python3 - "$BTRFS" "$OUT" "$ROOT_SNAPSHOTS" "$HOME_SNAPSHOTS" "$SRC_SNAPSHOTS" <<'PY'
import datetime, json, os, re, subprocess, sys

btrfs, out, root_dir, home_dir, src_dir = sys.argv[1:]
configs = {"root": root_dir, "home": home_dir, "src": src_dir}
field = re.compile(r"^\s*(UUID|Parent UUID):\s*(\S+)")
stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")

def show(path):
    """UUID and parent UUID of one snapshot subvolume, from btrfs subvolume show."""
    text = subprocess.run([btrfs, "subvolume", "show", path], check=True,
                          capture_output=True, text=True).stdout
    found = {}
    for line in text.splitlines():
        m = field.match(line)
        if m:
            found[m.group(1)] = m.group(2)
    if "UUID" not in found:
        raise RuntimeError(f"no UUID in btrfs output for {path}")
    parent = found.get("Parent UUID", "-")
    return found["UUID"], None if parent == "-" else parent

for config, base in configs.items():
    if not os.path.isdir(base):
        # Keep the previous file: a missing snapshot folder is not "no snapshots".
        print(f"skip {config}: {base} is not a folder", file=sys.stderr)
        continue
    snapshots = {}
    for entry in sorted(os.listdir(base), key=lambda s: int(s) if s.isdigit() else -1):
        if not entry.isdigit():
            continue
        subvol = os.path.join(base, entry, "snapshot")
        if not os.path.isdir(subvol):
            continue
        uuid, parent_uuid = show(subvol)  # any failure stops the whole run before writing
        snapshots[entry] = {"uuid": uuid, "parentUuid": parent_uuid}
    doc = {"config": config, "exportedAt": stamp, "snapshots": snapshots}
    target = os.path.join(out, f"local-{config}.json")
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
    os.chmod(tmp, 0o644)
    os.replace(tmp, target)  # atomic: the API never reads a half-written file
    print(f"ok  {target}: {len(snapshots)} snapshot(s)")
PY
