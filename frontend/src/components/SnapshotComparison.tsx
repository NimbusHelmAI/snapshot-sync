/**
 * SnapshotComparison Component
 * 
 * Split-screen UI for comparing snapshots between local disk and backup.
 * Left panel: Local Root filesystem
 * Right panel: External Backup disk
 * Center: Bidirectional sync buttons
 */

import React, { useState, useEffect } from 'react';
import { loadConfigStatus, syncSnapshots, loadSnapshots, loadBackupPath, saveBackupPath, loadBackupLinks, loadLocalLinks } from '../utils/snapshotApi';
import { browseSnapshot, previewFile, formatSize, formatModified } from '../utils/snapshotApi';
import type { BrowseItem, BrowseTarget, FilePreview } from '../types';
import styles from './SnapshotComparison.module.css';
import { SnapshotsTable } from './SnapshotsTable';
import { SnapshotActionMenu } from './SnapshotActionMenu';
import type { MenuItem } from './SnapshotActionMenu';
import { chainOf } from '../utils/snapshotChains';
import { DeleteDialog } from './DeleteDialog';
import type { DeleteResult, DeleteSide } from '../utils/snapshotApi';

/** Shown on the controls that are deliberately inert until NHA-93 lands. */
const SYNC_DISABLED_HINT =
  'Not implemented yet — snapshot sync and restore are tracked in NHA-93';

/**
 * Separator inside state keys. NUL rather than something readable like '::'
 * because NUL is the one character that cannot appear in a Linux path or a
 * snapper config name, so a key can never be ambiguous; '/mnt/a::b' is a
 * legal path. Named so that it doesn't show up as a bare ^@ in diffs.
 */
const KEY_SEP = '\u0000';

/**
 * Identifies one config on one disk.
 *
 * Both panels can show a config of the same name -- `home` exists locally and
 * on the backup disk -- so state keyed by config name alone is shared between
 * them. It was: whichever panel expanded `home` first fetched its snapshot
 * list, and the other panel displayed that same list, so a backup-only id such
 * as 747 appeared under the local disk and could not be browsed there.
 *
 * Keyed by the disk's path rather than by which side of the screen it sits
 * on, so the key follows the disk through Swap and through a changed path in
 * Settings. NUL cannot occur in a path or a config name, so it cannot collide.
 */
const configKey = (diskPath: string, config: string) => `${diskPath}${KEY_SEP}${config}`;

/** Identifies one snapshot of one config on one disk. See configKey. */
const snapshotKey = (diskPath: string, config: string, id: string) =>
  `${configKey(diskPath, config)}${KEY_SEP}${id}`;

/** Leading glyph for each kind of directory entry in the browse modal. */
const ENTRY_ICON: Record<BrowseItem['type'], string> = {
  directory: '📁',
  file: '📄',
  symlink: '🔗',
  other: '⚙️',
};

interface SnapperConfig {
  name: string;
  path: string;
  snapshotCount: number;
  lastBackup?: string;
}

interface DiskSide {
  label: string;
  path: string;
  configs: SnapperConfig[];
  type: 'local' | 'external';
  /** False when the backup disk is not mounted. Always true for the local disk. */
  mounted: boolean;
}

/** The open delete dialog: which snapshots, on which disk, and which side they are on. */
interface DeleteTarget {
  side: DeleteSide;
  diskLabel: string;
  diskPath: string;
  config: string;
  ids: string[];
}

/** The open row menu: which snapshot it is for, and where to draw it. */
interface SnapshotMenu {
  diskPath: string;
  diskType: DiskSide['type'];
  config: string;
  snapshotId: string;
  x: number;
  y: number;
}

interface AppSettings {
  localPath: string;
  externalPath: string;
}
const settingsKey = 'snapshot-comparison-settings';

const defaultSettings: AppSettings = {
  localPath: '/',
  externalPath: '',
};

