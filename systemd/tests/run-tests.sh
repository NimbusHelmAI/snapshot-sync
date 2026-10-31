#!/bin/bash
# Tests snapper-tag-links.sh against a mock snapper and a mock snapshot tree.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TAG="$HERE/../snapper-tag-links.sh"

export MOCK_ROOT="$HERE/mock"
export STATE="$HERE/state"
export LINKS="$HERE/links"
export LINK_ROOT="$LINKS"
export OWNER="$(id -un)"
export SNAPPER="$HERE/mock-snapper"
export CONFIGS=root
export TZ=Asia/Jerusalem   # snapper stores UTC; the test machine must not be UTC

rm -rf "$MOCK_ROOT" "$STATE" "$LINKS"
mkdir -p "$STATE" "$LINKS"

mk() {
  local num=$1 date=$2 d="$MOCK_ROOT/root/.snapshots/$1"
  mkdir -p "$d/snapshot"
  cat > "$d/info.xml" <<EOF
<?xml version="1.0"?>
<snapshot>
  <type>single</type>
  <num>$num</num>
  <date>$date</date>
  <description>timeline</description>
  <cleanup>timeline</cleanup>
</snapshot>
EOF
}
mk 10 "2026-09-01 10:00:00"
mk 11 "2026-09-28 19:00:00"
# Dates are UTC, as snapper writes them. Local (Israel, UTC+3) times in the comments.
mk 12 "2026-10-01 06:00:00"   # 09:00 local
mk 13 "2026-10-01 07:00:00"   # 10:00 local
mk 14 "2026-10-04 21:00:00"   # 00:00 Mon 5 Oct local
mk 15 "2026-10-04 22:00:00"   # 01:00 local
mk 16 "2026-10-05 21:00:00"   # 00:00 Tue 6 Oct local
mk 17 "2026-10-05 22:00:00"   # 01:00 local
echo 11 > "$STATE/baseline-root"

fail=0
check() {
  if [ "$1" = "$2" ]; then echo "ok    $3"
  else echo "FAIL  $3 (want '$2', got '$1')"; fail=1; fi
}
desc() { sed -n 's:.*<description>\(.*\)</description>.*:\1:p' "$MOCK_ROOT/root/.snapshots/$1/info.xml"; }

echo "== run 1: snapshot 15 fails to tag"
set +e
FAIL_NUM=15 bash "$TAG"; rc=$?
set -e
check "$rc" 1 "exit status 1 when a tag fails"
check "$(desc 10)" "timeline" "10 (before baseline) untouched"
check "$(desc 12)" "snapshot_monthly_2026-10-01_09-00" "12 is monthly (first of October)"
check "$(desc 13)" "snapshot_hourly_2026-10-01_10-00" "13 is hourly"
check "$(desc 14)" "snapshot_weekly_2026-10-05_00-00" "14 is weekly (first Monday of week 41)"
check "$(desc 15)" "timeline" "15 left untagged after failure"
check "$(desc 16)" "snapshot_daily_2026-10-06_00-00" "16 is daily"
check "$(desc 17)" "snapshot_hourly_2026-10-06_01-00" "17 is hourly"
check "$(cat "$STATE/baseline-root")" 14 "baseline stops before the failed snapshot"

echo "== run 2: retry succeeds"
rc=0; bash "$TAG" || rc=$?
check "$rc" 0 "exit status 0 on retry"
check "$(desc 15)" "snapshot_hourly_2026-10-05_01-00" "15 tagged on retry"
check "$(cat "$STATE/baseline-root")" 17 "baseline moves to 17"
check "$(readlink "$LINKS/snapshot_monthly_2026-10-01_09-00")" "$MOCK_ROOT/root/.snapshots/12/snapshot" "link points at snapshot 12"
check "$(ls "$LINKS" | wc -l | tr -d ' ')" 6 "six links exist"

echo "== run 3: idempotent, and dangling links are removed"
before=$(wc -l < "$MOCK_ROOT/modify.log")
ln -s "$HERE/nowhere" "$LINKS/snapshot_old_dangling"
bash "$TAG"
check "$(wc -l < "$MOCK_ROOT/modify.log" | tr -d ' ')" "$before" "no new modify calls"
check "$([ -e "$LINKS/snapshot_old_dangling" ] || [ -L "$LINKS/snapshot_old_dangling" ] && echo present || echo gone)" gone "dangling link removed"

echo "== run 4: a snapshot deleted by snapper drops its link"
rm -rf "$MOCK_ROOT/root/.snapshots/12"
bash "$TAG"
check "$([ -L "$LINKS/snapshot_monthly_2026-10-01_09-00" ] && echo present || echo gone)" gone "link to deleted snapshot removed"

echo
if [ "$fail" -eq 0 ]; then echo "ALL PASSED"; else echo "SOME CHECKS FAILED"; fi
exit "$fail"
