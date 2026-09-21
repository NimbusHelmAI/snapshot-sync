#!/usr/bin/env bash
#
# api_security_test.sh
#
# Starts the real backend against a fake backup tree containing planted
# symlinks and checks the protections added after the 2026-09-21 exposure:
#
#   - binds loopback only
#   - rejects foreign Host headers (DNS rebinding)
#   - CORS allows only the configured frontend origin
#   - a symlink inside a snapshot cannot escape it, for preview or browse
#   - a symlink that stays inside the snapshot still works
#   - a snapshot directory that is itself a symlink can be browsed
#     (snapshots/home/747 -> ../../home/747, as used for legacy backups)
#
#   - an unreadable directory on the backup disk is retried under sudo
#     (btrfs receive keeps modes, e.g. /home/gitlab-runner at 0700)
#
# Run as your normal user, not root. The sudo-retry checks need the same
# NOPASSWD rule for ls, cat and realpath the server uses, and are skipped
# without it; everything else needs no privilege.
#
#   Usage:  ./scripts/tests/api_security_test.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="${HERE}/../../backend"
PORT="${TEST_PORT:-3917}"
W="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  # SERVER_PID is the node process itself (see the exec launch below), so a
  # plain kill stops the server rather than just some launcher in front of it.
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  chmod -R u+rwx "$W" 2>/dev/null || true   # undo the mode-000 fixture below
  rm -rf "$W"
}
trap cleanup EXIT

# --- fake tree ---------------------------------------------------------------
B="$W/Backup"
SNAP="$B/home/747"
mkdir -p "$SNAP/amitp" "$W/outside" "$B/snapshots/home"
echo "inside the snapshot"               > "$SNAP/amitp/notes.txt"
echo "LIVE HOST FILE — must never be served" > "$W/outside/secret"
ln -s "$W/outside/secret" "$SNAP/amitp/evil"     # absolute, escapes
ln -s notes.txt           "$SNAP/amitp/ok"       # relative, stays inside
ln -s "$W/outside"        "$SNAP/amitp/escdir"   # directory, escapes
ln -s ../../home/747      "$B/snapshots/home/747"
# A directory the server's own user cannot read, as btrfs receive reproduces
# for /home/gitlab-runner (0700, another owner). Mode 000 on our own directory
# gives the same EACCES without needing root to set it up.
mkdir -p "$SNAP/private"
echo "readable only with sudo" > "$SNAP/private/token.txt"
chmod 000 "$SNAP/private"
printf '<?xml version="1.0"?>\n<snapshot><date>2026-07-13 12:36:00</date></snapshot>\n' \
  > "$B/snapshots/home/747.info.xml"

# --- start the real server ---------------------------------------------------
if [[ ! -x "$BACKEND/node_modules/.bin/ts-node" ]]; then
  echo "ERROR: backend dependencies not installed — run 'npm install' in backend/ first" >&2
  exit 2
fi

# A port another run left occupied would make the server fail to start, and the
# checks below would then be talking to whatever else is listening there.
if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
  echo "ERROR: port ${PORT} is already in use; set TEST_PORT to another port" >&2
  exit 2
fi

# exec all the way down -- subshell -> ts-node -> node -- with no fork, so $!
# is the server's own PID. Anything that forks here (npx, setsid) leaves $!
# pointing at a launcher that exits, and the real server outlives the test.
( cd "$BACKEND" && PORT="$PORT" BACKUP_DISK="$B" exec node_modules/.bin/ts-node src/server.ts ) \
  > "$W/server.log" 2>&1 &
SERVER_PID=$!

# Ready means answering on the port. Deliberately not matching a log line:
# that would tie the test to the message text of one version of the server,
# and this test has to run against older versions too, to prove it fails there.
ready=0
for _ in $(seq 1 60); do
  if [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" -H "Host: localhost")" != "000" ]]; then
    ready=1; break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.5
done
if [[ "$ready" -ne 1 ]]; then
  echo "server did not start:"; cat "$W/server.log"; exit 2
fi

API="http://127.0.0.1:${PORT}/api"
Q="path=$(printf %s "$B" | sed 's#/#%2F#g')"

pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; echo "        $2"; fail=$((fail+1)); }

status_of() { curl -s -o "$W/body" -w '%{http_code}' "$@"; }

expect_status() {  # expect_status <desc> <code> <curl args...>
  local desc="$1" want="$2"; shift 2
  local got; got=$(status_of "$@")
  if [[ "$got" == "$want" ]]; then ok "$desc"; else bad "$desc" "expected HTTP $want, got $got: $(head -c 200 "$W/body")"; fi
}

