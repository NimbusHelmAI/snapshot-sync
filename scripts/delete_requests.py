#!/usr/bin/env python3
"""Runs the snapshot deletes that the dev API queues in DELETE_DIR/requests.

Runs as root on the host, from snapshot-delete.service, each time a request file
appears. For each request it reads the snapshots from btrfs again and applies the
same rules as planDelete in backend/src/deleteCheck.ts. It deletes the snapshots
that pass and refuses the rest. Before each delete it checks that the snapshot's
UUID is still the one it checked. It writes DELETE_DIR/results/<requestId>.json
atomically, then removes the request file.

A snapshot is refused when:
  - it is not on the disk the request deletes from;
  - a newer snapshot on that disk is built on it and is not deleted in the same batch;
  - it has no copy on the other disk, unless the request sets confirmOnlyCopy.

Usage: sudo python3 scripts/delete_requests.py [--delete-dir DIR]

--test exists for the tests only: it skips the root and mount checks so the tests
can run with a fake btrfs. The service must never pass it.
"""

import argparse
import datetime
import fcntl
import json
import os
import re
import subprocess
import sys

CONFIG_NAMES = ("root", "home", "src")
BATCH_MAX = 50
ID_RE = re.compile(r"^[0-9]+$")
REQUEST_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
FIELD = re.compile(r"^\s*(UUID|Parent UUID):\s*(\S+)")
ROW = re.compile(r"^ID \d+ .*?parent_uuid (\S+)\s+received_uuid (\S+)\s+uuid (\S+)\s+path (.+)$")
ONLY_COPY_REASON = {
    "source": "only copy: no backup holds it",
    "backup": "only copy: no source snapshot holds it",
}


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def numeric_key(snapshot_id):
    return int(snapshot_id)


def show(btrfs, path):
    """UUID and parent UUID of one subvolume, from btrfs subvolume show."""
    text = subprocess.run([btrfs, "subvolume", "show", path], check=True,
                          capture_output=True, text=True).stdout
    found = {}
    for line in text.splitlines():
        m = FIELD.match(line)
        if m:
            found[m.group(1)] = m.group(2)
    if "UUID" not in found:
        raise RuntimeError(f"no UUID in btrfs output for {path}")
    parent = found.get("Parent UUID", "-")
    return found["UUID"], None if parent == "-" else parent


def local_snapshots(btrfs, base):
    """Local snapshots of one config: id -> {uuid, parentUuid, path}."""
    found = {}
    if not os.path.isdir(base):
        return found
    for entry in os.listdir(base):
        if not ID_RE.match(entry):
            continue
        path = os.path.join(base, entry, "snapshot")
        if not os.path.isdir(path):
            continue
        uuid, parent = show(btrfs, path)
        found[entry] = {"uuid": uuid, "parentUuid": parent, "path": path}
    return found


def backup_copies(btrfs, disk, config):
    """Backup copies of one config: id -> {uuid, receivedUuid, parentUuid, path}."""
    listing = subprocess.run([btrfs, "subvolume", "list", "-a", "-u", "-q", "-R", disk],
                             check=True, capture_output=True, text=True).stdout
    member = re.compile(rf"(?:^|/){re.escape(config)}/(\d+)$")
    copies = {}
    for line in listing.splitlines():
        m = ROW.match(line)
        if not m:
            continue
        parent, received, uuid, subvol = m.groups()
        found = member.search(subvol)
        if found:
            copies[found.group(1)] = {
                "uuid": uuid,
                "receivedUuid": None if received == "-" else received,
                "parentUuid": None if parent == "-" else parent,
                "path": os.path.join(disk, subvol),
            }
    return copies


def source_item(snapshot_id, local, copies):
    """A snapshot on the local disk, with its backup copies and local dependents."""
    me = local.get(snapshot_id)
    if me is None:
        return {"id": snapshot_id, "exists": False, "copies": [], "dependents": []}
    return {
        "id": snapshot_id,
        "exists": True,
        "copies": sorted((c for c in copies if copies[c]["receivedUuid"] == me["uuid"]), key=numeric_key),
        "dependents": sorted((s for s in local if local[s]["parentUuid"] == me["uuid"]), key=numeric_key),
    }


