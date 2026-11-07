#!/usr/bin/env bash
# Tests scripts/delete_requests.py with a fake btrfs in a temp folder. Needs no btrfs
# and no root. Each case rebuilds the fixtures, so cases do not affect each other.
set -euo pipefail

for tool in python3; do
  command -v "$tool" >/dev/null || { echo "missing $tool: install it to run this test" >&2; exit 1; }
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export FAKE_SHOW="$T/show" FAKE_LIST="$T/list.txt" FAKE_LOG="$T/deletes.log"

# Fake btrfs: "subvolume list" prints the backup listing from $FAKE_LIST, "subvolume
# show <path>" prints the fixture for that path, and "subvolume delete <path>" logs
# the path and removes it.
cat > "$T/btrfs" <<'SH'
#!/usr/bin/env bash
set -eu
case "$1 $2" in
  "subvolume list")
    cat "$FAKE_LIST"; exit 0 ;;
  "subvolume show")
    key=$(printf '%s' "$3" | tr '/' '%')
    f="$FAKE_SHOW/$key.txt"
    [ -f "$f" ] || { echo "ERROR: not a subvolume: $3" >&2; exit 1; }
    cat "$f"; exit 0 ;;
  "subvolume delete")
    echo "$3" >> "$FAKE_LOG"; rm -rf "$3"; exit 0 ;;
esac
echo "unexpected: $*" >&2; exit 2
SH
chmod +x "$T/btrfs"

# Adds one local snapshot: <id> <uuid> <parent-uuid or ->.
local_snap() {
  local dir="$T/root/$1/snapshot"
  mkdir -p "$dir"
  printf 'UUID: \t\t\t%s\nParent UUID: \t\t%s\nReceived UUID: \t\t-\n' "$2" "$3" \
    > "$FAKE_SHOW/$(printf '%s' "$dir" | tr '/' '%').txt"
}

# Adds one backup copy: <id> <uuid> <received-uuid or -> <parent-uuid or ->.
backup_snap() {
  local dir="$T/disk/snapshots/root/$1"
  mkdir -p "$dir"
  printf 'UUID: \t\t\t%s\nParent UUID: \t\t%s\nReceived UUID: \t\t%s\n' "$2" "$4" "$3" \
    > "$FAKE_SHOW/$(printf '%s' "$dir" | tr '/' '%').txt"
  LIST_ROWS+=("ID 500 gen 9 cgen 9 top level 5 parent_uuid $4 received_uuid $3 uuid $2 path snapshots/root/$1")
}

# Fixtures. Local: 10 (A), 11 (B, built on A), 12 (C, built on A), 13 (D).
# Backup: 101 (copy of A), 102 (copy of B, built on 101), 103 (copy of D), 104 (copy of Z, no local).
fixture() {
  rm -rf "$T/root" "$T/disk" "$T/show" "$T/requests" "$T/results" "$T/deletes.log"
  mkdir -p "$T/show" "$T/disk/snapshots/root"
  LIST_ROWS=()
  local_snap 10 A -
  local_snap 11 B A
  local_snap 12 C A
  local_snap 13 D -
  backup_snap 101 U101 A -
  backup_snap 102 U102 B U101
  backup_snap 103 U103 D -
  backup_snap 104 U104 Z -
  printf '%s\n' "${LIST_ROWS[@]}" > "$T/list.txt"
  : > "$T/deletes.log"
}

# Writes one request file and prints its id: submit <side> <comma-ids> <confirm true|false>.
submit() {
  python3 - "$T" "$1" "$2" "$3" <<'PY'
import json, os, sys, uuid
t, side, ids, confirm = sys.argv[1:]
rid = str(uuid.uuid4())
req = {"requestId": rid, "config": "root", "side": side, "ids": ids.split(","),
       "confirmOnlyCopy": confirm == "true", "path": os.path.join(t, "disk"),
       "requestedAt": "2026-11-03T00:00:00Z"}
os.makedirs(os.path.join(t, "requests"), exist_ok=True)
with open(os.path.join(t, "requests", rid + ".json"), "w", encoding="utf-8") as f:
    json.dump(req, f)
print(rid)
PY
}

# Runs the host script once over every queued request.
run_host() {
  BTRFS_BIN="$T/btrfs" FAKE_LIST="$T/list.txt" FAKE_SHOW="$T/show" FAKE_LOG="$T/deletes.log" \
  ROOT_SNAPSHOTS="$T/root" HOME_SNAPSHOTS="$T/none" SRC_SNAPSHOTS="$T/nosrc" \
  BACKUP_DISK="$T/disk" \
    python3 "$ROOT/scripts/delete_requests.py" --test --delete-dir "$T" >/dev/null || true
}
# The host exits 1 when it sets a request aside; the checks below decide pass or fail.

