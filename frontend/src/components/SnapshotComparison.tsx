/**
 * SnapshotComparison Component
 * 
 * Split-screen UI for comparing snapshots between local disk and backup.
 * Left panel: Local Root filesystem
 * Right panel: External Backup disk
 * Center: Bidirectional sync buttons
 */

import React, { useState, useEffect } from 'react';
import { loadConfigs, syncSnapshots, loadSnapshots } from '../utils/snapshotApi';
import { browseSnapshot, previewFile, formatSize, formatModified } from '../utils/snapshotApi';
import type { BrowseItem, BrowseTarget, FilePreview } from '../types';
import styles from './SnapshotComparison.module.css';

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
}

interface AppSettings {
  localPath: string;
  externalPath: string;
}
const settingsKey = 'snapshot-comparison-settings';

const defaultSettings: AppSettings = {
  localPath: '/',
  externalPath: '/run/media/amitp/Backup',
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
  });

  const [right, setRight] = useState<DiskSide>({
    label: 'External Backup',
    path: settings.externalPath,
    configs: [],
    type: 'external',
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
        loadConfigs(left.path),
        loadConfigs(right.path),
      ]);
      setLeft((prev) => ({
        ...prev,
        configs: leftResult.status === 'fulfilled' ? leftResult.value : [],
      }));
      setRight((prev) => ({
        ...prev,
        configs: rightResult.status === 'fulfilled' ? rightResult.value : [],
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

  useEffect(() => {
    refreshConfigs();
  }, []);

  useEffect(() => {
    refreshConfigs();
  }, [left.path, right.path]);

  const handleSwap = () => {
    const temp = left;
    setLeft(right);
    setRight(temp);
  };

  const handleSettingsSave = (newSettings: AppSettings) => {
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
    } catch (err) {
      console.error(`Failed to load snapshots for ${configName} on ${diskPath}:`, err);
      setError(`Failed to load snapshots for ${configName} on ${diskPath}`);
    } finally {
      setLoading(false);
    }
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
        />
      </div>

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
                {snapshots ? (
                  snapshots.length > 0 ? (
                    <ul className={styles.snapshotItems}>
                      {snapshots.map((snap: any) => {
                        const isSelected = selectedSnapshots.has(
                          snapshotKey(disk.path, cfg.name, snap.id)
                        );
                        return (
                          <li
                            key={snap.id}
                            className={`${styles.snapshotItem} ${isSelected ? styles.snapshotItemSelected : ''}`}
                            onClick={() => onToggleSnapshot(disk.path, cfg.name, snap.id)}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                              <span>📸 {snap.id}</span>
                              <small style={{ fontSize: '0.75em', opacity: 1, color: '#666' }}>{snap.date || 'unknown'}</small>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
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
        {disk.configs.length === 0 && (
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
            placeholder="/run/media/amitp/Backup"
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
