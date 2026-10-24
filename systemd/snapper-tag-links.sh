#!/bin/bash
# snapper-tag-links: label new snapper timeline snapshots by period and link to them.
#
# Period rules. A snapshot is the first of a period when no earlier snapshot in
# the same period exists (earlier snapshots are judged across all that exist):
#   monthly  first snapshot of its calendar month
#   weekly   first snapshot of its ISO week (weeks start Monday)
#   daily    first snapshot of its calendar day
#   hourly   everything else
# Precedence when a snapshot qualifies for several: monthly, then weekly, then daily.
#
# Only snapshots numbered above the baseline are handled. The baseline moves up
# only past snapshots that were tagged and linked, so a failure is retried on
# the next run. Snapper's cleanup ignores these labels; they do not protect a
# snapshot from deletion.
#
# Environment overrides (used by the tests): CONFIGS, STATE, LINKS, OWNER, SNAPPER.
set -uo pipefail

CONFIGS="${CONFIGS:-root home src}"
STATE="${STATE:-/var/lib/snapper-links}"
OWNER="${OWNER:-amitp}"
SNAPPER="${SNAPPER:-snapper}"

# Where each config's links go. Overridable for tests.
LINK_ROOT="${LINK_ROOT:-/snapshot}"
LINK_HOME="${LINK_HOME:-/home/snapshot}"
LINK_SRC="${LINK_SRC:-/home/amitp/src/snapshot}"
link_dir() {
  case "$1" in
    root) echo "$LINK_ROOT" ;;
    home) echo "$LINK_HOME" ;;
    src) echo "$LINK_SRC" ;;
    *) return 1 ;;
  esac
}

status=0
for cfg in $CONFIGS; do
  base_file="$STATE/baseline-$cfg"
  if [ ! -f "$base_file" ]; then
    echo "$cfg: no baseline at $base_file; run the installer first"
    status=1
    continue
  fi
  base=$(cat "$base_file")

  # Snapper keeps a config's snapshots in <subvolume>/.snapshots.
  sub=$("$SNAPPER" -c "$cfg" get-config | grep '^SUBVOLUME' | sed 's/.*│//; s/ //g')
  dir="${sub%/}/.snapshots"
  if [ -z "$sub" ] || [ ! -d "$dir" ]; then
    echo "$cfg: snapshot dir not found (subvolume '$sub', dir '$dir')"
    status=1
    continue
  fi

  # Table of every timeline snapshot as "epoch number", oldest first.
  table=$(mktemp)
  for info in "$dir"/[0-9]*/info.xml; do
    [ -f "$info" ] || continue
    num=$(basename "$(dirname "$info")")
    [[ "$num" =~ ^[0-9]+$ ]] || continue
    grep -q '<cleanup>timeline</cleanup>' "$info" || continue
    raw=$(sed -n 's:.*<date>\(.*\)</date>.*:\1:p' "$info")
    [ -n "$raw" ] || continue
    # snapper writes <date> in UTC; without -u the time is read as local and every label is off.
    epoch=$(date -u -d "$raw" +%s 2>/dev/null) || continue
    echo "$epoch $num" >> "$table"
  done
  sort -n -o "$table" "$table"

  LINKS=$(link_dir "$cfg") || { echo "$cfg: no link folder defined"; status=1; continue; }
  mkdir -p "$LINKS"
  chown "$OWNER:$OWNER" "$LINKS" || echo "$cfg: could not chown $LINKS"

  declare -A seen_month=() seen_week=() seen_day=()
  new_base=$base
  failed=0

  while read -r epoch num <&3; do
    month=$(date -d "@$epoch" +%Y-%m)
    week=$(date -d "@$epoch" +%G-%V)
    day=$(date -d "@$epoch" +%Y-%m-%d)

    first_month=0; first_week=0; first_day=0
    [ -z "${seen_month[$month]:-}" ] && first_month=1
    [ -z "${seen_week[$week]:-}" ] && first_week=1
    [ -z "${seen_day[$day]:-}" ] && first_day=1
    seen_month[$month]=1
    seen_week[$week]=1
    seen_day[$day]=1

    [ "$num" -gt "$base" ] || continue
    info="$dir/$num/info.xml"
    desc=$(sed -n 's:.*<description>\(.*\)</description>.*:\1:p' "$info")

    if [[ "$desc" == snapshot_* ]]; then
      name=$desc
    else
      if [ "$first_month" -eq 1 ]; then type=monthly
      elif [ "$first_week" -eq 1 ]; then type=weekly
      elif [ "$first_day" -eq 1 ]; then type=daily
      else type=hourly; fi
      name="snapshot_${type}_$(date -d "@$epoch" +%Y-%m-%d_%H-%M)"
      if ! "$SNAPPER" -c "$cfg" modify --description "$name" --userdata "type=$type" "$num"; then
        echo "$cfg $num: modify failed, will retry"
        failed=1
        continue
      fi
      echo "$cfg $num: $name"
    fi

    if ln -sfn "$dir/$num/snapshot" "$LINKS/$name" && chown -h "$OWNER:$OWNER" "$LINKS/$name"; then
      [ "$failed" -eq 0 ] && new_base=$num
    else
      echo "$cfg $num: link failed, will retry"
      failed=1
    fi
  done 3< "$table"

  rm -f "$table"

  # Remove links whose snapshot no longer exists.
  for link in "$LINKS"/*; do
    [ -L "$link" ] && [ ! -e "$link" ] && rm -f -- "$link"
  done

  echo "$new_base" > "$base_file"
  [ "$failed" -eq 0 ] || status=1
done

exit $status
