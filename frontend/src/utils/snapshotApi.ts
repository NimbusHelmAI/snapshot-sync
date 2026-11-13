import {
  SnapperConfig,
  Snapshot,
  BrowseResponse,
  BrowseTarget,
  FilePreview,
} from '../types';

const apiBaseUrl = import.meta.env.VITE_API_URL || '';

// The backup path is stored on the server (config.yml), so every browser sees the same value.
export async function loadBackupPath(): Promise<string | null> {
  const res = await fetch(`${apiBaseUrl}/api/settings`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.backupDisk || null;
}

export async function saveBackupPath(backupDisk: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupDisk }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

/**
 * Throws when a response is not ok, preferring the API's own `{ error }`
 * message over the bare status text.
 */
async function throwIfNotOk(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;

  const detail = await response.json().catch(() => null);
  throw new Error(detail?.error || `${fallback}: ${response.statusText}`);
}

/**
 * Loads snapshot configurations for a given path
 */
export async function loadConfigStatus(
  path: string
): Promise<{ configs: SnapperConfig[]; mounted: boolean }> {
  try {
    const response = await fetch(
      `${apiBaseUrl}/api/configs?path=${encodeURIComponent(path)}`
    );
    if (!response.ok) {
      throw new Error('Failed to load configs');
    }
    const data = await response.json();
    return {
      configs: Array.isArray(data.configs) ? data.configs : [],
      mounted: data.mounted !== false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(msg);
  }
}

/**
 * Syncs snapshots between source and target paths
 */
export async function syncSnapshots(
  sourcePath: string,
  targetPath: string,
  configs: string[]
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourcePath,
      targetPath,
      configs,
    }),
  });
  
  if (!response.ok) {
    throw new Error('Sync failed');
  }
}

/**
 * Lists one directory inside a snapshot.
 *
 * @param target  Which snapshot to read, and the disk it lives on.
 * @param subPath Path relative to the snapshot root; '' is the root itself.
 */
export async function browseSnapshot(
  target: BrowseTarget,
  subPath: string
): Promise<BrowseResponse> {
  const params = new URLSearchParams({ path: target.diskPath });
  if (subPath) params.set('subPath', subPath);

  const response = await fetch(
    `${apiBaseUrl}/api/snapshots/${encodeURIComponent(target.config)}` +
      `/${encodeURIComponent(target.snapshotId)}/browse?${params}`
  );

  await throwIfNotOk(response, 'Browse failed');

  const data = await response.json();
  return {
    items: data.items || [],
    currentPath: data.currentPath || '',
    parentPath: data.parentPath ?? null,
  };
}

/**
 * Reads one file inside a snapshot for preview. The backend decides whether
 * the file is text, an image, or something it cannot display.
 *
 * @param subPath Path to the file, relative to the snapshot root.
 */
export async function previewFile(
  target: BrowseTarget,
  subPath: string
): Promise<FilePreview> {
  const params = new URLSearchParams({ path: target.diskPath, subPath });

  const response = await fetch(
    `${apiBaseUrl}/api/snapshots/${encodeURIComponent(target.config)}` +
      `/${encodeURIComponent(target.snapshotId)}/file?${params}`
  );

  await throwIfNotOk(response, 'Could not read file');

  return response.json();
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Formats a byte count for display, e.g. 2411724 -> "2.3 MB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/** Formats an API timestamp as "YYYY-MM-DD HH:MM", or "—" if unparseable. */
export function formatModified(modified: string): string {
  if (!modified) return '—';
  const parsed = new Date(modified);
  if (Number.isNaN(parsed.getTime())) return '—';

  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ` +
    `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  );
}

/**
 * Fetch snapshots for a specific config
 * @param configName - Config name (e.g., "root", "home")
 * @returns Promise resolving to array of snapshot objects
 */
export async function loadSnapshots(
  configName: string,
  path?: string
): Promise<Snapshot[]> {
  try {
    // Relative to apiBaseUrl like every other call here, so the Vite proxy
    // routes it. Hardcoding localhost broke this one call in Docker, where
    // the proxy target is http://api:3001.
    const query = path ? `?${new URLSearchParams({ path })}` : '';
    const response = await fetch(`${apiBaseUrl}/api/snapshots${query}`);

    await throwIfNotOk(response, 'Failed to fetch snapshots');

    const data = await response.json();
    return data.configs?.[configName] || [];
  } catch (error) {
    console.error('Error loading snapshots:', error);
    throw error;
  }
}