def backup_item(snapshot_id, local, copies):
    """A backup copy, with the local snapshots it came from and its backup dependents."""
    me = copies.get(snapshot_id)
    if me is None:
        return {"id": snapshot_id, "exists": False, "copies": [], "dependents": []}
    received = me["receivedUuid"]
    return {
        "id": snapshot_id,
        "exists": True,
        "copies": sorted((s for s in local if received is not None and local[s]["uuid"] == received),
                         key=numeric_key),
        "dependents": sorted((c for c in copies if copies[c]["parentUuid"] == me["uuid"]), key=numeric_key),
    }


def plan_delete(items, side, confirm_only_copy):
    """Same rules as planDelete in backend/src/deleteCheck.ts."""
    refused = {}
    only_copy = [i["id"] for i in items if i["exists"] and not i["copies"]]
    for item in items:
        if not item["exists"]:
            refused[item["id"]] = f"not on the {side} disk"
        elif item["id"] in only_copy and not confirm_only_copy:
            refused[item["id"]] = f"{ONLY_COPY_REASON[side]}; confirm to delete it"
    batch = {i["id"] for i in items}
    changed = True
    while changed:
        changed = False
        for item in items:
            if item["id"] in refused:
                continue
            blocker = next((d for d in item["dependents"] if d not in batch or d in refused), None)
            if blocker is not None:
                refused[item["id"]] = f"newer snapshot {blocker} is built on it and is not being deleted"
                changed = True
    return {
        "allowed": [i["id"] for i in items if i["id"] not in refused],
        "refused": [{"id": i["id"], "reason": refused[i["id"]]} for i in items if i["id"] in refused],
        "onlyCopy": only_copy,
    }


def load_request(path, name, backup_disk):
    """Reads and checks one request file. Raises ValueError if it is not a valid request."""
    with open(path, encoding="utf-8") as f:
        req = json.load(f)
    if not isinstance(req, dict):
        raise ValueError("not a JSON object")
    rid = req.get("requestId")
    if not isinstance(rid, str) or not REQUEST_ID_RE.match(rid) or name != f"{rid}.json":
        raise ValueError("requestId does not match the file name")
    if req.get("config") not in CONFIG_NAMES:
        raise ValueError("unknown config")
    if req.get("side") not in ("source", "backup"):
        raise ValueError("side must be source or backup")
    ids = req.get("ids")
    if (not isinstance(ids, list) or not 1 <= len(ids) <= BATCH_MAX
            or not all(isinstance(i, str) and ID_RE.match(i) for i in ids)
            or len(set(ids)) != len(ids)):
        raise ValueError(f"ids must be 1 to {BATCH_MAX} unique snapshot numbers")
    disk = req.get("path")
    if not isinstance(disk, str) or not os.path.isabs(disk):
        raise ValueError("path must be an absolute backup disk path")
    if os.path.realpath(disk) != os.path.realpath(backup_disk):
        raise ValueError(f"path is not the configured backup disk {backup_disk}")
    if not isinstance(req.get("confirmOnlyCopy"), bool):
        raise ValueError("confirmOnlyCopy must be true or false")
    return req


EXPECTED_FS_UUID = os.environ.get("BACKUP_FS_UUID", "ed405612-516a-4542-b1a9-61bf1414931b")


def disk_has_expected_uuid(disk):
    """True when the filesystem mounted at disk is the backup disk, by filesystem UUID."""
    found = subprocess.run(["findmnt", "-no", "UUID", "--target", disk],
                           capture_output=True, text=True, check=False)
    return found.returncode == 0 and found.stdout.strip() == EXPECTED_FS_UUID


