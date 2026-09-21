#!/usr/bin/env bash
#
# sync_dry_run_test.sh
#
# Exercises btrfs_snapshot_sync.sh --dry-run against a fake snapshot tree with
# stubbed btrfs tooling. Covers the decision logic -- snapshot ordering, the
# N_OLDEST limit, incremental parent selection, orphan recovery, dry-run purity
# and argument handling -- without a btrfs filesystem, root privileges or a
# real transfer.
#
# It cannot test send/receive itself. What it can do is let a change to the
# script be checked in seconds rather than by committing to a multi-hour
# transfer, which is why the bugs it now guards against survived as long as
# they did.
#
#   Usage:  ./scripts/tests/sync_dry_run_test.sh [path to btrfs_snapshot_sync.sh]
#
# Exits non-zero if any check fails.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
W="${HERE}/work"
SCRIPT_SRC="${1:-${HERE}/../btrfs_snapshot_sync.sh}"

if [[ ! -f "$SCRIPT_SRC" ]]; then
  echo "ERROR: script under test not found: $SCRIPT_SRC" >&2
  exit 2
fi

rm -rf "$W"
mkdir -p "$W/bin" "$W/dest"

# --- stub tooling ---------------------------------------------------------

# Deterministic fake UUID per path, so "received" copies can be matched back.
cat > "$W/bin/btrfs" <<'STUB'
#!/usr/bin/env bash
uuid_for() { printf '%s' "$1" | md5sum | cut -c1-32 \
  | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/'; }

case "$1 $2" in
  "property get")
    # btrfs property get -ts <path> ro
    path="$4"
    if [[ -f "${path}/.notro" ]]; then echo "ro=false"; else echo "ro=true"; fi
    ;;
  "subvolume show")
    path="$3"
    echo "  UUID: $(uuid_for "$path")"
    # A received copy records which source produced it, via a marker file the
    # harness writes. Absent marker == not a received subvolume.
    if [[ -f "${path}/.received_from" ]]; then
      echo "  Received UUID: $(uuid_for "$(cat "${path}/.received_from")")"
    else
      echo "  Received UUID: -"
    fi
    ;;
  *) exit 0 ;;
esac
STUB

cat > "$W/bin/findmnt" <<'STUB'
#!/usr/bin/env bash
echo btrfs
STUB

chmod +x "$W/bin/btrfs" "$W/bin/findmnt"

# --- fake snapper source trees --------------------------------------------

mk_snap() {  # mk_snap <snapshots-root> <id>
  mkdir -p "$1/$2/snapshot"
  printf '<?xml version="1.0"?>\n<snapshot><date>2026-07-%02d 10:00:00</date></snapshot>\n' \
    "$(( (RANDOM % 28) + 1 ))" > "$1/$2/info.xml"
}

for id in 1362 1385 1432 1443 1454 1468 1490 1502; do mk_snap "$W/root-snaps" "$id"; done
for id in 700 712 733 748 754; do mk_snap "$W/home-snaps" "$id"; done
for id in 90 91; do mk_snap "$W/src-snaps" "$id"; done

# --- script under test, with CONFIGS pointed at the fakes -----------------

sed -e "s#\[root\]=\"/.snapshots\"#[root]=\"${W}/root-snaps\"#" \
    -e "s#\[home\]=\"/home/.snapshots\"#[home]=\"${W}/home-snaps\"#" \
    -e "s#\[src\]=\"/home/amitp/src/.snapshots\"#[src]=\"${W}/src-snaps\"#" \
    "$SCRIPT_SRC" > "$W/script.sh"
chmod +x "$W/script.sh"

run() { PATH="$W/bin:$PATH" "$W/script.sh" "$@"; }

