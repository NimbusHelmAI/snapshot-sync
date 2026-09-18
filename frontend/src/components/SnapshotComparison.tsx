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
  'Not implemented yet — snapshot sync, compare and restore are tracked in NHA-93';

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
      const [leftConfigs, rightConfigs] = await Promise.all([
        loadConfigs(left.path),
        loadConfigs(right.path),
      ]);
      setLeft((prev) => ({ ...prev, configs: leftConfigs }));
      setRight((prev) => ({ ...prev, configs: rightConfigs }));
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

  const toggleExpanded = async (configName: string, diskSide: 'left' | 'right') => {
    console.log(`[toggleExpanded] config=${configName}, side=${diskSide}`);
    const newExpanded = new Set(expandedConfigs);
    if (newExpanded.has(configName)) {
      newExpanded.delete(configName);
    } else {
      newExpanded.add(configName);
      // Set as selected config for this side
      if (diskSide === 'left') {
        setSelectedConfigLeft(configName);
        // Auto-mirror to right if not already selected
        if (!selectedConfigRight) {
          setSelectedConfigRight(configName);
        }
      } else {
        setSelectedConfigRight(configName);
      }
      // Fetch snapshots if not already loaded
      if (!loadedSnapshots[configName]) {
        try {
          setLoading(true);
          const path = diskSide === 'left' ? '/' : '/run/media/amitp/Backup';
          console.log(`[loadSnapshots] calling for config=${configName}, path=${path}`);
          const snapshots = await loadSnapshots(configName, path);
          console.log(`[loadSnapshots] got ${snapshots?.length || 0} snapshots`);
          setLoadedSnapshots(prev => ({
            ...prev,
            [configName]: snapshots,
          }));
        } catch (err) {
          console.error(`Failed to load snapshots for ${configName}:`, err);
          setError(`Failed to load snapshots for ${configName}`);
        } finally {
          setLoading(false);
        }
      }
    }
    setExpandedConfigs(newExpanded);
  };

  const toggleSnapshot = (configName: string, snapshotId: string) => {
    const key = `${configName}:${snapshotId}`;
    const newSelected = new Set(selectedSnapshots);
    if (newSelected.has(key)) {
      newSelected.delete(key);
    } else {
      newSelected.add(key);
    }
    setSelectedSnapshots(newSelected);
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

  const handleCompare = (config: string, snapshotId: string) => {
    console.log(`[handleCompare] config=${config}, id=${snapshotId}`);

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
          onCompare={handleCompare}
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
          onCompare={handleCompare}
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
  onToggleExpanded: (configName: string, diskSide: 'left' | 'right') => Promise<void>;
  loadedSnapshots: Record<string, any[]>;
  selectedSnapshots: Set<string>;
  onToggleSnapshot: (configName: string, snapshotId: string) => void;
  selectedConfig: string | null;
  onConfigSelect: (configName: string) => void;
  onBrowse: (config: string, snapshotId: string, diskPath: string) => Promise<void>;
  onCompare: (config: string, snapshotId: string) => void;
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
  onCompare,
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
        {disk.configs.map((cfg) => (
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
                onClick={() => onToggleExpanded(cfg.name, diskSide)}
                title={expandedConfigs.has(cfg.name) ? 'Collapse' : 'Expand'}
              >
                {expandedConfigs.has(cfg.name) ? '▼' : '▶'}
              </button>
            </div>
            {expandedConfigs.has(cfg.name) && (
              <div className={styles.snapshotList}>
                {loadedSnapshots[cfg.name] ? (
                  loadedSnapshots[cfg.name].length > 0 ? (
                    <ul className={styles.snapshotItems}>
                      {loadedSnapshots[cfg.name].map((snap: any) => {
                        const snapKey = `${cfg.name}:${snap.id}`;
                        const isSelected = selectedSnapshots.has(snapKey);
                        return (
                          <li
                            key={snap.id}
                            className={`${styles.snapshotItem} ${isSelected ? styles.snapshotItemSelected : ''}`}
                            onClick={() => onToggleSnapshot(cfg.name, snap.id)}
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
            {expandedConfigs.has(cfg.name) && selectedSnapshots.size > 0 && (
              <div className={styles.selectedSnapshotInfo}>
                <p className={styles.selectedLabel}>Selected Snapshots:</p>
                {Array.from(selectedSnapshots).filter(key => key.startsWith(cfg.name)).map(snapKey => (
                  <div key={snapKey} className={styles.selectedSnapshot}>
                    <span className={styles.snapshotId}>📸 {snapKey.split(':')[1]}</span>
                    <div className={styles.actionButtons}>
                      {/* Compare and Restore are stubs until NHA-93. */}
                      <button
                        className={styles.actionBtn}
                        disabled
                        title={SYNC_DISABLED_HINT}
                        onClick={() => onCompare(cfg.name, snapKey.split(':')[1])}
                      >
                        Compare
                      </button>
                      <button
                        className={styles.actionBtn}
                        onClick={() => onBrowse(cfg.name, snapKey.split(':')[1], disk.path)}
                      >
                        Browse
                      </button>
                      <button
                        className={styles.actionBtn}
                        disabled
                        title={SYNC_DISABLED_HINT}
                        onClick={() => onRestore(cfg.name, snapKey.split(':')[1])}
                      >
                        Restore
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
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
