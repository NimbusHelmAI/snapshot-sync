# Setup Guide

## Quick Start with Docker Compose

```bash
# 1. Clone the repo
git clone https://github.com/aperelman/snapshot-sync-ui
cd snapshot-sync-ui

# 2. Copy your snapshot sync scripts
mkdir -p scripts
cp /home/amitp/bin/snapshot-sync/*.sh scripts/

# 3. Make sure backup disk is mounted
# (normally at /run/media/amitp/Backup)

# 4. Start the stack
docker compose up -d

# 5. Open browser
open http://localhost:3000
```

Done. Dashboard is live.

## What's included

| Component | Port | Purpose |
|-----------|------|---------|
| Frontend (React) | 3000 | Dashboard UI |
| Backend (Express) | 3001 | REST API |

## Default paths (configurable)

- Backup disk: `/run/media/amitp/Backup`
- Scripts: `/home/amitp/bin/snapshot-sync`

Change in `docker-compose.yml` if different.

## First time

1. Click **Snapshots** tab — should see your configs (root, home, src)
2. Click **Disk** — shows usage
3. Click **Sync** tab, then **Start New Sync**
4. Watch progress in real-time
5. View report in **Reports** tab when done

## Reading local snapshots without sudo (recommended)

Local snapshot directories are root-owned `0750`. The backend reads them as
its own user first and falls back to `sudo -n` only on a permission error, so
once snapper grants that user access, nothing needs root and a cached sudo
login no longer matters.

```bash
# One group for readers, and the user that runs the backend in it
sudo groupadd -f snapshots
sudo usermod -aG snapshots amitp        # log out and in again afterwards

# For each config: put an ACL on .snapshots and on every snapshot snapper creates
for c in root home src; do
  sudo snapper -c "$c" set-config ALLOW_GROUPS=snapshots SYNC_ACL=yes
done
```

`SYNC_ACL=yes` puts the ACL on each config's `.snapshots` directory and on the
snapshot directories snapper creates afterwards; whether older snapshots are
covered is what the check below shows. Files inside a snapshot keep their
original owners and modes, so a file the user cannot read on the live system
stays unreadable here too.

Check it as the normal user, with no sudo involved:

```bash
ls /.snapshots | head -3
ls /home/.snapshots | head -3
ls /home/amitp/src/.snapshots | head -3
```

To let another user read them, add that user to the group and have them log in
again, then check that the ACL is in place:

```bash
sudo usermod -aG snapshots <user>
getfacl /.snapshots      # expect a "group:snapshots:r-x" line
```

What an ACL cannot cover (for example a received home snapshot that keeps
another user's `0700` directory) is still read through `sudo -n`, so keep a
NOPASSWD rule for `ls`, `cat` and `realpath` if you want those browsable. Without
one the request fails at once with a permission error instead of waiting on a
password prompt.

The fallback runs as root, so with that rule the UI can show files your own user
cannot read. The API listens on 127.0.0.1 only, checks the Host header and keeps
symlinks inside the snapshot, but if you do not need those paths, leave the
NOPASSWD rule out and the request is refused instead.

## Passwordless sudo (required for sync)

Add to sudoers:
```bash
sudo visudo
# Add this line:
amitp ALL=(ALL) NOPASSWD: /home/amitp/bin/snapshot-sync/btrfs_snapshot_sync.sh
```

## To push to GitHub

```bash
# Initialize git
git init
git add .
git commit -m "Initial commit"

# Add remote and push
git remote add origin https://github.com/aperelman/snapshot-sync-ui
git branch -M main
git push -u origin main
```

Done.
