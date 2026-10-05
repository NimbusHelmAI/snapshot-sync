/**
 * SnapshotManagerModal Component
 *
 * Comprehensive snapshot management UI combining:
 * - SnapshotsTable (NHA-108): Sortable snapshots table with filtering
 * - DeleteModal (NHA-107): Safe deletion with chain integrity checking
 * - ContextMenu: Right-click actions
 * - Retention policy configuration
 *
 * This modal is opened from DiskPanel when a user clicks "Manage Snapshots"
 * on a selected config.
 */

import React, { useState, useMemo } from 'react';
import type { Snapshot } from '../types';
import { SnapshotsTable } from './SnapshotsTable';
import { DeleteModal } from './DeleteModal';
import { ContextMenu, type ContextMenuAction } from './ContextMenu';
import { ColorCustomizer, loadCustomColors, type ColorScheme } from './ColorCustomizer';
import {
  defaultRetentionPolicy,
  formatRetentionPolicy,
  type RetentionPolicy,
} from '../utils/retentionPolicy';
import styles from './SnapshotManagerModal.module.css';

interface SnapshotManagerModalProps {
  configName: string;
  diskPath: string;
  snapshots: Snapshot[];
  syncedToBackupIds?: Set<string>;
  retentionPolicy?: RetentionPolicy;
  onClose: () => void;
  onDelete?: (snapshotIds: string[]) => Promise<void>;
  onRefresh?: () => Promise<void>;
  onBrowse?: (snapshotId: string) => void;
}

interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  snapshotId: string;
}

