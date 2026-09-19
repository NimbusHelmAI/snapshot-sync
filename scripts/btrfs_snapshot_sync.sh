#!/usr/bin/env bash
#
# btrfs_snapshot_sync.sh
#
# For a start: transfers the 5 OLDEST not-yet-synced snapshots for each of
# several snapper configurations (root, home, src) from local Btrfs
# snapshot directories to an external Btrfs disk, using incremental
# send/receive where possible. Verifies each transfer and writes a report.
#
# Requirements:
#   - Destination must already be a mounted Btrfs filesystem.
#   - Run as root.
#
# Usage:
#   sudo ./btrfs_snapshot_sync.sh <dest_root_on_external_disk>
#
set -euo pipefail

DEST_ROOT="${1:?Usage: $0 <dest_root_on_external_btrfs>}"

# ---------------------------------------------------------------------
# EDIT THESE to match your actual snapper snapshot directories.
# Each entry: name -> source directory containing <id>/snapshot subvols.
# ---------------------------------------------------------------------
declare -A CONFIGS=(
  [root]="/.snapshots"
  [home]="/home/.snapshots"
  [src]="/home/amitp/src/.snapshots"
)

N_OLDEST=5

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "must run as root (sudo)."
command -v btrfs >/dev/null || die "btrfs-progs not installed."
[[ -d "$DEST_ROOT" ]] || die "destination '$DEST_ROOT' does not exist (mount external disk first)."

HAVE_PV=1
if ! command -v pv >/dev/null; then
  HAVE_PV=0
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] NOTE: 'pv' not installed — progress bar disabled." \
       "Install with: sudo dnf install pv   (falling back to verbose send/receive logging only)" >&2
fi

DEST_FSTYPE=$(findmnt -no FSTYPE --target "$DEST_ROOT") || die "cannot stat filesystem of '$DEST_ROOT'."
[[ "$DEST_FSTYPE" == "btrfs" ]] || die "destination '$DEST_ROOT' is '$DEST_FSTYPE', not btrfs."

# Synced snapshots live in their own subtree, <dest>/snapshots/<config>/<id>,
# rather than directly off the disk root. The root also holds unrelated
# directories -- <dest>/src is a flat copy of the source tree this script never
# wrote -- and without a namespace there is no way to tell the two apart.
# Must stay in step with BACKUP_SUBDIR in backend/src/server.ts.
SNAPSHOT_SUBDIR="snapshots"

REPORT_DIR="${DEST_ROOT}/reports"
mkdir -p "$REPORT_DIR"
REPORT_FILE="${REPORT_DIR}/sync_report_$(date '+%Y%m%d_%H%M%S').md"

{
  echo "# Btrfs Snapshot Sync Report"
  echo
  echo "Run: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "Destination: ${DEST_ROOT}"
  echo
} > "$REPORT_FILE"

is_ro_subvol() {
  btrfs property get -ts "$1" ro 2>/dev/null | grep -q "ro=true"
}

get_subvol_uuid() {
  btrfs subvolume show "$1" 2>/dev/null | awk -F':' '/^[ \t]*UUID:/{v=$2; gsub(/^[ \t]+|[ \t]+$/,"",v); print v; exit}'
}

get_received_uuid() {
  btrfs subvolume show "$1" 2>/dev/null | awk -F':' '/^[ \t]*Received UUID:/{v=$2; gsub(/^[ \t]+|[ \t]+$/,"",v); print v; exit}'
}

get_size_bytes() {
  du -sb --apparent-size "$1" 2>/dev/null | awk '{print $1}'
}

get_file_count() {
  find "$1" -xdev | wc -l
}

# Resolve the standalone symlink-generator script — expected alongside this
# script, or in PATH as a fallback.
SYMLINK_SCRIPT="$(dirname "$(readlink -f "$0")")/generate_snapshot_link.sh"
if [[ ! -x "$SYMLINK_SCRIPT" ]]; then
  SYMLINK_SCRIPT="$(command -v generate_snapshot_link.sh || true)"
fi
if [[ -z "$SYMLINK_SCRIPT" ]]; then
  echo "WARNING: generate_snapshot_link.sh not found (checked script dir and PATH)." \
       "Snapshots will sync fine, but 'latest'/'by-date' symlinks won't be created." >&2
fi

