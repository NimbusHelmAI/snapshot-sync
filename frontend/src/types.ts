export interface SnapperConfig {
  name: string;
  path: string;
  snapshotCount: number;
  lastBackup?: string;
}

export interface AppSettings {
  localPath: string;
  externalPath: string;
}

export interface Panel {
  path: string;
  configs: SnapperConfig[];
}

export type BrowseItemType = 'directory' | 'file' | 'symlink' | 'other';

/** One entry in a browsed snapshot directory, as returned by the browse API. */
export interface BrowseItem {
  name: string;
  type: BrowseItemType;
  owner: string;
  group: string;
  /** Bytes. Directories report 0. */
  size: number;
  /** Local time, "YYYY-MM-DDTHH:MM:SS". */
  modified: string;
  /** Symbolic mode without the leading type character, e.g. "rwxr-xr-x". */
  permissions: string;
  /** Present only for symlinks. */
  target?: string;
}

export interface BrowseResponse {
  items: BrowseItem[];
  /** Path relative to the snapshot root; empty string at the root. */
  currentPath: string;
  /** Parent of currentPath, or null when already at the root. */
  parentPath: string | null;
}

/** Result of previewing a single file inside a snapshot. */
export type FilePreview =
  | { kind: 'text'; name: string; content: string; truncated: boolean; size: number }
  | { kind: 'image'; name: string; mimeType: string; dataUrl: string; size: number }
  | { kind: 'unsupported'; name: string; reason: string };

/** Which snapshot the browse modal is currently showing. */
export interface BrowseTarget {
  config: string;
  snapshotId: string;
  /** Root path of the disk the snapshot lives on. */
  diskPath: string;
}