export const SnapshotManagerModal: React.FC<SnapshotManagerModalProps> = ({
  configName,
  diskPath,
  snapshots,
  syncedToBackupIds = new Set(),
  retentionPolicy = defaultRetentionPolicy,
  onClose,
  onDelete,
  onRefresh,
  onBrowse,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [showRetentionPolicy, setShowRetentionPolicy] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState('');
  const [customColors, setCustomColors] = useState<ColorScheme>(loadCustomColors());
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
    snapshotId: '',
  });

  const selectedSnapshots = useMemo(() => {
    return snapshots.filter((s) => selectedIds.has(s.id));
  }, [snapshots, selectedIds]);

  const handleSelectChange = (id: string, selected: boolean) => {
    const newSelected = new Set(selectedIds);
    if (selected) {
      newSelected.add(id);
    } else {
      newSelected.delete(id);
    }
    setSelectedIds(newSelected);
  };

  const handleContextMenu = (snapshotId: string, x: number, y: number) => {
    // If the clicked snapshot isn't selected, select only it
    if (!selectedIds.has(snapshotId)) {
      setSelectedIds(new Set([snapshotId]));
    }

    const actions: ContextMenuAction[] = [
      {
        label: 'Browse',
        icon: '📂',
        onClick: () => onBrowse?.(snapshotId),
      },
    ];

    if (selectedIds.size > 0) {
      actions.push({
        label: `Delete (${selectedIds.size})`,
        icon: '🗑️',
        onClick: () => setDeleteModalOpen(true),
        destructive: true,
      });
    }

    actions.push({
      label: 'Refresh',
      icon: '🔄',
      onClick: () => onRefresh?.(),
    });

    setContextMenu({
      isOpen: true,
      x,
      y,
      snapshotId,
    });
  };

  const handleDelete = async (snapshotIds: string[]) => {
    
    setDeleteMessage(`Deleting ${snapshotIds.length} snapshot(s)...`);
    try {
      await onDelete?.(snapshotIds);
      setDeleteModalOpen(false);
      setSelectedIds(new Set());
      setDeleteMessage('');
      await onRefresh?.();
    } finally {
      
    }
  };

  const canDelete = selectedSnapshots.length > 0;

  return (
    <div className={styles.modal} onClick={onClose}>
      <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerTitle}>
            <h2>📸 Snapshot Manager</h2>
            <div className={styles.configInfo}>
              <span className={styles.configName}>{configName}</span>
              <span className={styles.configPath}>{diskPath}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className={styles.closeBtn}
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Toolbar */}
        <div className={styles.toolbar}>
          <div className={styles.toolbarLeft}>
            <span className={styles.count}>
              {snapshots.length} snapshot(s)
              {selectedIds.size > 0 && ` • ${selectedIds.size} selected`}
            </span>
          </div>
          <div className={styles.toolbarRight}>
            <button
              onClick={() => setShowRetentionPolicy(!showRetentionPolicy)}
              className={styles.toolbarBtn}
              title="Retention policy settings"
            >
              ⚙️ Retention
            </button>
            <button
              onClick={() => setDeleteModalOpen(true)}
              className={`${styles.toolbarBtn} ${styles.danger}`}
              disabled={!canDelete}
              title={canDelete ? 'Delete selected snapshots' : 'No snapshots selected'}
            >
              🗑️ Delete
            </button>
          </div>
        </div>

        {/* Retention Policy & Colors Info */}
        {showRetentionPolicy && (
          <div className={styles.policyPanel}>
            <h3>⚙️ Cleanup Schedule & Customization</h3>
            <div className={styles.policyContent}>
              <p>
                <strong>Next cleanup:</strong> {formatRetentionPolicy(retentionPolicy)}
              </p>
              <ul className={styles.policyDetails}>
                <li>
                  <strong>Daily:</strong> Keep last {retentionPolicy.dailyRetention} days
                </li>
                <li>
                  <strong>Weekly:</strong> Keep last {retentionPolicy.weeklyRetention} weeks
                </li>
                <li>
                  <strong>Monthly:</strong> Keep last {retentionPolicy.monthlyRetention} months
                </li>
              </ul>
              <p className={styles.policyNote}>
                💡 Snapshots are deleted on {retentionPolicy.cleanupDay} at {String(retentionPolicy.cleanupHour).padStart(2, '0')}:00 UTC.
                The snapshot deletion is safe and respects snapshot chain integrity.
              </p>
            </div>

            {/* Color Customizer */}
            <ColorCustomizer
              onColorsChange={setCustomColors}
            />
          </div>
        )}

        {/* Error/Status Messages */}
        {deleteMessage && (
          <div className={styles.message}>
            {deleteMessage}
          </div>
        )}

        {/* Snapshots Table */}
        <div className={styles.tableWrapper}>
          <SnapshotsTable
            snapshots={snapshots}
            selectedIds={selectedIds}
            onSelectChange={handleSelectChange}
            onContextMenu={handleContextMenu}
            showBackupStatus={syncedToBackupIds.size > 0}
            backupSyncedIds={syncedToBackupIds}
            customColors={customColors}
          />
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <button
            onClick={onClose}
            className={styles.closeFooterBtn}
          >
            Close
          </button>
        </div>
      </div>

      {/* Delete Modal */}
      {deleteModalOpen && selectedSnapshots.length > 0 && (
        <DeleteModal
          snapshots={selectedSnapshots}
          allSnapshots={snapshots}
          configName={configName}
          syncedToBackup={syncedToBackupIds}
          onConfirm={handleDelete}
          onCancel={() => setDeleteModalOpen(false)}
          onDeleting={setDeleteMessage}
        />
      )}

      {/* Context Menu */}
      {contextMenu.isOpen && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={[
            {
              label: 'Browse',
              icon: '📂',
              onClick: () => onBrowse?.(contextMenu.snapshotId),
            },
            {
              label: `Delete (${selectedIds.size})`,
              icon: '🗑️',
              onClick: () => setDeleteModalOpen(true),
              destructive: true,
            },
            {
              label: 'Refresh',
              icon: '🔄',
              onClick: () => onRefresh?.(),
            },
          ]}
          onClose={() => setContextMenu({ ...contextMenu, isOpen: false })}
        />
      )}
    </div>
  );
};

export default SnapshotManagerModal;
