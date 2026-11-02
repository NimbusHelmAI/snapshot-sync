#!/usr/bin/env bash
# Tests both export scripts with a fake btrfs, then runs the delete check on the
# exported files. Needs no btrfs and no root. Changes nothing outside a temp folder.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# Fake btrfs: "subvolume list" prints the backup listing; "subvolume show <path>"
# prints the fixture named <config>-<n>.txt for <config>/<n>/snapshot.
cat > "$T/btrfs" <<'SH'
#!/usr/bin/env bash
if [ "$1" = subvolume ] && [ "$2" = list ]; then cat "$FAKE_LIST"; exit 0; fi
if [ "$1" = subvolume ] && [ "$2" = show ]; then
  key=$(echo "$3" | awk -F/ '{print $(NF-2)"-"$(NF-1)}')
  f="$FAKE_SHOW/$key.txt"
  [ -f "$f" ] || { echo "ERROR: not a subvolume: $3" >&2; exit 1; }
  cat "$f"; exit 0
fi
echo "unexpected: $*" >&2; exit 2
SH
chmod +x "$T/btrfs"

mkdir -p "$T/show" "$T/root/1/snapshot" "$T/root/2/snapshot"
show() { printf '\tName: \t\t\tsnapshot\n\tUUID: \t\t\t%s\n\tParent UUID: \t\t%s\n\tReceived UUID: \t\t-\n' "$2" "$3" > "$T/show/$1.txt"; }
show root-1 AAA -
show root-2 BBB AAA

cat > "$T/list.txt" <<'TXT'
ID 300 gen 40 cgen 39 top level 5 parent_uuid - received_uuid AAA uuid X12 path snapshots/root/12
ID 301 gen 41 cgen 40 top level 5 parent_uuid - received_uuid - uuid X13 path snapshots/root/13
ID 302 gen 42 cgen 41 top level 5 parent_uuid X12 received_uuid - uuid X14 path snapshots/root/14
TXT

export BTRFS_BIN="$T/btrfs" FAKE_LIST="$T/list.txt" FAKE_SHOW="$T/show"

# 1. Local export: root has two snapshots, src has no folder and must be skipped.
ROOT_SNAPSHOTS="$T/root" HOME_SNAPSHOTS="$T/none" SRC_SNAPSHOTS="$T/nosrc" \
  EXPORT_SKIP_ROOT_CHECK=1 bash "$ROOT/scripts/export_local_links.sh" "$T/out" >/dev/null
python3 - "$T/out/local-root.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["config"] == "root"
assert d["snapshots"]["1"] == {"uuid": "AAA", "parentUuid": None}, d
assert d["snapshots"]["2"] == {"uuid": "BBB", "parentUuid": "AAA"}, d
PY
test ! -e "$T/out/local-src.json" || { echo "src should be skipped"; exit 1; }

# 2. Backup export: received UUIDs are recorded per snapshot.
mkdir -p "$T/links"
BTRFS_BIN="$T/btrfs" FAKE_LIST="$T/list.txt" \
  bash "$ROOT/scripts/export_backup_links.sh" --test "$T" "$T/links" >/dev/null
python3 - "$T/links/root.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["snapshots"]["12"] == {"uuid": "X12", "receivedUuid": "AAA"}, d
assert d["snapshots"]["13"] == {"uuid": "X13", "receivedUuid": None}, d
assert d["parentOf"]["14"] == "12", d
PY

# 3. End to end: 1 is backed up (by UUID), 2 is the only copy and has a dependent.
node - "$ROOT/backend" "$T" "$T/links/root.json" <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [backendDir, tmp, backupFile] = process.argv.slice(2);
const tsc = require('node:child_process').execFileSync;
const out = fs.mkdtempSync(path.join(tmp, 'build-'));
tsc('npx', ['tsc', 'src/deleteCheck.ts', '--outDir', out, '--module', 'commonjs',
  '--target', 'es2020', '--strict', '--skipLibCheck'], { cwd: backendDir, stdio: 'pipe' });
const { checkDelete } = require(path.join(out, 'deleteCheck.js'));
const local = JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'local-root.json'), 'utf8'));
const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
const one = checkDelete('root', '1', local, backup);
assert.deepEqual(one.backupIds, ['12']);
assert.equal(one.onlyCopy, false);
const two = checkDelete('root', '2', local, backup);
assert.equal(two.onlyCopy, true);
assert.deepEqual(two.backupIds, []);
console.log('export-links: all assertions passed');
JS