pass=0; fail=0
check() {  # check <description> <expected-substring> <file>
  if grep -qF "$2" "$3"; then
    echo "  PASS  $1"; pass=$((pass+1))
  else
    echo "  FAIL  $1"; echo "        expected to find: $2"; fail=$((fail+1))
  fi
}
check_absent() {
  if grep -qF "$2" "$3"; then
    echo "  FAIL  $1"; echo "        did not expect: $2"; fail=$((fail+1))
  else
    echo "  PASS  $1"; pass=$((pass+1))
  fi
}
latest_report() { ls -1t "$W/dest/reports"/*.md | head -1; }

# ==========================================================================
echo "TEST 1: dry run against an empty destination"
# ==========================================================================
run --dry-run "$W/dest" >"$W/t1.out" 2>&1 || { echo "  script exited $?"; cat "$W/t1.out"; }
R=$(latest_report)
check "report marked as dry run"            "**DRY RUN**"              "$R"
check "oldest root snapshot planned first"  "**1362**: would send"     "$R"
check "first send is full"                  "would send (full)"        "$R"
check "later sends are incremental"         "would send (incremental)" "$R"
check "respects N_OLDEST=5"                 "**1454**: would send"     "$R"
check_absent "does not plan a 6th snapshot" "**1468**: would send"     "$R"
stray=()
for entry in "$W/dest"/*; do
  [[ -e "$entry" ]] || continue
  [[ "$(basename "$entry")" == "reports" ]] && continue
  stray+=("$(basename "$entry")")
done
if [[ ${#stray[@]} -eq 0 ]]; then
  echo "  PASS  destination untouched apart from reports"; pass=$((pass+1))
else
  echo "  FAIL  dry run created: ${stray[*]}"; fail=$((fail+1))
fi

# ==========================================================================
echo
echo "TEST 2: orphan that matches a local snapshot is adopted"
# ==========================================================================
mkdir -p "$W/dest/snapshots/home/snapshot"
echo "$W/home-snaps/733/snapshot" > "$W/dest/snapshots/home/snapshot/.received_from"
run --dry-run "$W/dest" >"$W/t2.out" 2>&1 || true
R=$(latest_report)
check "orphan identified and adopted as 733" "recovered an orphaned landing subvolume as **733**" "$R"
if [[ -d "$W/dest/snapshots/home/snapshot" ]]; then
  echo "  PASS  dry run did not actually move the orphan"; pass=$((pass+1))
else
  echo "  FAIL  dry run moved the orphan"; fail=$((fail+1))
fi

# ==========================================================================
echo
echo "TEST 3: unidentifiable orphan is quarantined, not deleted"
# ==========================================================================
rm -rf "$W/dest/snapshots/home/snapshot"
mkdir -p "$W/dest/snapshots/home/snapshot"   # no .received_from == interrupted
run --dry-run "$W/dest" >"$W/t3.out" 2>&1 || true
R=$(latest_report)
check "unmatched orphan quarantined" "could not be identified and was moved to" "$R"

# ==========================================================================
echo
echo "TEST 4: stale recorded parent falls back to a full send"
# ==========================================================================
rm -rf "$W/dest/snapshots/home/snapshot"
mkdir -p "$W/dest/snapshots/root"
echo "$W/root-snaps/9999/snapshot" > "$W/dest/snapshots/root/.last_synced_snapshot"
run --dry-run "$W/dest" >"$W/t4.out" 2>&1 || true
R=$(latest_report)
check "pruned parent detected" "no longer exists locally; sending in full" "$R"

# ==========================================================================
echo
echo "TEST 5: argument handling"
# ==========================================================================
if run --nonsense "$W/dest" >"$W/t5.out" 2>&1; then
  echo "  FAIL  unknown option was accepted"; fail=$((fail+1))
else
  echo "  PASS  unknown option rejected"; pass=$((pass+1))
fi
if run --help >"$W/t5b.out" 2>&1 && grep -q "dry-run" "$W/t5b.out"; then
  echo "  PASS  --help works without a destination"; pass=$((pass+1))
else
  echo "  FAIL  --help broken"; fail=$((fail+1))
fi

echo
echo "=================================="
echo "passed: $pass   failed: $fail"
echo "=================================="
[[ "$fail" -eq 0 ]]
