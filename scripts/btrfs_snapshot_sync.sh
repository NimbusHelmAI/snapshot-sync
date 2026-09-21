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
#   sudo ./btrfs_snapshot_sync.sh [--dry-run] <dest_root_on_external_disk>
#
# --dry-run walks the entire decision path -- which snapshots are due, which
# parent each incremental would use, what to do about an orphaned landing
# subvolume -- and writes a report, without invoking send/receive. A real run
# takes hours, so this is the only practical way to verify a change to this
# script before trusting it with a transfer.
#
set -euo pipefail

DRY_RUN=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help)
      echo "Usage: $0 [--dry-run] <dest_root_on_external_btrfs>"
      exit 0
      ;;
    -*) echo "ERROR: unknown option: $arg" >&2; exit 2 ;;
    *)  POSITIONAL+=("$arg") ;;
  esac
done
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

DEST_ROOT="${1:?Usage: $0 [--dry-run] <dest_root_on_external_btrfs>}"

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

RUN_STAMP=$(date '+%Y%m%d_%H%M%S')

REPORT_DIR="${DEST_ROOT}/reports"
mkdir -p "$REPORT_DIR"
if [[ "$DRY_RUN" -eq 1 ]]; then
  REPORT_FILE="${REPORT_DIR}/sync_report_${RUN_STAMP}_dryrun.md"
else
  REPORT_FILE="${REPORT_DIR}/sync_report_${RUN_STAMP}.md"
fi

# btrfs send and receive write their diagnostics to stderr. Previously that
# output scrolled past the terminal and was discarded, so five consecutive
# failed runs recorded "FAILED" without once recording why. Keep it.
LOG_DIR="${REPORT_DIR}/logs/${RUN_STAMP}"
if [[ "$DRY_RUN" -eq 0 ]]; then
  mkdir -p "$LOG_DIR"
fi

{
  echo "# Btrfs Snapshot Sync Report"
  echo
  echo "Run: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "Destination: ${DEST_ROOT}"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Mode: **DRY RUN** — no data was transferred."
  fi
  echo "Logs: ${LOG_DIR}"
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

# Appends the tail of a captured stderr log to the report, and echoes it to
# the terminal. Silent when the log is empty.
emit_log_tail() {
  local what="$1" file="$2"
  [[ -s "$file" ]] || return 0
  {
    echo "    - ${what} stderr (last 15 lines; full log: \`${file}\`):"
    echo '      ```'
    tail -n 15 "$file" | sed 's/^/      /'
    echo '      ```'
  } >> "$REPORT_FILE"
  echo "    [${what}] $(tail -n 5 "$file" | tr '\n' ' ')" >&2
}

# Runs btrfs send | [pv] | btrfs receive.
#
# send and receive stderr go to files under LOG_DIR rather than through a
# process substitution to the terminal: on failure the report needs the actual
# btrfs error, and a process substitution gives no guarantee the text has been
# flushed by the time the pipeline exits. pv keeps the terminal so the progress
# bar still works. The verbose per-file output is no longer shown live, but it
# is now preserved instead of discarded -- `tail -f` the log to watch it.
#
# Args: parent_snap (or "" for full send), src_snap, dest_dir, label
run_send_receive() {
  local parent="$1" src="$2" dest="$3" label="$4"
  local est_size send_log recv_log rc
  est_size=$(get_size_bytes "$src")
  log "  estimated size: $((est_size / 1024 / 1024)) MiB (source subvolume apparent size)"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ -n "$parent" ]]; then
      log "  [dry-run] would send incrementally, parent: ${parent}"
    else
      log "  [dry-run] would send in full (no usable parent)"
    fi
    return 0
  fi

  send_log="${LOG_DIR}/${label}.send.log"
  recv_log="${LOG_DIR}/${label}.receive.log"
  rc=0

  if [[ "$HAVE_PV" -eq 1 ]]; then
    if [[ -n "$parent" ]]; then
      log "  running: btrfs send -v -p <parent> | pv | btrfs receive -v"
      btrfs send -v -p "$parent" "$src" 2>"$send_log" \
        | pv -pterb -s "$est_size" \
        | btrfs receive -v "$dest" 2>"$recv_log" || rc=$?
    else
      log "  running: btrfs send -v | pv | btrfs receive -v"
      btrfs send -v "$src" 2>"$send_log" \
        | pv -pterb -s "$est_size" \
        | btrfs receive -v "$dest" 2>"$recv_log" || rc=$?
    fi
  else
    if [[ -n "$parent" ]]; then
      log "  running: btrfs send -v -p <parent> | btrfs receive -v  (install 'pv' for a progress bar)"
      btrfs send -v -p "$parent" "$src" 2>"$send_log" \
        | btrfs receive -v "$dest" 2>"$recv_log" || rc=$?
    else
      log "  running: btrfs send -v | btrfs receive -v  (install 'pv' for a progress bar)"
      btrfs send -v "$src" 2>"$send_log" \
        | btrfs receive -v "$dest" 2>"$recv_log" || rc=$?
    fi
  fi

  if [[ "$rc" -ne 0 ]]; then
    echo "    - [ERROR] btrfs send/receive exited ${rc}" >> "$REPORT_FILE"
    emit_log_tail "send" "$send_log"
    emit_log_tail "receive" "$recv_log"
  fi

  return "$rc"
}

