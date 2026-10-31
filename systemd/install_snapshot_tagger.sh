#!/bin/bash
# Installs snapper-tag-links (the tagger) and its systemd timer. Safe to re-run.
#
# On first install each config's baseline is the newest snapshot that exists,
# so existing snapshots keep their current names. An existing baseline is kept.
# Run from the folder that holds snapper-tag-links.sh:
#   sudo bash install_snapshot_tagger.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo"; exit 1; fi
here=$(cd "$(dirname "$0")" && pwd)
[ -f "$here/snapper-tag-links.sh" ] || { echo "snapper-tag-links.sh not found in $here"; exit 1; }
command -v snapper >/dev/null || { echo "snapper not found"; exit 1; }

CONFIGS="root home src"
STATE=/var/lib/snapper-links
OWNER=amitp

# Where each config's links go. Keep in step with snapper-tag-links.sh.
LINK_ROOT=/snapshot
LINK_HOME=/home/snapshot
LINK_SRC=/home/amitp/src/snapshot
link_dir() {
  case "$1" in
    root) echo "$LINK_ROOT" ;;
    home) echo "$LINK_HOME" ;;
    src) echo "$LINK_SRC" ;;
    *) return 1 ;;
  esac
}

mkdir -p "$STATE"

# The first version put links in per-config subfolders of ~/src/snapshot.
# Remove those folders only if they are empty (rmdir never deletes content).
rmdir /home/amitp/src/snapshot/root /home/amitp/src/snapshot/home /home/amitp/src/snapshot/src 2>/dev/null || true

for cfg in $CONFIGS; do
  # Snapper keeps a config's snapshots in <subvolume>/.snapshots.
  sub=$(snapper -c "$cfg" get-config | grep '^SUBVOLUME' | sed 's/.*│//; s/ //g' || true)
  [ -n "$sub" ] || { echo "$cfg: no SUBVOLUME in 'snapper -c $cfg get-config'"; exit 1; }
  dir="${sub%/}/.snapshots"
  [ -d "$dir" ] || { echo "$cfg: snapshot dir not found ($dir)"; exit 1; }
  if [ ! -f "$STATE/baseline-$cfg" ]; then
    last=$(ls "$dir" | grep -E '^[0-9]+$' | sort -n | tail -n 1 || true)
    echo "${last:-0}" > "$STATE/baseline-$cfg"
  fi
  LINKS=$(link_dir "$cfg") || { echo "$cfg: no link folder defined"; exit 1; }
  mkdir -p "$LINKS"
  chown "$OWNER:$OWNER" "$LINKS"
  echo "$cfg: snapshot dir $dir, baseline $(cat "$STATE/baseline-$cfg")"
done

install -m 755 "$here/snapper-tag-links.sh" /usr/local/sbin/snapper-tag-links

cat > /etc/systemd/system/snapper-tag-links.service <<'UNIT'
[Unit]
Description=Label new snapper snapshots by period and keep links to them

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/snapper-tag-links
UNIT

cat > /etc/systemd/system/snapper-tag-links.timer <<'UNIT'
[Unit]
Description=Run snapper-tag-links five minutes past each hour

[Timer]
OnCalendar=*-*-* *:05:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now snapper-tag-links.timer
systemctl list-timers snapper-tag-links.timer --no-pager
echo "installed. test now with: sudo systemctl start snapper-tag-links.service && sudo journalctl -u snapper-tag-links.service -n 40 --no-pager"