# Runs btrfs send | [pv] | btrfs receive with verbose output and a progress
# indicator. Prints estimated size up front, then streams send/receive's own
# per-file "-v" output plus pv's live byte-count/rate/percentage line.
# Args: parent_snap (or "" for full send), src_snap, dest_dir
run_send_receive() {
  local parent="$1" src="$2" dest="$3"
  local est_size
  est_size=$(get_size_bytes "$src")
  log "  estimated size: $((est_size / 1024 / 1024)) MiB (source subvolume apparent size)"

  if [[ "$HAVE_PV" -eq 1 ]]; then
    if [[ -n "$parent" ]]; then
      log "  running: btrfs send -v -p <parent> | pv | btrfs receive -v"
      btrfs send -v -p "$parent" "$src" 2> >(sed 's/^/    [send] /' >&2) \
        | pv -pterb -s "$est_size" 2> >(sed 's/^/    [progress] /' >&2) \
        | btrfs receive -v "$dest" 2> >(sed 's/^/    [receive] /' >&2)
    else
      log "  running: btrfs send -v | pv | btrfs receive -v"
      btrfs send -v "$src" 2> >(sed 's/^/    [send] /' >&2) \
        | pv -pterb -s "$est_size" 2> >(sed 's/^/    [progress] /' >&2) \
        | btrfs receive -v "$dest" 2> >(sed 's/^/    [receive] /' >&2)
    fi
  else
    if [[ -n "$parent" ]]; then
      log "  running: btrfs send -v -p <parent> | btrfs receive -v  (install 'pv' for a progress bar)"
      btrfs send -v -p "$parent" "$src" 2> >(sed 's/^/    [send] /' >&2) \
        | btrfs receive -v "$dest" 2> >(sed 's/^/    [receive] /' >&2)
    else
      log "  running: btrfs send -v | btrfs receive -v  (install 'pv' for a progress bar)"
      btrfs send -v "$src" 2> >(sed 's/^/    [send] /' >&2) \
        | btrfs receive -v "$dest" 2> >(sed 's/^/    [receive] /' >&2)
    fi
  fi
}

# Sanity-check a completed transfer. Returns 0 (pass) or 1 (fail) and
# appends details to the report.
sanity_check() {
  local src="$1" dest="$2" label="$3"
  local pass=1
  {
    echo "  - Sanity check for **${label}**:"
  } >> "$REPORT_FILE"

  # 1. Destination subvolume exists and is read-only.
  if [[ -d "$dest" ]] && is_ro_subvol "$dest"; then
    echo "    - [OK] destination exists and is read-only subvolume" >> "$REPORT_FILE"
  else
    echo "    - [FAIL] destination missing or not read-only" >> "$REPORT_FILE"
    pass=0
  fi

  # 2. Received UUID on destination must match source's own UUID —
  #    this is the authoritative proof btrfs receive completed correctly
  #    (btrfs stamps the source UUID into the new subvol's Received UUID).
  local src_uuid dest_recv_uuid
  src_uuid=$(get_subvol_uuid "$src" || true)
  dest_recv_uuid=$(get_received_uuid "$dest" || true)
  if [[ -n "$src_uuid" && "$src_uuid" == "$dest_recv_uuid" ]]; then
    echo "    - [OK] Received UUID matches source UUID (${src_uuid})" >> "$REPORT_FILE"
  else
    echo "    - [FAIL] UUID mismatch (source=${src_uuid:-<none>} received=${dest_recv_uuid:-<none>})" >> "$REPORT_FILE"
    pass=0
  fi

  # 3. File count matches between source and destination.
  local src_count dest_count
  src_count=$(get_file_count "$src")
  dest_count=$(get_file_count "$dest")
  if [[ "$src_count" == "$dest_count" ]]; then
    echo "    - [OK] file count matches (${src_count})" >> "$REPORT_FILE"
  else
    echo "    - [FAIL] file count mismatch (source=${src_count} dest=${dest_count})" >> "$REPORT_FILE"
    pass=0
  fi

  # 4. Apparent size matches between source and destination.
  local src_size dest_size
  src_size=$(get_size_bytes "$src")
  dest_size=$(get_size_bytes "$dest")
  if [[ "$src_size" == "$dest_size" ]]; then
    echo "    - [OK] size matches (${src_size} bytes)" >> "$REPORT_FILE"
  else
    echo "    - [FAIL] size mismatch (source=${src_size} dest=${dest_size} bytes)" >> "$REPORT_FILE"
    pass=0
  fi

  return $((1 - pass))
}

TOTAL_SENT=0
TOTAL_FAILED=0