# Decides whether the recorded last-synced snapshot can still serve as the
# parent for an incremental send.
#
# `btrfs send -p` needs the parent to exist locally, and `btrfs receive` needs
# its received copy present on the destination. snapper prunes old snapshots on
# its own schedule, so a recorded parent goes stale with nothing noticing. The
# previous check tested only that the destination directory existed, so once
# snapper pruned the local side every incremental send failed -- permanently,
# because the state file only advances on success and so never moved past the
# dead parent. root failed this way every run from 23 July onwards.
#
# Returns 0 if the candidate is usable, 1 if the caller should send in full.
#
# `simulated` is set during a dry run once this run has already "sent" a
# snapshot: a real run would have placed that parent on the destination, so
# the destination-side checks below would pass. Without it a dry run reports
# every snapshot as a full send and tells you nothing about the incremental
# chain. The recorded parent from the state file is never treated this way --
# for that one the destination checks are exactly what we want to exercise.
usable_parent() {
  local candidate="$1" dest_dir="$2" cfg="$3" simulated="${4:-0}"
  local parent_id dest_parent

  [[ -n "$candidate" ]] || return 1

  if [[ ! -d "$candidate" ]]; then
    log "[${cfg}] recorded parent is gone locally (pruned by snapper?) — sending in full."
    echo "- recorded incremental parent \`${candidate}\` no longer exists locally; sending in full" >> "$REPORT_FILE"
    return 1
  fi

  if ! is_ro_subvol "$candidate"; then
    log "[${cfg}] recorded parent is no longer a read-only subvolume — sending in full."
    echo "- recorded incremental parent is not read-only; sending in full" >> "$REPORT_FILE"
    return 1
  fi

  if [[ "$DRY_RUN" -eq 1 && "$simulated" -eq 1 ]]; then
    return 0
  fi

  parent_id=$(basename "$(dirname "$candidate")")
  dest_parent="${dest_dir}/${parent_id}"

  if [[ ! -d "$dest_parent" ]]; then
    log "[${cfg}] parent ${parent_id} is not present on the destination — sending in full."
    echo "- incremental parent **${parent_id}** missing on destination; sending in full" >> "$REPORT_FILE"
    return 1
  fi

  if [[ "$(get_received_uuid "$dest_parent")" != "$(get_subvol_uuid "$candidate")" ]]; then
    log "[${cfg}] destination copy of ${parent_id} does not match the local parent — sending in full."
    echo "- destination copy of **${parent_id}** is not the received copy of the local parent; sending in full" >> "$REPORT_FILE"
    return 1
  fi

  return 0
}

# Sanity-check a completed transfer. Returns 0 (pass) or 1 (fail) and
# appends details to the report.
#
# Only checks 1 and 2 are decisive; 3 and 4 are advisory. See the note above
# them for why.
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

  # ---------------------------------------------------------------------
  # Checks 3 and 4 are ADVISORY. They do not affect pass/fail.
  #
  # On 2026-08-22 a home transfer of 248 GiB passed both decisive checks --
  # read-only destination, Received UUID matching -- and was discarded anyway
  # over a file count of 1256332 against 1256331. One file in 1.26 million.
  # The state file was left untouched, so the same 248 GiB was queued to send
  # again on the next run. Two of those in one run threw away 41 minutes.
  #
  # `find -xdev` stops at device boundaries, and every btrfs subvolume has its
  # own st_dev. A nested subvolume inside the snapshot is therefore counted
  # differently on the two sides depending on how each is laid out, so an
  # off-by-small count is expected rather than alarming. Apparent size via
  # `du --apparent-size` is subject to the same traversal.
  #
  # The Received UUID is what btrfs itself stamps only once receive has
  # completed successfully. That is the proof. These two are a smell test.
  # ---------------------------------------------------------------------

  # 3. File count (advisory).
  local src_count dest_count
  src_count=$(get_file_count "$src")
  dest_count=$(get_file_count "$dest")
  if [[ "$src_count" == "$dest_count" ]]; then
    echo "    - [OK] file count matches (${src_count})" >> "$REPORT_FILE"
  else
    echo "    - [WARN] file count differs (source=${src_count} dest=${dest_count}) — advisory, not a failure" >> "$REPORT_FILE"
  fi

  # 4. Apparent size (advisory).
  local src_size dest_size
  src_size=$(get_size_bytes "$src")
  dest_size=$(get_size_bytes "$dest")
  if [[ "$src_size" == "$dest_size" ]]; then
    echo "    - [OK] size matches (${src_size} bytes)" >> "$REPORT_FILE"
  else
    echo "    - [WARN] size differs (source=${src_size} dest=${dest_size} bytes) — advisory, not a failure" >> "$REPORT_FILE"
  fi

  return $((1 - pass))
}

