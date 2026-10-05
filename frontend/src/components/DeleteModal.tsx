import { buildChainMap, canDeleteSnapshot } from '../utils/retentionPolicy';
/**
 * DeleteModal Component
 *
 * Safe deletion UI with:
 * - Chain integrity checking to prevent breaking incremental snapshots
 * - Type-to-confirm for destructive operations
 * - Bidirectional backup status checking (warns if snapshot is synced to backup)
 * - Clear display of dependencies and impact
 */

import React, { useState } from 'react';
import type { Snapshot } from '../types';
import styles from './DeleteModal.module.css';

interface DeleteModalProps {
  /** Snapshots to delete */
  snapshots: Snapshot[];
  /** All snapshots in the config (for chain validation) */
  allSnapshots: Snapshot[];
  /** Config name (for context) */
  configName: string;
  /** IDs of snapshots that are synced to backup */
  syncedToBackup: Set<string>;
  /** Called on confirm */
  onConfirm: (snapshotIds: string[]) => void;
  /** Called on cancel */
  onCancel: () => void;
  /** Optional: callback for delete progress */
  onDeleting?: (message: string) => void;
}

interface SnapshotWithChainInfo extends Snapshot {
  canDelete: boolean;
  blockingReason?: string;
  dependents?: string[];
  isSyncedToBackup: boolean;
}

export const DeleteModal: React.FC<DeleteModalProps> = ({
  snapshots,
  allSnapshots,
  configName,
  syncedToBackup,
  onConfirm,
  onCancel,
  onDeleting,
}) => {
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  // Build chain map for dependency checking
  const chainMap = buildChainMap(
    allSnapshots.map((s) => ({
      id: s.id,
      date: s.date,
      type: ('type' in s && s.type) ? s.type as any : 'daily',
      isIncremental: true,
      parentId: ('parentId' in s) ? s.parentId : undefined,
      childIds: [],
      size: s.size,
    }))
  );

  // Analyze each snapshot for deletion safety
  const snapshotsWithInfo: SnapshotWithChainInfo[] = snapshots.map((snap) => {

    const chainCheck = canDeleteSnapshot(snap.id, chainMap);
    const isSynced = syncedToBackup.has(snap.id);

    return {
      ...snap,
      canDelete: chainCheck.canDelete,
      blockingReason: chainCheck.reason,
      dependents: chainCheck.dependents,
      isSyncedToBackup: isSynced,
    };
  });

  // Separate deletable and blocked snapshots
  const canDelete = snapshotsWithInfo.filter((s) => s.canDelete);
  const blocked = snapshotsWithInfo.filter((s) => !s.canDelete);
  const synced = canDelete.filter((s) => s.isSyncedToBackup);

  const expectedConfirmText = 'delete';
  const isConfirmed = confirmText.toLowerCase() === expectedConfirmText;
  const canProceed = canDelete.length > 0 && isConfirmed;

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      onDeleting?.(`Deleting ${canDelete.length} snapshot(s)...`);
      onConfirm(canDelete.map((s) => s.id));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className={styles.modal} onClick={onCancel}>
      <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>🗑️ Delete Snapshots</h2>
          <button onClick={onCancel} className={styles.closeBtn} title="Close">✕</button>
        </div>

        <div className={styles.body}>
          {/* Summary */}
          <div className={styles.summary}>
            <p>
              <strong>Config:</strong> <code>{configName}</code>
            </p>
            <p>
              <strong>Selected:</strong> {snapshots.length} snapshot(s)
            </p>
            {blocked.length > 0 && (
              <p className={styles.blocked}>
                <strong>⚠️ Blocked:</strong> {blocked.length} snapshot(s) cannot be deleted (has dependents)
              </p>
            )}
            {synced.length > 0 && (
              <p className={styles.synced}>
                <strong>ℹ️ Synced to backup:</strong> {synced.length} snapshot(s) exist on external backup
              </p>
            )}
          </div>

          {/* Blocked snapshots */}
          {blocked.length > 0 && (
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>❌ Cannot Delete</h3>
              <div className={styles.snapshotList}>
                {blocked.map((snap) => (
                  <div key={snap.id} className={styles.snapshotItem}>
                    <div className={styles.snapshotId}>
                      📸 {snap.id}
                    </div>
                    <div className={styles.reason}>
                      {snap.blockingReason}
                    </div>
                    {snap.dependents && snap.dependents.length > 0 && (
                      <div className={styles.dependents}>
                        <strong>Dependents:</strong> {snap.dependents.join(', ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Deletable snapshots */}
          {canDelete.length > 0 && (
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>✓ Will Be Deleted</h3>
              <div className={styles.snapshotList}>
                {canDelete.map((snap) => (
                  <div
                    key={snap.id}
                    className={`${styles.snapshotItem} ${
                      snap.isSyncedToBackup ? styles.synced : ''
                    }`}
                  >
                    <div className={styles.snapshotId}>
                      📸 {snap.id}
                    </div>
                    <div className={styles.meta}>
                      <span>{snap.date}</span>
                      {snap.isSyncedToBackup && (
                        <span className={styles.syncBadge}>
                          📤 Synced to backup
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Type-to-confirm */}
          {canDelete.length > 0 && (
            <div className={styles.section}>
              <label htmlFor="confirm-input" className={styles.confirmLabel}>
                Type <code className={styles.confirmCode}>delete</code> to confirm:
              </label>
              <input
                id="confirm-input"
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="delete"
                className={styles.confirmInput}
                disabled={isDeleting}
                autoFocus
              />
              {confirmText && !isConfirmed && (
                <p className={styles.confirmError}>
                  Type "delete" to confirm deletion
                </p>
              )}
            </div>
          )}

          {/* Message if nothing can be deleted */}
          {canDelete.length === 0 && blocked.length > 0 && (
            <div className={styles.section}>
              <p className={styles.message}>
                All selected snapshots are blocked from deletion because they have dependent incremental snapshots.
                You must delete the dependent snapshots first, or they will be orphaned.
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className={styles.footer}>
          <button
            onClick={onCancel}
            className={styles.cancelBtn}
            disabled={isDeleting}
          >
            Cancel
          </button>
          {canDelete.length > 0 && (
            <button
              onClick={handleDelete}
              className={styles.deleteBtn}
              disabled={!canProceed || isDeleting}
              title={!isConfirmed ? 'Type "delete" to confirm' : ''}
            >
              {isDeleting ? '🔄 Deleting...' : `🗑️ Delete ${canDelete.length}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default DeleteModal;