def run_request(req, ctx):
    """Checks one request from btrfs and deletes what passes. Returns the result document."""
    config, side, disk = req["config"], req["side"], req["path"]
    base = {
        "requestId": req["requestId"],
        "config": config,
        "side": side,
        "path": disk,
        "finishedAt": None,
    }
    if not ctx.test and not os.path.ismount(disk):
        return {**base, "status": "failed", "deleted": [], "refused": [],
                "onlyCopy": [], "error": f"{disk} is not mounted", "finishedAt": now_iso()}

    if not ctx.test and not disk_has_expected_uuid(disk):
        return {**base, "status": "failed", "deleted": [], "refused": [],
                "onlyCopy": [], "error": f"{disk} is not the backup filesystem (UUID check)",
                "finishedAt": now_iso()}
    local = local_snapshots(ctx.btrfs, ctx.local_base[config])
    copies = backup_copies(ctx.btrfs, disk, config)
    make = source_item if side == "source" else backup_item
    items = [make(sid, local, copies) for sid in req["ids"]]
    plan = plan_delete(items, side, req["confirmOnlyCopy"])

    deleted = []
    refused = list(plan["refused"])
    # Newest first, so a snapshot goes before the one it was built from.
    for sid in sorted(plan["allowed"], key=numeric_key, reverse=True):
        target = local[sid] if side == "source" else copies[sid]
        expected = target["uuid"]
        try:
            current, _ = show(ctx.btrfs, target["path"])
            if current != expected:
                refused.append({"id": sid, "reason": "changed since the check; not deleted"})
                continue
            subprocess.run([ctx.btrfs, "subvolume", "delete", target["path"]], check=True,
                           capture_output=True, text=True)
            deleted.append(sid)
        except (subprocess.CalledProcessError, RuntimeError, OSError) as error:
            detail = getattr(error, "stderr", "") or str(error)
            refused.append({"id": sid, "reason": f"could not delete: {detail.strip()}"})

    if deleted and refused:
        status = "partial"
    elif deleted:
        status = "done"
    else:
        status = "refused"
    return {**base, "status": status, "deleted": deleted, "refused": refused,
            "onlyCopy": plan["onlyCopy"], "finishedAt": now_iso()}


def write_json_atomic(path, doc):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


class Context:
    def __init__(self, btrfs, test, local_base):
        self.btrfs = btrfs
        self.test = test
        self.local_base = local_base


def main():
    parser = argparse.ArgumentParser(description="Run queued snapshot deletes (root, host only).")
    parser.add_argument("--delete-dir", default=os.environ.get("DELETE_DIR", "/var/lib/snapshot-sync/delete"))
    parser.add_argument("--btrfs", default=os.environ.get("BTRFS_BIN", "btrfs"))
    parser.add_argument("--test", action="store_true", help="tests only: skip the root and mount checks")
    args = parser.parse_args()

    if not args.test and os.geteuid() != 0:
        print("run as root, for example with sudo", file=sys.stderr)
        return 1

    requests_dir = os.path.join(args.delete_dir, "requests")
    results_dir = os.path.join(args.delete_dir, "results")
    os.makedirs(requests_dir, exist_ok=True)
    os.makedirs(results_dir, exist_ok=True)

    # One run at a time. A second run waits here, then finds any requests left behind.
    lock = open(os.path.join(args.delete_dir, ".lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)

    backup_disk = os.environ.get("BACKUP_DISK", "/mnt/Backup")
    ctx = Context(args.btrfs, args.test, {
        "root": os.environ.get("ROOT_SNAPSHOTS", "/.snapshots"),
        "home": os.environ.get("HOME_SNAPSHOTS", "/home/.snapshots"),
        "src": os.environ.get("SRC_SNAPSHOTS", "/home/amitp/src/.snapshots"),
    })

    failures = 0
    for name in sorted(os.listdir(requests_dir)):
        if not name.endswith(".json"):
            continue  # a .tmp file is still being written by the API
        path = os.path.join(requests_dir, name)
        try:
            req = load_request(path, name, backup_disk)
        except (OSError, ValueError) as error:
            print(f"invalid request {path}: {error}", file=sys.stderr)
            os.replace(path, path + ".invalid")  # kept for a look, never run
            failures += 1
            continue
        try:
            result = run_request(req, ctx)
        except (subprocess.CalledProcessError, RuntimeError, OSError) as error:
            detail = getattr(error, "stderr", "") or str(error)
            result = {"requestId": req["requestId"], "config": req["config"], "side": req["side"],
                      "path": req["path"], "status": "failed", "deleted": [], "refused": [],
                      "onlyCopy": [], "error": detail.strip(), "finishedAt": now_iso()}
        write_json_atomic(os.path.join(results_dir, f"{req['requestId']}.json"), result)
        os.unlink(path)
        print(f"{result['status']}  {req['requestId']}  deleted={result['deleted']} "
              f"refused={[r['id'] for r in result['refused']]}")
        if result["status"] == "failed":
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
