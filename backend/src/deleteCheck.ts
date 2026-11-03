/**
 * Read-only safety check that runs before a snapshot is deleted.
 *
 * Matching is by btrfs UUID, never by snapshot number: a backup copy holds a
 * source snapshot's data when its received UUID equals the source's UUID.
 * Pure on purpose: the caller loads the exported files, so the same rules run
 * in tests and in the API. Nothing here deletes anything.
 */

export interface LocalSnapshot {
  uuid: string;
  parentUuid: string | null;
}

export interface BackupSnapshot {
  uuid: string;
  receivedUuid: string | null;
}

/** <config>.json on the backup disk side, as written by export_backup_links.sh. */
export interface BackupExport {
  path: string;
  config: string;
  exportedAt: string;
  parentOf: Record<string, string | null>;
  snapshots: Record<string, BackupSnapshot>;
}

/** local-<config>.json, as written by export_local_links.sh. */
export interface LocalExport {
  config: string;
  exportedAt: string;
  snapshots: Record<string, LocalSnapshot>;
}

export interface DeleteCheck {
  config: string;
  id: string;
  /** The snapshot exists on the source disk (per the local export). */
  onSource: boolean;
  /** Backup snapshots that hold this snapshot's data, numerically sorted. */
  backupIds: string[];
  /** Source has it and no backup copy exists: deleting it loses data. */
  onlyCopy: boolean;
  /** Source snapshots built on this one (their parent UUID is ours). */
  localDependents: string[];
  /** Backup snapshots built on one of the copies above. */
  backupDependents: string[];
}

function byNumber(a: string, b: string): number {
  return Number(a) - Number(b);
}

export function checkDelete(
  config: string,
  id: string,
  local: LocalExport | null,
  backup: BackupExport | null,
): DeleteCheck {
  const source = local?.snapshots[id] ?? null;
  const backupSnaps = backup?.snapshots ?? {};

  if (!source) {
    return {
      config,
      id,
      onSource: false,
      backupIds: [],
      onlyCopy: false,
      localDependents: [],
      backupDependents: [],
    };
  }

  const backupIds = Object.keys(backupSnaps)
    .filter((bid) => backupSnaps[bid].receivedUuid === source.uuid)
    .sort(byNumber);

  const localDependents = Object.keys(local?.snapshots ?? {})
    .filter((sid) => local!.snapshots[sid].parentUuid === source.uuid)
    .sort(byNumber);

  const copies = new Set(backupIds);
  const backupDependents = Object.keys(backup?.parentOf ?? {})
    .filter((bid) => {
      const parent = backup!.parentOf[bid];
      return parent !== null && copies.has(parent);
    })
    .sort(byNumber);

  return {
    config,
    id,
    onSource: true,
    backupIds,
    onlyCopy: backupIds.length === 0,
    localDependents,
    backupDependents,
  };
}

/**
 * Parent of each local snapshot, by snapshot number, from the local export. The
 * same shape as the backup export's parentOf, so the chain code can use either.
 * A parent that is not in the export maps to null.
 */
export function localParentOf(local: LocalExport): Record<string, string | null> {
  const idByUuid = new Map<string, string>();
  for (const [sid, snap] of Object.entries(local.snapshots)) {
    idByUuid.set(snap.uuid, sid);
  }
  const parentOf: Record<string, string | null> = {};
  for (const [sid, snap] of Object.entries(local.snapshots)) {
    parentOf[sid] = snap.parentUuid ? idByUuid.get(snap.parentUuid) ?? null : null;
  }
  return parentOf;
}