/**
 * Parent links for one config's snapshots on the backup disk: { id: parentId | null }.
 * Read on the server from btrfs metadata, so it is always the disk's current state.
 */
export async function loadBackupLinks(
  configName: string,
  path: string
): Promise<Record<string, string | null>> {
  try {
    const query = `?${new URLSearchParams({ path })}`;
    const response = await fetch(
      `${apiBaseUrl}/api/backup-chains/${encodeURIComponent(configName)}${query}`
    );
    await throwIfNotOk(response, 'Failed to read backup links');
    const data = await response.json();
    return data.parentOf ?? {};
  } catch (error) {
    console.error('Error loading backup links:', error);
    throw error;
  }
}

/**
 * Reads the parent links of the local disk for one config, from the local export.
 */
export async function loadLocalLinks(
  configName: string,
  path: string
): Promise<Record<string, string | null>> {
  const query = `?${new URLSearchParams({ path })}`;
  const response = await fetch(
    `${apiBaseUrl}/api/local-chains/${encodeURIComponent(configName)}${query}`
  );
  await throwIfNotOk(response, 'Failed to read local links');
  const data = await response.json();
  return data.parentOf ?? {};
}

/** Which disk a delete removes snapshots from. */
export type DeleteSide = 'source' | 'backup';

/** What a delete would do, before the user confirms it. Nothing is queued by a preview. */
export interface DeletePlan {
  side: DeleteSide;
  /** Snapshots that would be deleted if confirmed. */
  allowed: string[];
  /** Snapshots that would not be deleted, and why. */
  refused: { id: string; reason: string }[];
  /** Snapshots among `allowed` that have no copy on the other disk. */
  onlyCopy: string[];
}

/** The outcome of a queued delete, written by the host script. */
export interface DeleteResult {
  requestId: string;
  config: string;
  side: DeleteSide;
  path: string;
  status: 'done' | 'partial' | 'refused' | 'failed';
  deleted: string[];
  refused: { id: string; reason: string }[];
  onlyCopy: string[];
  error?: string;
  finishedAt: string | null;
}

/** Body of a delete request. dryRun previews the plan and queues nothing. */
interface DeleteBody {
  config: string;
  side: DeleteSide;
  ids: string[];
  path: string;
  confirmOnlyCopy: boolean;
  dryRun?: boolean;
}

async function postDelete(body: DeleteBody): Promise<Response> {
  return fetch(`${apiBaseUrl}/api/delete-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Previews a delete: what would be deleted, what would be refused, and which
 * snapshots are the only copy. Confirm with the user before requesting it.
 */
export async function previewDelete(
  side: DeleteSide,
  configName: string,
  ids: string[],
  path: string
): Promise<DeletePlan> {
  // confirmOnlyCopy is true so the preview shows the most that could go; the
  // dialog only lets the user submit when it has confirmed the only copies.
  const response = await postDelete({
    config: configName,
    side,
    ids,
    path,
    confirmOnlyCopy: true,
    dryRun: true,
  });
  await throwIfNotOk(response, 'Could not check the delete');
  return response.json();
}

/**
 * Queues a delete for the host to run. Returns the request id to poll with
 * loadDeleteResult. A 409 means the batch changed since the preview.
 */
export async function requestDelete(
  side: DeleteSide,
  configName: string,
  ids: string[],
  path: string,
  confirmOnlyCopy: boolean
): Promise<string> {
  const response = await postDelete({
    config: configName,
    side,
    ids,
    path,
    confirmOnlyCopy,
  });
  await throwIfNotOk(response, 'Could not queue the delete');
  const data = await response.json();
  return data.requestId;
}

/**
 * Reads the result of a queued delete. Returns null while the host has not
 * finished it.
 */
export async function loadDeleteResult(requestId: string): Promise<DeleteResult | null> {
  const response = await fetch(
    `${apiBaseUrl}/api/delete-requests/${encodeURIComponent(requestId)}`
  );
  if (response.status === 202) return null;
  await throwIfNotOk(response, 'Could not read the delete result');
  return response.json();
}