expect_body() {  # expect_body <desc> <substring> <curl args...>
  local desc="$1" want="$2"; shift 2
  status_of "$@" >/dev/null
  if grep -qF "$want" "$W/body"; then ok "$desc"; else bad "$desc" "expected '$want' in: $(head -c 200 "$W/body")"; fi
}

expect_no_body() {
  local desc="$1" unwanted="$2"; shift 2
  status_of "$@" >/dev/null
  if grep -qF "$unwanted" "$W/body"; then bad "$desc" "response contained '$unwanted'"; else ok "$desc"; fi
}

echo "NETWORK EXPOSURE"
if command -v ss >/dev/null; then
  if ss -ltn "sport = :${PORT}" | grep -q "127.0.0.1:${PORT}"; then
    ok "listens on 127.0.0.1 only"
  else
    bad "listens on 127.0.0.1 only" "$(ss -ltn "sport = :${PORT}" | tail -n +2)"
  fi
else
  grep -q "http://127.0.0.1:${PORT}" "$W/server.log" && ok "binds 127.0.0.1 (from log)" \
    || bad "binds 127.0.0.1" "$(cat "$W/server.log")"
fi
expect_status "Host: localhost accepted"           200 "$API/health" -H "Host: localhost:${PORT}"
expect_status "foreign Host rejected (rebinding)"  403 "$API/health" -H "Host: attacker.example"

cors_header() { curl -s -D - -o /dev/null "$API/health" -H "Origin: $1" | tr -d '\r' | grep -i '^access-control-allow-origin:' || true; }
if [[ -z "$(cors_header http://evil.example)" ]]; then
  ok "CORS: foreign origin gets no allow header"
else
  bad "CORS: foreign origin gets no allow header" "$(cors_header http://evil.example)"
fi
if cors_header http://localhost:3000 | grep -q 'http://localhost:3000'; then
  ok "CORS: frontend origin allowed"
else
  bad "CORS: frontend origin allowed" "no allow header for localhost:3000"
fi

echo
echo "SYMLINKED SNAPSHOT DIRECTORY (the browse bug)"
expect_body "browse root of snapshots/home/747 lists contents" '"name":"amitp"' \
  "$API/snapshots/home/747/browse?$Q"
expect_body "browse into amitp/ lists files" '"name":"notes.txt"' \
  "$API/snapshots/home/747/browse?$Q&subPath=amitp"

echo
echo "SYMLINK CONTAINMENT"
expect_status "preview via absolute link that escapes -> 403" 403 \
  "$API/snapshots/home/747/file?$Q&subPath=amitp/evil"
expect_no_body "escaping link never returns the outside file" "LIVE HOST FILE" \
  "$API/snapshots/home/747/file?$Q&subPath=amitp/evil"
expect_status "browse into directory link that escapes -> 403" 403 \
  "$API/snapshots/home/747/browse?$Q&subPath=amitp/escdir"
expect_body "relative link staying inside still previews" "inside the snapshot" \
  "$API/snapshots/home/747/file?$Q&subPath=amitp/ok"
expect_body "ordinary file previews" "inside the snapshot" \
  "$API/snapshots/home/747/file?$Q&subPath=amitp/notes.txt"
expect_status "lexical ../ escape still rejected" 403 \
  "$API/snapshots/home/747/file?$Q&subPath=..%2F..%2F..%2Foutside%2Fsecret"
expect_status "missing path -> 404" 404 \
  "$API/snapshots/home/747/file?$Q&subPath=amitp/nope.txt"

echo
echo "UNREADABLE DIRECTORY ON THE BACKUP DISK (retry under sudo)"
if [[ "$EUID" -eq 0 ]]; then
  echo "  SKIP  running as root, so nothing is unreadable -- run as your normal user"
elif ! sudo -n ls / >/dev/null 2>&1 || ! sudo -n realpath / >/dev/null 2>&1; then
  echo "  SKIP  no NOPASSWD sudo rule for ls and realpath"
else
  expect_body "browse a directory the server user cannot read" '"name":"token.txt"' \
    "$API/snapshots/home/747/browse?$Q&subPath=private"
  expect_body "preview a file inside it" "readable only with sudo" \
    "$API/snapshots/home/747/file?$Q&subPath=private/token.txt"
  expect_status "containment still holds under sudo" 403 \
    "$API/snapshots/home/747/file?$Q&subPath=amitp/evil"
fi

echo
echo "=================================="
echo "passed: $pass   failed: $fail"
echo "=================================="
[[ "$fail" -eq 0 ]]