for cfg_name in "${!CONFIGS[@]}"; do
  src_root="${CONFIGS[$cfg_name]}"
  cfg_dest_root="${DEST_ROOT}/${SNAPSHOT_SUBDIR}/${cfg_name}"
  mkdir -p "$cfg_dest_root"
  state_file="${cfg_dest_root}/.last_synced_snapshot"

  echo "## Config: ${cfg_name} (source: ${src_root})" >> "$REPORT_FILE"
  echo >> "$REPORT_FILE"

  if [[ ! -d "$src_root" ]]; then
    log "Config '${cfg_name}': source '${src_root}' not found, skipping."
    echo "- source directory not found, skipped." >> "$REPORT_FILE"
    echo >> "$REPORT_FILE"
    continue
  fi

  # Oldest-first, read-only subvols only.
  mapfile -t all_snaps < <(find "$src_root" -mindepth 2 -maxdepth 2 -type d -name snapshot | sort -V)

  to_send=()
  for s in "${all_snaps[@]}"; do
    snap_id=$(basename "$(dirname "$s")")
    if [[ -d "${cfg_dest_root}/${snap_id}" ]]; then
      continue   # already synced
    fi
    is_ro_subvol "$s" || continue
    to_send+=("$s")
    [[ ${#to_send[@]} -ge $N_OLDEST ]] && break
  done

  if [[ ${#to_send[@]} -eq 0 ]]; then
    log "Config '${cfg_name}': nothing new to send (already synced or none found)."
    echo "- nothing new to send." >> "$REPORT_FILE"
    echo >> "$REPORT_FILE"
    continue
  fi

  last_synced=""
  [[ -f "$state_file" ]] && last_synced=$(cat "$state_file")

  for snap in "${to_send[@]}"; do
    snap_id=$(basename "$(dirname "$snap")")
    dest_target="${cfg_dest_root}/${snap_id}"

    log "[${cfg_name}] sending snapshot ${snap_id} ..."
    start_ts=$(date +%s)

    if [[ -n "$last_synced" && -d "${cfg_dest_root}/$(basename "$(dirname "$last_synced")")" ]]; then
      if run_send_receive "$last_synced" "$snap" "$cfg_dest_root"; then
        send_mode="incremental"
      else
        log "[${cfg_name}] send/receive FAILED for ${snap_id}."
        echo "- **${snap_id}**: send/receive FAILED (incremental)" >> "$REPORT_FILE"
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
        continue
      fi
    else
      if run_send_receive "" "$snap" "$cfg_dest_root"; then
        send_mode="full"
      else
        log "[${cfg_name}] send/receive FAILED for ${snap_id}."
        echo "- **${snap_id}**: send/receive FAILED (full)" >> "$REPORT_FILE"
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
        continue
      fi
    fi

    if [[ -d "${cfg_dest_root}/snapshot" && ! -d "$dest_target" ]]; then
      mv "${cfg_dest_root}/snapshot" "$dest_target"
    fi

    elapsed=$(( $(date +%s) - start_ts ))
    size_bytes=$(get_size_bytes "$dest_target")
    echo "- **${snap_id}** (${send_mode} send, ${elapsed}s, $((size_bytes / 1024 / 1024)) MiB):" >> "$REPORT_FILE"

    if sanity_check "$snap" "$dest_target" "$cfg_name/${snap_id}"; then
      log "[${cfg_name}] ${snap_id}: OK"
      TOTAL_SENT=$((TOTAL_SENT + 1))
      echo "$snap" > "$state_file"
      last_synced="$snap"

      # Preserve snapper's own metadata (true creation date, description,
      # cleanup type) since btrfs send/receive does NOT carry this over —
      # the destination's own "Creation time" reflects receive time, not
      # when snapper actually took the snapshot.
      src_info="$(dirname "$snap")/info.xml"
      if [[ -f "$src_info" ]]; then
        cp "$src_info" "${cfg_dest_root}/${snap_id}.info.xml"
      fi

      if [[ -n "$SYMLINK_SCRIPT" ]]; then
        "$SYMLINK_SCRIPT" "$cfg_dest_root" "$snap_id" "${cfg_dest_root}/${snap_id}.info.xml"
      fi
    else
      log "[${cfg_name}] ${snap_id}: SANITY CHECK FAILED — leaving state file untouched."
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
    fi
    echo >> "$REPORT_FILE"
  done
done

{
  echo "## Summary"
  echo
  echo "- Snapshots transferred and verified: ${TOTAL_SENT}"
  echo "- Snapshots failed (send or sanity check): ${TOTAL_FAILED}"
} >> "$REPORT_FILE"

log "Done. Transferred: ${TOTAL_SENT}, Failed: ${TOTAL_FAILED}"
log "Report: ${REPORT_FILE}"

[[ "$TOTAL_FAILED" -eq 0 ]]
