import { SnapperConfig, BrowseResponse, BrowseTarget, FilePreview } from '../types';

const apiBaseUrl = import.meta.env.VITE_API_URL || '';

/**
 * Loads snapshot configurations for a given path
 */
export async function loadConfigs(path: string): Promise<SnapperConfig[]> {
  try {
    const response = await fetch(
      `${apiBaseUrl}/api/configs?path=${encodeURIComponent(path)}`
    );
    if (!response.ok) {
      throw new Error('Failed to load configs');
    }
    const data = await response.json();
    return data.configs || [];
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

  if (!response.ok) {
    // The API reports failures as { error }; fall back to the status text.
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error || `Browse failed: ${response.statusText}`);
  }

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

  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error || `Could not read file: ${response.statusText}`);
  }

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
export async function loadSnapshots(configName: string, path?: string) {
  try {
    const queryPath = path ? encodeURIComponent(path) : '';
    const url = queryPath 
      ? `http://localhost:3001/api/snapshots?path=${queryPath}`
      : `http://localhost:3001/api/snapshots`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch snapshots: ${response.statusText}`);
    }
    const data = await response.json();
    return data.configs[configName] || [];
  } catch (error) {
    console.error('Error loading snapshots:', error);
    throw error;
  }
}