# btrfs receive always creates the incoming subvolume under its source name,
# "snapshot"; this script renames it to the snapshot id once receive returns.
# A run interrupted between those two steps strands <dest>/snapshot, and every
# later receive into that directory then fails with "cannot create subvolume:
# File exists" -- which is how src and home came to have no usable backups at
# all. Nothing in the script noticed, because the btrfs error was discarded.
#
# Recover rather than abort. A completed receive carries a Received UUID that
# identifies exactly which source snapshot produced it, so the orphan can be
# adopted under its correct id. An interrupted receive has no Received UUID and
# is moved aside for inspection. Nothing is ever deleted automatically.
reclaim_orphan() {
  local dest_dir="$1" src_root="$2" cfg="$3"
  local orphan="${dest_dir}/snapshot"
  local recv_uuid s id quarantine

  [[ -e "$orphan" ]] || return 0

  log "[${cfg}] found orphaned landing subvolume from an interrupted receive."
  recv_uuid=$(get_received_uuid "$orphan" || true)

  if [[ -n "$recv_uuid" ]]; then
    for s in "$src_root"/*/snapshot; do
      [[ -d "$s" ]] || continue
      [[ "$(get_subvol_uuid "$s" || true)" == "$recv_uuid" ]] || continue

      id=$(basename "$(dirname "$s")")
      if [[ -e "${dest_dir}/${id}" ]]; then
        log "[${cfg}] orphan is a duplicate of ${id}, which is already present."
        break
      fi

      log "[${cfg}] adopting orphan as ${id} (Received UUID ${recv_uuid})."
      echo "- recovered an orphaned landing subvolume as **${id}**" >> "$REPORT_FILE"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        mv "$orphan" "${dest_dir}/${id}"
      fi
      return 0
    done
  fi

  quarantine="${dest_dir}/incomplete-receive-${RUN_STAMP}"
  log "[${cfg}] orphan could not be matched to a local snapshot — moving it to $(basename "$quarantine")."
  {
    echo "- an orphaned landing subvolume could not be identified and was moved to"
    echo "  \`$(basename "$quarantine")\`. It is an incomplete receive; inspect and delete it."
  } >> "$REPORT_FILE"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    mv "$orphan" "$quarantine"
  fi
}

TOTAL_SENT=0
TOTAL_FAILED=0

for cfg_name in "${!CONFIGS[@]}"; do
  src_root="${CONFIGS[$cfg_name]}"
  cfg_dest_root="${DEST_ROOT}/${SNAPSHOT_SUBDIR}/${cfg_name}"
  # A dry run must leave the destination exactly as it found it.
  if [[ "$DRY_RUN" -eq 0 ]]; then
    mkdir -p "$cfg_dest_root"
  fi
  state_file="${cfg_dest_root}/.last_synced_snapshot"

  echo "## Config: ${cfg_name} (source: ${src_root})" >> "$REPORT_FILE"
  echo >> "$REPORT_FILE"

  if [[ ! -d "$src_root" ]]; then
    log "Config '${cfg_name}': source '${src_root}' not found, skipping."
    echo "- source directory not found, skipped." >> "$REPORT_FILE"
    echo >> "$REPORT_FILE"
    continue
  fi

  # An orphan from a previous interrupted run blocks every receive into this
  # directory, so deal with it before planning any transfers.
  reclaim_orphan "$cfg_dest_root" "$src_root" "$cfg_name"

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

  # Dry run only: becomes 1 once this run has simulated a send, so later
  # snapshots are planned as incrementals off it rather than all reported
  # as full sends. See usable_parent().
  parent_simulated=0

  for snap in "${to_send[@]}"; do
    snap_id=$(basename "$(dirname "$snap")")
    dest_target="${cfg_dest_root}/${snap_id}"

    log "[${cfg_name}] sending snapshot ${snap_id} ..."
    start_ts=$(date +%s)

    if usable_parent "$last_synced" "$cfg_dest_root" "$cfg_name" "$parent_simulated"; then
      parent_arg="$last_synced"
      send_mode="incremental"
    else
      parent_arg=""
      send_mode="full"
    fi

    if ! run_send_receive "$parent_arg" "$snap" "$cfg_dest_root" "${cfg_name}_${snap_id}"; then
      log "[${cfg_name}] send/receive FAILED for ${snap_id} (${send_mode}) — see ${LOG_DIR}."
      echo "- **${snap_id}**: send/receive FAILED (${send_mode})" >> "$REPORT_FILE"
      TOTAL_FAILED=$((TOTAL_FAILED + 1))
      continue
    fi

    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "- **${snap_id}**: would send (${send_mode})" >> "$REPORT_FILE"
      TOTAL_SENT=$((TOTAL_SENT + 1))
      # Pretend it landed, so the rest of the run plans incrementals off it
      # exactly as a real run would.
      last_synced="$snap"
      parent_simulated=1
      continue
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
