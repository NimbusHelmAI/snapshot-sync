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

export interface Snapshot {
  id: string;
  date: string;
  type?: 'full' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  size?: number;
  parentId?: string;
  childIds?: string[];
}

export type BrowseItemType = 'directory' | 'file' | 'symlink' | 'other';

export interface BrowseItem {
  name: string;
  type: BrowseItemType;
  owner: string;
  group: string;
  size: number;
  modified: string;
  permissions: string;
  target?: string;
}

export interface BrowseResponse {
  items: BrowseItem[];
  currentPath: string;
  parentPath: string | null;
}

export type FilePreview =
  | { kind: 'text'; name: string; content: string; truncated: boolean; size: number }
  | { kind: 'image'; name: string; mimeType: string; dataUrl: string; size: number }
  | { kind: 'unsupported'; name: string; reason: string };

export interface BrowseTarget {
  config: string;
  snapshotId: string;
  diskPath: string;
}