export const SnapshotComparison: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem(settingsKey);
    return saved ? JSON.parse(saved) : defaultSettings;
  });

  const [left, setLeft] = useState<DiskSide>({
    label: 'Local Root',
    path: settings.localPath,
    configs: [],
    type: 'local',
    mounted: true,
  });

  const [right, setRight] = useState<DiskSide>({
    label: 'External Backup',
    path: settings.externalPath,
    configs: [],
    type: 'external',
    mounted: true,
  });

  const [selectedConfigs, setSelectedConfigs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedConfigs, setExpandedConfigs] = useState<Set<string>>(new Set());
  const [loadedSnapshots, setLoadedSnapshots] = useState<Record<string, any[]>>({});
  const [selectedSnapshots, setSelectedSnapshots] = useState<Set<string>>(new Set());
  const [selectedConfigLeft, setSelectedConfigLeft] = useState<string | null>(null);
  const [selectedConfigRight, setSelectedConfigRight] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // Browse modal. `browseTarget` non-null means the modal is open.
  const [browseTarget, setBrowseTarget] = useState<BrowseTarget | null>(null);
  const [browseItems, setBrowseItems] = useState<BrowseItem[]>([]);
  const [browsePath, setBrowsePath] = useState('');
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  // Parent links per backup config, keyed by configKey: { snapshotId: parentId | null }.
  const [parentLinks, setParentLinks] = useState<Record<string, Record<string, string | null>>>({});
  // The open row menu (⋯ or right-click). Null means closed.
  const [menu, setMenu] = useState<SnapshotMenu | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  // File preview, layered over the browse list. Null means nothing is open.
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const saveSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    localStorage.setItem(settingsKey, JSON.stringify(newSettings));
  };

  const refreshConfigs = async () => {
    setLoading(true);
    try {
      // allSettled, not all: one disk failing must not blank the other panel.
      const [leftResult, rightResult] = await Promise.allSettled([
        loadConfigStatus(left.path),
        loadConfigStatus(right.path),
      ]);
      setLeft((prev) => ({
        ...prev,
        configs: leftResult.status === 'fulfilled' ? leftResult.value.configs : [],
        mounted: leftResult.status === 'fulfilled' ? leftResult.value.mounted : prev.mounted,
      }));
      setRight((prev) => ({
        ...prev,
        configs: rightResult.status === 'fulfilled' ? rightResult.value.configs : [],
        mounted: rightResult.status === 'fulfilled' ? rightResult.value.mounted : prev.mounted,
      }));
      const failed: string[] = [];
      for (const [disk, result] of [
        [left, leftResult],
        [right, rightResult],
      ] as const) {
        if (result.status === 'rejected') {
          console.error(`Failed to load configs for ${disk.label} (${disk.path}):`, result.reason);
          failed.push(disk.label);
        }
      }
      setError(failed.length ? `Could not load configs for ${failed.join(' and ')}` : null);
    } finally {
      setLoading(false);
    }
  };

  // The backup path comes from the server. The effect below refreshes the configs.
  useEffect(() => {
    loadBackupPath()
      .then((backupDisk) => {
        if (!backupDisk) return;
        setRight((prev) => ({ ...prev, path: backupDisk }));
        setSettings((prev) => ({ ...prev, externalPath: backupDisk }));
      })
      .catch((err) => console.error('Could not load backup path:', err));
  }, []);

  useEffect(() => {
    refreshConfigs();
  }, [left.path, right.path]);

  const handleSwap = () => {
    const temp = left;
    setLeft(right);
    setRight(temp);
  };

  const handleSettingsSave = async (newSettings: AppSettings) => {
    try {
      await saveBackupPath(newSettings.externalPath);
    } catch (err) {
      setError(`Could not save backup path: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    saveSettings(newSettings);
    setLeft((prev) => ({ ...prev, path: newSettings.localPath }));
    setRight((prev) => ({ ...prev, path: newSettings.externalPath }));
    setShowSettings(false);
  };

  const toggleConfig = (configName: string) => {
    const newSelected = new Set(selectedConfigs);
    if (newSelected.has(configName)) {
      newSelected.delete(configName);
    } else {
      newSelected.add(configName);
    }
    setSelectedConfigs(newSelected);
  };

  /**
   * Expands or collapses one config on one disk, fetching its snapshots from
   * that disk's own path.
   *
   * The path used to be hardcoded -- left fetched from '/', right from the
   * backup disk -- regardless of Settings and of Swap, so after a Swap the left
   * panel was labelled as the backup disk while fetching from '/'.
   *
   * Expansion is applied immediately and the list refetched on every expand:
   * snapper adds snapshots hourly, so a list cached for the life of the page
   * goes stale. A previously loaded list stays on screen while the refetch
   * runs, rather than blanking.
   */
  const toggleExpanded = async (
    configName: string,
    diskSide: 'left' | 'right',
    diskPath: string
  ) => {
    const key = configKey(diskPath, configName);
    const expanding = !expandedConfigs.has(key);

    // Functional update: the fetch below awaits, and deriving the new set from
    // a value captured before the await would undo any expand or collapse the
    // user made in the meantime.
    setExpandedConfigs((prev) => {
      const next = new Set(prev);
      if (expanding) next.add(key);
      else next.delete(key);
      return next;
    });

    if (!expanding) return;

    if (diskSide === 'left') {
      setSelectedConfigLeft(configName);
      if (!selectedConfigRight) {
        setSelectedConfigRight(configName);
      }
    } else {
      setSelectedConfigRight(configName);
    }

    try {
      setLoading(true);
      const snapshots = await loadSnapshots(configName, diskPath);
      setLoadedSnapshots((prev) => ({ ...prev, [key]: snapshots }));
      // The list changed, so the links read for it may be stale too.
      setParentLinks((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (err) {
      console.error(`Failed to load snapshots for ${configName} on ${diskPath}:`, err);
      setError(`Failed to load snapshots for ${configName} on ${diskPath}`);
    } finally {
      setLoading(false);
    }
  };

  // Parent links are read once per expanded config: from the backup disk for the
  // external disk, from the local export for the local disk. The
  // reload in toggleExpanded drops them, so they are read again after a change.
  useEffect(() => {
    for (const disk of [left, right]) {
      if (disk.type === 'external' && !disk.mounted) continue;
      for (const cfg of disk.configs) {
        const key = configKey(disk.path, cfg.name);
        if (!expandedConfigs.has(key) || parentLinks[key]) continue;
        const read =
          disk.type === 'external'
            ? loadBackupLinks(cfg.name, disk.path)
            : loadLocalLinks(cfg.name, disk.path);
        read
          .then((parentOf) => setParentLinks((prev) => ({ ...prev, [key]: parentOf })))
          .catch((err) => console.error(`Could not read links for ${cfg.name} on ${disk.path}:`, err));
      }
    }
  }, [expandedConfigs, parentLinks, left, right]);

  /** Adds snapshots to the selection of one config on one disk. Never removes any. */
  const selectSnapshots = (diskPath: string, configName: string, ids: string[]) => {
    setSelectedSnapshots((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(snapshotKey(diskPath, configName, id)));
      return next;
    });
  };

  /** Clears the selection of one config on one disk. */
  const clearSelection = (diskPath: string, configName: string) => {
    const prefix = configKey(diskPath, configName) + KEY_SEP;
    setSelectedSnapshots((prev) => {
      const next = new Set(prev);
      Array.from(prev).forEach((k) => {
        if (k.startsWith(prefix)) next.delete(k);
      });
      return next;
    });
  };

  /** Opens the delete dialog for the selected snapshots of one config on one disk. */
  const openDelete = (disk: DiskSide, configName: string, ids: string[]) => {
    setDeleteTarget({
      side: disk.type === 'local' ? 'source' : 'backup',
      diskLabel: disk.label,
      diskPath: disk.path,
      config: configName,
      ids,
    });
  };

  /** Removes snapshots from the selection of one config on one disk. */
  const deselectSnapshots = (diskPath: string, configName: string, ids: string[]) => {
    setSelectedSnapshots((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(snapshotKey(diskPath, configName, id)));
      return next;
    });
  };

  /** Reloads one config's snapshot list on one disk after a delete. */
  const reloadSnapshots = async (diskPath: string, configName: string) => {
    const key = configKey(diskPath, configName);
    try {
      const snapshots = await loadSnapshots(configName, diskPath);
      setLoadedSnapshots((prev) => ({ ...prev, [key]: snapshots }));
      setParentLinks((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (err) {
      console.error(`Failed to reload snapshots for ${configName} on ${diskPath}:`, err);
      setError(`Failed to reload snapshots for ${configName} on ${diskPath}`);
    }
  };

  /** After a delete: drop the deleted ids from the selection and reload the lists. */
  const handleDeleteDone = (result: DeleteResult) => {
    deselectSnapshots(result.path, result.config, result.deleted);
    reloadSnapshots(result.path, result.config);
    refreshConfigs();
  };

  const toggleSnapshot = (diskPath: string, configName: string, snapshotId: string) => {
    const key = snapshotKey(diskPath, configName, snapshotId);
    setSelectedSnapshots((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** Opens the row menu for one snapshot, at the ⋯ button or right-click position. */
  const openMenu = (
    diskPath: string,
    diskType: DiskSide['type'],
    config: string,
    snapshotId: string,
    x: number,
    y: number
  ) => setMenu({ diskPath, diskType, config, snapshotId, x, y });

  const handleSync = async (direction: 'leftToRight' | 'rightToLeft') => {
    if (selectedConfigs.size === 0) {
      setError('No configs selected');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [source, target] =
        direction === 'leftToRight' ? [left, right] : [right, left];

      await syncSnapshots(
        source.path,
        target.path,
        Array.from(selectedConfigs)
      );

      await refreshConfigs();
      setSelectedConfigs(new Set());
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync error';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Loads one directory of a snapshot into the browse modal.
   * `subPath` is relative to the snapshot root; '' is the root itself.
   */
  const loadBrowsePath = async (target: BrowseTarget, subPath: string) => {
    setBrowseLoading(true);
    setBrowseError(null);
    closePreview();
    try {
      const data = await browseSnapshot(target, subPath);
      setBrowseItems(data.items);
      setBrowsePath(data.currentPath);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : 'Browse failed');
      setBrowseItems([]);
    } finally {
      setBrowseLoading(false);
    }
  };

  const handleBrowse = async (config: string, snapshotId: string, diskPath: string) => {
    const target: BrowseTarget = { config, snapshotId, diskPath };
    setBrowseTarget(target);
    setBrowsePath('');
    await loadBrowsePath(target, '');
  };

  /**
   * Directories are descended into; anything else is opened in the preview
   * pane, which reports for itself when a file cannot be displayed.
   */
  const handleBrowseEnter = (item: BrowseItem) => {
    if (!browseTarget) return;

    const next = browsePath ? `${browsePath}/${item.name}` : item.name;

    if (item.type === 'directory') {
      void loadBrowsePath(browseTarget, next);
      return;
    }
    void openPreview(browseTarget, next);
  };

  const openPreview = async (target: BrowseTarget, subPath: string) => {
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    try {
      setPreview(await previewFile(target, subPath));
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Could not read file');
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(false);
  };

  /** Jumps to a breadcrumb segment. `depth` of 0 is the snapshot root. */
  const handleBrowseCrumb = (depth: number) => {
    if (!browseTarget) return;
    const next = browsePath.split('/').filter(Boolean).slice(0, depth).join('/');
    if (next === browsePath) return;
    void loadBrowsePath(browseTarget, next);
  };

  const closeBrowse = () => {
    setBrowseTarget(null);
    setBrowseItems([]);
    setBrowsePath('');
    setBrowseError(null);
    closePreview();
  };

  const handleRestore = (config: string, snapshotId: string) => {
    console.log(`[handleRestore] config=${config}, id=${snapshotId}`);

  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1>📸 Snapshot Comparison & Sync</h1>
        <div className={styles.headerControls}>
          <button
            onClick={handleSwap}
            className={styles.swapBtn}
            title="Swap left and right"
          >
            ⇄ Swap Sides
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={styles.settingsBtn}
          >
            ⚙️ Settings
          </button>
        </div>
      </header>

      {showSettings && (
        <SettingsPanel
          settings={settings}
          onSave={handleSettingsSave}
          onClose={() => setShowSettings(false)}
        />
      )}

      {error && <div className={styles.error}>{error}</div>}

      {browseTarget && (
        <div className={styles.modal} onClick={closeBrowse}>
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2>📂 {browseTarget.config} · snapshot {browseTarget.snapshotId}</h2>
              <button onClick={closeBrowse} title="Close">✕</button>
            </div>

            <nav className={styles.breadcrumb} aria-label="Snapshot path">
              <button
                className={styles.crumb}
                onClick={() => handleBrowseCrumb(0)}
                disabled={browsePath === ''}
                aria-current={browsePath === '' ? 'page' : undefined}
              >
                root
              </button>
              {browsePath
                .split('/')
                .filter(Boolean)
                .map((segment, index, segments) => (
                  <React.Fragment key={`${segment}-${index}`}>
                    <span className={styles.crumbSep}>/</span>
                    <button
                      className={styles.crumb}
                      onClick={() => handleBrowseCrumb(index + 1)}
                      disabled={index === segments.length - 1}
                      aria-current={index === segments.length - 1 ? 'page' : undefined}
                    >
                      {segment}
                    </button>
                  </React.Fragment>
                ))}
            </nav>

            {(previewLoading || previewError || preview) && (
              <div className={styles.preview}>
                <div className={styles.previewHeader}>
                  <strong className={styles.previewName}>
                    {preview?.name ?? 'Preview'}
                  </strong>
                  <button onClick={closePreview} title="Close preview">✕</button>
                </div>

                <div className={styles.previewBody}>
                  {previewLoading && <p className={styles.browseNotice}>Reading file…</p>}

                  {!previewLoading && previewError && (
                    <p className={styles.browseError}>{previewError}</p>
                  )}

                  {!previewLoading && preview?.kind === 'text' && (
                    <>
                      <pre className={styles.previewText}>{preview.content}</pre>
                      {preview.truncated && (
                        <p className={styles.browseNotice}>
                          Showing the first 1 MB of {formatSize(preview.size)}.
                        </p>
                      )}
                    </>
                  )}

                  {!previewLoading && preview?.kind === 'image' && (
                    <img
                      className={styles.previewImage}
                      src={preview.dataUrl}
                      alt={preview.name}
                    />
                  )}

                  {!previewLoading && preview?.kind === 'unsupported' && (
                    <p className={styles.browseNotice}>{preview.reason}</p>
                  )}
                </div>
              </div>
            )}

            <div className={styles.browseItems}>
              {browseLoading && <p className={styles.browseNotice}>Loading…</p>}

              {!browseLoading && browseError && (
                <p className={styles.browseError}>{browseError}</p>
              )}

              {!browseLoading && !browseError && browseItems.length === 0 && (
                <p className={styles.browseNotice}>This directory is empty.</p>
              )}

              {!browseLoading &&
                !browseError &&
                browseItems.map((item) => {
                  const isDirectory = item.type === 'directory';
                  return (
                    <div
                      key={item.name}
                      className={`${styles.browseItem} ${
                        isDirectory ? styles.browseItemDir : styles.browseItemFile
                      }`}
                      onClick={() => handleBrowseEnter(item)}
                      role="button"
                      tabIndex={0}
                      title={isDirectory ? 'Open folder' : 'Preview file'}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleBrowseEnter(item);
                        }
                      }}
                    >
                      <span className={styles.browseName}>
                        {ENTRY_ICON[item.type]} {item.name}
                        {item.target && (
                          <span className={styles.symlinkTarget}> → {item.target}</span>
                        )}
                      </span>
                      <span className={styles.browseMeta}>
                        {item.owner}
                        <span className={styles.metaSep}>|</span>
                        {isDirectory ? '—' : formatSize(item.size)}
                        <span className={styles.metaSep}>|</span>
                        {formatModified(item.modified)}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}

      <div className={styles.splitView}>
        <DiskPanel
          disk={left}
          diskSide="left"
          selectedConfigs={selectedConfigs}
          onToggleConfig={toggleConfig}
          expandedConfigs={expandedConfigs}
          onToggleExpanded={toggleExpanded}
          loadedSnapshots={loadedSnapshots}
          selectedSnapshots={selectedSnapshots}
          onToggleSnapshot={toggleSnapshot}
          selectedConfig={selectedConfigLeft}
          onConfigSelect={setSelectedConfigLeft}
          onBrowse={handleBrowse}
          onRestore={handleRestore}
          onOpenMenu={openMenu}
          onClearSelection={clearSelection}
          onDelete={openDelete}
        />

        {/*
          Sync is disabled until NHA-93. POST /api/sync does not exist yet, so
          these buttons would post to a route the backend does not serve and
          fail with a 404. Left visible so the layout is stable, but inert and
          labelled, rather than shipping a control that silently does nothing.
        */}
        <div className={styles.center}>
          <button
            className={styles.syncRightBtn}
            disabled
            onClick={() => handleSync('leftToRight')}
            title={SYNC_DISABLED_HINT}
          >
            →
          </button>
          <button
            className={styles.syncLeftBtn}
            disabled
            onClick={() => handleSync('rightToLeft')}
            title={SYNC_DISABLED_HINT}
          >
            ←
          </button>
          <p className={styles.pendingNote}>Sync not yet implemented</p>
        </div>

        <DiskPanel
          disk={right}
          diskSide="right"
          selectedConfigs={selectedConfigs}
          onToggleConfig={toggleConfig}
          expandedConfigs={expandedConfigs}
          onToggleExpanded={toggleExpanded}
          loadedSnapshots={loadedSnapshots}
          selectedSnapshots={selectedSnapshots}
          onToggleSnapshot={toggleSnapshot}
          selectedConfig={selectedConfigRight}
          onConfigSelect={setSelectedConfigRight}
          onBrowse={handleBrowse}
          onRestore={handleRestore}
          onOpenMenu={openMenu}
          onClearSelection={clearSelection}
          onDelete={openDelete}
        />
      </div>

      {deleteTarget && (
        <DeleteDialog
          side={deleteTarget.side}
          diskLabel={deleteTarget.diskLabel}
          diskPath={deleteTarget.diskPath}
          config={deleteTarget.config}
          ids={deleteTarget.ids}
          onClose={() => setDeleteTarget(null)}
          onDone={handleDeleteDone}
        />
      )}
      {menu && (() => {
        const links = parentLinks[configKey(menu.diskPath, menu.config)];
        const items: MenuItem[] = [
          {
            label: 'Browse',
            onSelect: () => handleBrowse(menu.config, menu.snapshotId, menu.diskPath),
          },
        ];
        const chain = links ? chainOf(menu.snapshotId, links) : [];
        items.push({
          label: links ? `Select chain (${chain.length})` : 'Select chain',
          disabled: !links,
          title: links ? undefined : 'Links for this disk are not available yet. Run the links export, then reload.',
          onSelect: () => selectSnapshots(menu.diskPath, menu.config, chain),
        });
        return (
          <SnapshotActionMenu
            x={menu.x}
            y={menu.y}
            heading={`📸 ${menu.snapshotId}`}
            items={items}
            onClose={() => setMenu(null)}
          />
        );
      })()}

      <div className={styles.status}>
        <span>{selectedConfigs.size} config(s) selected</span>
        {loading && <span>Refreshing…</span>}
      </div>
    </div>
  );
};

interface DiskPanelProps {
  disk: DiskSide;
  diskSide: 'left' | 'right';
  selectedConfigs: Set<string>;
  onToggleConfig: (name: string) => void;
  expandedConfigs: Set<string>;
  onToggleExpanded: (
    configName: string,
    diskSide: 'left' | 'right',
    diskPath: string
  ) => Promise<void>;
  /** Keyed by configKey(diskPath, config). */
  loadedSnapshots: Record<string, any[]>;
  /** Holds snapshotKey(diskPath, config, id) values. */
  selectedSnapshots: Set<string>;
  onToggleSnapshot: (diskPath: string, configName: string, snapshotId: string) => void;
  selectedConfig: string | null;
  onConfigSelect: (configName: string) => void;
  onBrowse: (config: string, snapshotId: string, diskPath: string) => Promise<void>;
  onRestore: (config: string, snapshotId: string) => void;
  onOpenMenu: (
    diskPath: string,
    diskType: DiskSide['type'],
    config: string,
    snapshotId: string,
    x: number,
    y: number
  ) => void;
  onClearSelection: (diskPath: string, configName: string) => void;
  /** Opens the delete dialog for the selected ids of one config on this disk. */
  onDelete: (disk: DiskSide, configName: string, ids: string[]) => void;
}

const DiskPanel: React.FC<DiskPanelProps> = ({
  disk,
  diskSide,
  selectedConfigs,
  onToggleConfig,
  expandedConfigs,
  onToggleExpanded,
  loadedSnapshots,
  selectedSnapshots,
  onToggleSnapshot,
  onBrowse,
  onRestore,
  onOpenMenu,
  onClearSelection,
  onDelete,
  // selectedConfig and onConfigSelect - TODO: implement config override UI
}) => {
  const icon = disk.type === 'local' ? '💾' : '💿';

  return (
    <div className={styles.panel}>
      <h2>
        {icon} {disk.label}
      </h2>
      <div className={styles.diskPath}>{disk.path}</div>

      <div className={styles.configList}>
        {disk.configs.map((cfg) => {
          const cKey = configKey(disk.path, cfg.name);
          const isExpanded = expandedConfigs.has(cKey);
          const snapshots = loadedSnapshots[cKey];
          // This panel's own selections for this config, as snapshot ids.
          // Matching on the full key prefix rather than startsWith(cfg.name),
          // which also matched other panels and any config whose name merely
          // begins with this one.
          const selectedPrefix = cKey + KEY_SEP;
          const selectedIds = Array.from(selectedSnapshots)
            .filter((k) => k.startsWith(selectedPrefix))
            .map((k) => k.slice(selectedPrefix.length));

          return (
          <div key={cfg.name}>
            <div className={styles.configItem}>
              <input
                type="checkbox"
                checked={selectedConfigs.has(cfg.name)}
                onChange={() => onToggleConfig(cfg.name)}
              />
              <div className={styles.configInfo}>
                <div className={styles.configName}>{cfg.name}</div>
                <div className={styles.configMeta}>
                  📷 {cfg.snapshotCount} snapshots
                  {cfg.lastBackup && ` • ${cfg.lastBackup}`}
                </div>
              </div>
              <button
                className={styles.expandButton}
                onClick={() => onToggleExpanded(cfg.name, diskSide, disk.path)}
                title={isExpanded ? 'Collapse' : 'Expand'}
              >
                {isExpanded ? '▼' : '▶'}
              </button>
            </div>
            {isExpanded && (
              <div className={styles.snapshotList}>
                {selectedIds.length > 0 && (
                  <div className={styles.selectionBar}>
                    <span>{selectedIds.length} selected</span>
                    <button className={styles.actionBtn} onClick={() => onClearSelection(disk.path, cfg.name)}>
                      Clear
                    </button>
                    {disk.type !== 'local' && (
                      <button
                        className={styles.actionBtn}
                        onClick={() => onDelete(disk, cfg.name, selectedIds)}
                        title="Delete the selected snapshots from this disk"
                      >
                        Delete…
                      </button>
                    )}
                  </div>
                )}
                {snapshots ? (
                  snapshots.length > 0 ? (
                    <SnapshotsTable
                      snapshots={snapshots}
                      selectedIds={new Set(selectedIds)}
                      onSelectChange={(snapId, selected) => {
                        const key = snapshotKey(disk.path, cfg.name, snapId);
                        // Toggle only when the row's state actually changes.
                        if (selected !== selectedSnapshots.has(key)) {
                          onToggleSnapshot(disk.path, cfg.name, snapId);
                        }
                      }}
                      onContextMenu={(snapId, x, y) =>
                        onOpenMenu(disk.path, disk.type, cfg.name, snapId, x, y)
                      }
                    />
                  ) : (
                    <p className={styles.snapshotPlaceholder}>No snapshots found</p>
                  )
                ) : (
                  <p className={styles.snapshotPlaceholder}>Loading snapshots...</p>
                )}
              </div>
            )}
            {isExpanded && selectedIds.length > 0 && (
              <div className={styles.selectedSnapshotInfo}>
                <p className={styles.selectedLabel}>Selected Snapshots:</p>
                {selectedIds.map((snapId) => (
                  <div key={snapId} className={styles.selectedSnapshot}>
                    <span className={styles.snapshotId}>📸 {snapId}</span>
                    <div className={styles.actionButtons}>
                      {/* Restore is a stub until NHA-93. */}
                      <button
                        className={styles.actionBtn}
                        onClick={() => onBrowse(cfg.name, snapId, disk.path)}
                      >
                        Browse
                      </button>
                      <button
                        className={styles.actionBtn}
                        disabled
                        title={SYNC_DISABLED_HINT}
                        onClick={() => onRestore(cfg.name, snapId)}
                      >
                        Restore
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          );
        })}
        {disk.configs.length === 0 && disk.type === 'external' && !disk.mounted && (
          <div role="alert" className={styles.empty}>
            <p>
              The backup disk is not mounted at {disk.path}. Backup copies cannot be
              checked, so deleting is blocked.
            </p>
            <p>
              Mount the disk, then refresh the links:
              <br />
              <code>sudo mount {disk.path}</code>
              <br />
              <code>sudo ./scripts/export_backup_links.sh {disk.path} /var/lib/snapshot-sync/links</code>
            </p>
          </div>
        )}
        {disk.configs.length === 0 && (disk.type !== 'external' || disk.mounted) && (
          <p className={styles.empty}>No configs found</p>
        )}
      </div>
    </div>
  );
};

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
}

const SettingsPanel: React.FC<SettingsPanelProps> = ({
  settings,
  onSave,
  onClose,
}) => {
  const [localPath, setLocalPath] = useState(settings.localPath);
  const [externalPath, setExternalPath] = useState(settings.externalPath);

  return (
    <div className={styles.settingsPanel}>
      <h3>Default Paths</h3>
      <div className={styles.settingsForm}>
        <div className={styles.settingField}>
          <label>Local Root Path:</label>
          <input
            type="text"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder="/"
          />
        </div>
        <div className={styles.settingField}>
          <label>External Backup Path:</label>
          <input
            type="text"
            value={externalPath}
            onChange={(e) => setExternalPath(e.target.value)}
            placeholder="/mnt/Backup"
          />
        </div>
        <div className={styles.settingsActions}>
          <button onClick={() => onSave({ localPath, externalPath })} className={styles.saveBtn}>
            Save
          </button>
          <button onClick={onClose} className={styles.cancelBtn}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default SnapshotComparison;