# Checks one result file and the filesystem. Expected JSON: status, deleted (list),
# refused (id -> reason substring), onlyCopy (list), gone (paths), kept (paths).
expect() {
  python3 - "$T" "$1" "$2" <<'PY'
import json, os, sys
t, rid, expected = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
result_path = os.path.join(t, "results", rid + ".json")
assert os.path.isfile(result_path), f"no result for {rid}"
r = json.load(open(result_path, encoding="utf-8"))
assert r["status"] == expected["status"], (r["status"], expected["status"], r)
assert r["deleted"] == expected["deleted"], (r["deleted"], expected["deleted"], r)
assert r["onlyCopy"] == expected["onlyCopy"], (r["onlyCopy"], expected["onlyCopy"], r)
refused = {x["id"]: x["reason"] for x in r["refused"]}
assert sorted(refused) == sorted(expected["refused"]), (refused, expected["refused"])
for sid, part in expected["refused"].items():
    assert part in refused[sid], (sid, refused[sid], part)
for rel in expected["gone"]:
    assert not os.path.exists(os.path.join(t, rel)), f"should be deleted: {rel}"
for rel in expected["kept"]:
    assert os.path.exists(os.path.join(t, rel)), f"should be kept: {rel}"
PY
}

# 1. Source [10]: built on by 11 (not deleted), so refused. Nothing deleted.
fixture
rid=$(submit source 10 false); run_host
expect "$rid" '{"status":"refused","deleted":[],"onlyCopy":[],"refused":{"10":"newer snapshot 11 is built on it"},"gone":[],"kept":["root/10/snapshot","root/11/snapshot"]}'
test ! -s "$T/deletes.log"

# 2. Source [10,11,12] unconfirmed: 11 goes; 10 waits on 12; 12 has no backup copy.
fixture
rid=$(submit source 10,11,12 false); run_host
expect "$rid" '{"status":"partial","deleted":["11"],"onlyCopy":["12"],"refused":{"10":"newer snapshot 12 is built on it","12":"only copy: no backup holds it; confirm to delete it"},"gone":["root/11/snapshot"],"kept":["root/10/snapshot","root/12/snapshot"]}'

# 3. Source [13] has a backup copy (103): deleted.
fixture
rid=$(submit source 13 false); run_host
expect "$rid" '{"status":"done","deleted":["13"],"onlyCopy":[],"refused":{},"gone":["root/13/snapshot"],"kept":[]}'

# 4. Source [12] has no backup copy: refused unless confirmed.
fixture
rid=$(submit source 12 false); run_host
expect "$rid" '{"status":"refused","deleted":[],"onlyCopy":["12"],"refused":{"12":"only copy: no backup holds it; confirm to delete it"},"gone":[],"kept":["root/12/snapshot"]}'

# 5. Same, confirmed: deleted.
fixture
rid=$(submit source 12 true); run_host
expect "$rid" '{"status":"done","deleted":["12"],"onlyCopy":["12"],"refused":{},"gone":["root/12/snapshot"],"kept":[]}'

# 6. Backup [104] has no source snapshot (Z): refused unless confirmed.
fixture
rid=$(submit backup 104 false); run_host
expect "$rid" '{"status":"refused","deleted":[],"onlyCopy":["104"],"refused":{"104":"only copy: no source snapshot holds it; confirm to delete it"},"gone":[],"kept":["disk/snapshots/root/104"]}'

# 7. Same, confirmed: deleted from the backup disk.
fixture
rid=$(submit backup 104 true); run_host
expect "$rid" '{"status":"done","deleted":["104"],"onlyCopy":["104"],"refused":{},"gone":["disk/snapshots/root/104"],"kept":[]}'

# 8. Backup [101]: built on by 102 (not deleted), so refused.
fixture
rid=$(submit backup 101 false); run_host
expect "$rid" '{"status":"refused","deleted":[],"onlyCopy":[],"refused":{"101":"newer snapshot 102 is built on it"},"gone":[],"kept":["disk/snapshots/root/101","disk/snapshots/root/102"]}'

# 9. Backup [102,101] together: 102 goes first, then 101. Both deleted.
fixture
rid=$(submit backup 102,101 false); run_host
expect "$rid" '{"status":"done","deleted":["102","101"],"onlyCopy":[],"refused":{},"gone":["disk/snapshots/root/102","disk/snapshots/root/101"],"kept":[]}'
test "$(cat "$T/deletes.log")" = "$T/disk/snapshots/root/102
$T/disk/snapshots/root/101"

# 10. A snapshot that is not on the side being deleted is refused.
fixture
rid=$(submit source 99 false); run_host
expect "$rid" '{"status":"refused","deleted":[],"onlyCopy":[],"refused":{"99":"not on the source disk"},"gone":[],"kept":[]}'

# 11. A request that does not check out is set aside as .invalid and never runs.
fixture
bad="$T/requests/11111111-2222-3333-4444-555555555555.json"
mkdir -p "$T/requests"
printf '{"requestId":"11111111-2222-3333-4444-555555555555","config":"bogus","side":"source","ids":["10"],"confirmOnlyCopy":false,"path":"%s"}' "$T/disk" > "$bad"
run_host
test -e "$bad.invalid"
test ! -e "$T/results/11111111-2222-3333-4444-555555555555.json"
test ! -s "$T/deletes.log"

echo "delete-requests: all cases passed"
