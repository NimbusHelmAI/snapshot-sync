# Delete on the backup disk: host setup

The API queues a delete request as a JSON file in `DELETE_DIR/requests`. A systemd
path unit starts `scripts/delete_requests.py` as root when the folder changes. The
script checks each request against btrfs again, deletes the snapshots that pass,
and writes `DELETE_DIR/results/<requestId>.json`.

## Install

    sudo scripts/install_delete_units.sh --backup-disk /mnt/Backup --delete-dir /var/lib/snapshot-sync/delete

This fills in the unit files, creates the folders, and enables `snapshot-delete.path`.

## Environment variables

| Variable | Default | Used for |
| --- | --- | --- |
| `BACKUP_DISK` | `/mnt/Backup` | Mount point of the backup disk. The request must name this path. |
| `BACKUP_FS_UUID` | `ed405612-516a-4542-b1a9-61bf1414931b` | Filesystem UUID the mount must have. The script refuses to delete otherwise. |
| `ROOT_SNAPSHOTS` | `/.snapshots` | Local snapshot folder for the `root` config. |
| `HOME_SNAPSHOTS` | `/home/.snapshots` | Local snapshot folder for the `home` config. |
| `SRC_SNAPSHOTS` | `/home/amitp/src/.snapshots` | Local snapshot folder for the `src` config. |

The delete folder is set with `--delete-dir` (or `DELETE_DIR` in the unit file).

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
