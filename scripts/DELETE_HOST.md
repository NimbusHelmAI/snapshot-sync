# Delete on the backup disk: host setup

The API queues a delete request as a JSON file in `DELETE_DIR/requests`. A systemd
path unit starts the installed copy of `scripts/delete_requests.py` as root when the folder changes. The
script checks each request against btrfs again, deletes the snapshots that pass,
and writes `DELETE_DIR/results/<requestId>.json`.

## Install

    sudo scripts/install_delete_units.sh --backup-disk /mnt/Backup --delete-dir /var/lib/snapshot-sync/delete

This fills in the unit files, creates the folders, and enables `snapshot-delete.path`.
It also copies `scripts/delete_requests.py` to `/usr/local/lib/snapshot-sync/`,
owned by root. The service runs that copy, so it does not depend on any checkout:
the repo folder can be moved, deleted or switched to another branch.

## Updating the host script

Changes to `scripts/delete_requests.py` reach the host only when the installer is
run again, from the checkout that has the version you want:

    sudo scripts/install_delete_units.sh

## Environment variables

| Variable | Default | Used for |
| --- | --- | --- |
| `BACKUP_DISK` | `/mnt/Backup` | Mount point of the backup disk. The request must name this path. |
| `BACKUP_FS_UUID` | `ed405612-516a-4542-b1a9-61bf1414931b` | Filesystem UUID the mount must have. The script refuses to delete otherwise. |
| `ROOT_SNAPSHOTS` | `/.snapshots` | Local snapshot folder for the `root` config. |
| `HOME_SNAPSHOTS` | `/home/.snapshots` | Local snapshot folder for the `home` config. |
| `SRC_SNAPSHOTS` | `/home/amitp/src/.snapshots` | Local snapshot folder for the `src` config. |

The delete folder is set with `--delete-dir` (or `DELETE_DIR` in the unit file).

## Check at startup

`start-dev.sh` runs `scripts/ensure_delete_units.sh` before it starts the API. It checks that:

- the units are installed, and `snapshot-delete.path` is enabled and listening;
- the service runs the installed script, for the same backup disk and delete folder;
- the installed script is identical to `scripts/delete_requests.py` in the checkout.

If the units are missing or wrong, it runs the installer with `sudo`. If only the
script differs, it asks before it replaces the host copy, so starting the dev stack
from an experimental branch does not silently change what runs as root. If the check
fails, the dev stack still starts and only delete is unavailable.

It can also be run by hand: `scripts/ensure_delete_units.sh [--yes]`.

## Safety rules

- A snapshot that another snapshot is built on is refused, unless that newer snapshot is in the same batch.
- A snapshot with no copy on the other disk is refused unless the request sets `confirmOnlyCopy`.
- Before each delete, the script reads the snapshot's UUID from btrfs again and skips it if it changed.
- Deletes run newest first. A request that fails validation is renamed to `.invalid` and never runs.

## Checking a run

    journalctl -u snapshot-delete.service -n 50
    cat /var/lib/snapshot-sync/delete/results/<requestId>.json

## Tests

`scripts/test-delete-requests.sh` runs the host script against a fake btrfs in a temp folder. It needs no root and no real disk.
