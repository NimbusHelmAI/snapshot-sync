/**
 * SnapshotsTable Component
 *
 * Sortable table of snapshots with:
 * - Snapshot ID
 * - Type (full, daily, weekly, monthly, etc.)
 * - Date created
 * - Size (exclusive, from the server; "—" when it could not be measured)
 * - Config (root, home or src)
 * - Backup status (synced to external, or not)
 *
 * Shows a summary above the table with the snapshot count and the total size.
 */

import React, { useState, useMemo } from 'react';
import type { Snapshot } from '../types';
import { formatSize } from '../utils/snapshotApi';
import styles from './SnapshotsTable.module.css';

type SortColumn = 'id' | 'date' | 'type' | 'size' | 'config';
type SortDirection = 'asc' | 'desc';

interface SnapshotsTableProps {
  snapshots: Snapshot[];
  selectedIds: Set<string>;
  onSelectChange: (id: string, selected: boolean) => void;
  onDelete?: (ids: string[]) => void;
  onContextMenu?: (id: string, x: number, y: number) => void;
  showBackupStatus?: boolean;
  backupSyncedIds?: Set<string>;
}

/** The snapshot's type: the API's type field, else inferred from the ID suffix. */
const getSnapshotType = (snapshot: Snapshot): string => {
  if (snapshot.type) return snapshot.type;
  const id = snapshot.id;
  if (id.endsWith('-w')) return 'weekly';
  if (id.endsWith('-m')) return 'monthly';
  if (id.endsWith('-y')) return 'yearly';
  return 'full';
};

/** The value a column sorts by. undefined sorts last in either direction. */
const sortValue = (snapshot: Snapshot, column: SortColumn): string | number | undefined => {
  switch (column) {
    case 'id':
      // Snapper numbers are numeric: sort 999 before 1000, not after "1000".
      return Number(snapshot.id);
    case 'date':
      return snapshot.date;
    case 'type':
      return getSnapshotType(snapshot);
    case 'size':
      return snapshot.size;
    case 'config':
      return snapshot.config;
  }
};

export const SnapshotsTable: React.FC<SnapshotsTableProps> = ({
  snapshots,
  selectedIds,
  onSelectChange,
  onContextMenu,
  showBackupStatus = false,
  backupSyncedIds = new Set(),
}) => {
  const [sortColumn, setSortColumn] = useState<SortColumn>('date');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const sorted = useMemo(() => {
    const copy = [...snapshots];
    copy.sort((a, b) => {
      const aVal = sortValue(a, sortColumn);
      const bVal = sortValue(b, sortColumn);

      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      let cmp =
        typeof aVal === 'number' && typeof bVal === 'number'
          ? aVal - bVal
          : String(aVal).localeCompare(String(bVal));
      // Ties keep a stable order by ID.
      if (cmp === 0) cmp = Number(a.id) - Number(b.id);

      return sortDirection === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [snapshots, sortColumn, sortDirection]);

  const totals = useMemo(() => {
    let bytes = 0;
    let known = 0;
    for (const s of snapshots) {
      if (s.size != null) {
        bytes += s.size;
        known += 1;
      }
    }
    return { bytes, known, count: snapshots.length };
  }, [snapshots]);

  const handleHeaderClick = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const allSelected = snapshots.length > 0 && snapshots.every(s => selectedIds.has(s.id));

  const handleSelectAll = () => {
    if (allSelected) {
      snapshots.forEach(s => onSelectChange(s.id, false));
    } else {
      snapshots.forEach(s => onSelectChange(s.id, true));
    }
  };

  const sortIcon = (column: SortColumn) => {
    if (sortColumn !== column) return <span className={styles.sortIcon} />;
    return <span className={styles.sortIcon}>{sortDirection === 'asc' ? ' ▲' : ' ▼'}</span>;
  };

  const sortableHeader = (column: SortColumn, label: string, className: string) => (
    <th
      className={className}
      onClick={() => handleHeaderClick(column)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleHeaderClick(column);
        }
      }}
      role="button"
      tabIndex={0}
      aria-sort={
        sortColumn === column ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      {label} {sortIcon(column)}
    </th>
  );

  // checkbox, ID, date, type, size, config, actions; plus backup status when shown.
  const columnCount = 7 + (showBackupStatus ? 1 : 0);

  return (
    <div className={styles.wrapper}>
      <div className={styles.summary} aria-live="polite">
        <span>
          {totals.count} {totals.count === 1 ? 'snapshot' : 'snapshots'}
        </span>
        {totals.known > 0 && (
          <span
            title="Space that only these snapshots hold: what deleting them would free. Snapshots that share data are counted once, in the snapshots that do not share it."
          >
            · {formatSize(totals.bytes)} exclusive
          </span>
        )}
        {totals.known > 0 && totals.known < totals.count && (
          <span className={styles.summaryNote}>
            · size known for {totals.known} of {totals.count}
          </span>
        )}
      </div>

      <div className={styles.tableContainer}>
        <table className={styles.table}>
          <thead>
            <tr className={styles.headerRow}>
              <th className={styles.checkboxCol}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={handleSelectAll}
                  title="Select all snapshots"
                />
              </th>
              {sortableHeader('id', 'ID', styles.idCol)}
              {sortableHeader('date', 'Date', styles.dateCol)}
              {sortableHeader('type', 'Type', styles.typeCol)}
              {sortableHeader('size', 'Size', styles.sizeCol)}
              {sortableHeader('config', 'Config', styles.configCol)}
              {showBackupStatus && (
                <th className={styles.statusCol}>Backup Status</th>
              )}
              <th className={styles.actionsCol}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr className={styles.emptyRow}>
                <td colSpan={columnCount} className={styles.emptyCell}>
                  No snapshots
                </td>
              </tr>
            ) : (
              sorted.map((snapshot) => {
                const isSelected = selectedIds.has(snapshot.id);
                const type = getSnapshotType(snapshot);
                const isSynced = backupSyncedIds.has(snapshot.id);

                return (
                  <tr
                    key={snapshot.id}
                    className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
                    onClick={(e) => {
                      // Buttons and the checkbox handle their own clicks.
                      if ((e.target as HTMLElement).closest('button, input')) return;
                      onSelectChange(snapshot.id, !isSelected);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onContextMenu?.(snapshot.id, e.clientX, e.clientY);
                    }}
                  >
                    <td className={styles.checkboxCol}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => onSelectChange(snapshot.id, e.target.checked)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className={styles.idCol}>
                      <code className={styles.snapshotId}>{snapshot.id}</code>
                    </td>
                    <td className={styles.dateCol}>
                      {snapshot.date || '—'}
                    </td>
                    <td className={styles.typeCol}>
                      <span className={styles.typeTag}>
                        {type}
                      </span>
                    </td>
                    <td className={styles.sizeCol}>
                      {snapshot.size != null ? formatSize(snapshot.size) : '—'}
                    </td>
                    <td className={styles.configCol}>
                      {snapshot.config ?? '—'}
                    </td>
                    {showBackupStatus && (
                      <td className={styles.statusCol}>
                        {isSynced ? (
                          <span className={styles.synced} title="Synced to backup">✓ Synced</span>
                        ) : (
                          <span className={styles.notSynced} title="Not synced to backup">✗ Not synced</span>
                        )}
                      </td>
                    )}
                    <td className={styles.actionsCol}>
                      <button
                        className={styles.actionBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          onContextMenu?.(snapshot.id, e.clientX, e.clientY);
                        }}
                        title="Right-click for more options"
                      >
                        ⋯
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default SnapshotsTable;
