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

/** A backup copy, seen for deletion: its source snapshots and what is built on it. */
export interface BackupDeleteCheck {
  config: string;
  id: string;
  /** The copy exists on the backup disk. */
  onBackup: boolean;
  /** Local snapshots with the copy's source UUID (its received UUID). */
  sourceIds: string[];
  /** Backup copies built on this one. */
  backupDependents: string[];
}

/** Checks one backup copy. The local export is read for its source snapshots. */
export function checkBackupDelete(
  config: string,
  id: string,
  local: LocalExport | null,
  backup: BackupExport | null,
): BackupDeleteCheck {
  const copy = backup?.snapshots[id] ?? null;
  if (!copy) {
    return { config, id, onBackup: false, sourceIds: [], backupDependents: [] };
  }
  const sourceIds = Object.keys(local?.snapshots ?? {})
    .filter((sid) => copy.receivedUuid !== null && local!.snapshots[sid].uuid === copy.receivedUuid)
    .sort(byNumber);
  const backupDependents = Object.keys(backup!.parentOf)
    .filter((bid) => backup!.parentOf[bid] === id)
    .sort(byNumber);
  return { config, id, onBackup: true, sourceIds, backupDependents };
}

/** One snapshot of a delete batch, seen from the side being deleted. */
export interface BatchItem {
  id: string;
  /** Exists on the side being deleted. */
  exists: boolean;
  /** Ids on the other side holding the same data. Empty means this is the only copy. */
  copies: string[];
  /** Newer snapshots on the side being deleted that are built on it. */
  dependents: string[];
}

export function sourceItem(c: DeleteCheck): BatchItem {
  return { id: c.id, exists: c.onSource, copies: c.backupIds, dependents: c.localDependents };
}

export function backupItem(c: BackupDeleteCheck): BatchItem {
  return { id: c.id, exists: c.onBackup, copies: c.sourceIds, dependents: c.backupDependents };
}

export interface DeletePlan {
  /** Snapshots that will be deleted. */
  allowed: string[];
  /** Snapshots that will not be deleted, and why. */
  refused: { id: string; reason: string }[];
  /** Snapshots with no copy on the other side. They are deleted only when confirmed. */
  onlyCopy: string[];
}

const ONLY_COPY_REASON: Record<'source' | 'backup', string> = {
  source: 'only copy: no backup holds it',
  backup: 'only copy: no source snapshot holds it',
};

/**
 * Decides which snapshots of one batch may be deleted. The host script
 * (scripts/delete_requests.py) applies the same rules again, from btrfs, before it
 * deletes anything. A snapshot is refused when it is not on the side being deleted, or
 * when a newer snapshot on that side is built on it and is not deleted in the same
 * batch (the refusal then passes to its parent). A snapshot with no copy on the other
 * side is refused unless the batch is confirmed.
 */
export function planDelete(items: BatchItem[], side: 'source' | 'backup', confirmOnlyCopy: boolean): DeletePlan {
  const refused = new Map<string, string>();
  const onlyCopy = items.filter((i) => i.exists && i.copies.length === 0).map((i) => i.id);
  for (const item of items) {
    if (!item.exists) {
      refused.set(item.id, `not on the ${side} disk`);
    } else if (onlyCopy.includes(item.id) && !confirmOnlyCopy) {
      refused.set(item.id, `${ONLY_COPY_REASON[side]}; confirm to delete it`);
    }
  }
  const batch = new Set(items.map((i) => i.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (refused.has(item.id)) continue;
      const blocker = item.dependents.find((d) => !batch.has(d) || refused.has(d));
      if (blocker !== undefined) {
        refused.set(item.id, `newer snapshot ${blocker} is built on it and is not being deleted`);
        changed = true;
      }
    }
  }
  return {
    allowed: items.filter((i) => !refused.has(i.id)).map((i) => i.id),
    refused: items
      .filter((i) => refused.has(i.id))
      .map((i) => ({ id: i.id, reason: refused.get(i.id)! })),
    onlyCopy,
  };
}
