/**
 * SnapshotsTable Component
 *
 * Sortable, filterable table of snapshots with details like:
 * - Snapshot ID
 * - Type (full, daily, weekly, monthly, etc.)
 * - Date created
 * - Size
 * - Incremental chain depth
 * - Backup status (synced to external, or not)
 */

import React, { useState, useMemo } from 'react';
import type { Snapshot } from '../types';
import type { ColorScheme } from './ColorCustomizer';
import styles from './SnapshotsTable.module.css';

type SortColumn = 'id' | 'date' | 'type' | 'size' | 'chain';
type SortDirection = 'asc' | 'desc';

interface SnapshotsTableProps {
  snapshots: Snapshot[];
  selectedIds: Set<string>;
  onSelectChange: (id: string, selected: boolean) => void;
  onDelete?: (ids: string[]) => void;
  onContextMenu?: (id: string, x: number, y: number) => void;
  showBackupStatus?: boolean;
  backupSyncedIds?: Set<string>;
  customColors?: ColorScheme;
}

export const SnapshotsTable: React.FC<SnapshotsTableProps> = ({
  snapshots,
  selectedIds,
  onSelectChange,
  onContextMenu,
  showBackupStatus = false,
  backupSyncedIds = new Set(),
  customColors,
}) => {
  const [sortColumn, setSortColumn] = useState<SortColumn>('date');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const sorted = useMemo(() => {
    const copy = [...snapshots];
    copy.sort((a, b) => {
      let aVal: any = a[sortColumn as keyof typeof a];
      let bVal: any = b[sortColumn as keyof typeof b];

      // Handle nullish values
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return sortDirection === 'asc' ? 1 : -1;
      if (bVal == null) return sortDirection === 'asc' ? -1 : 1;

      // For date strings in YYYY-MM-DD format, compare as strings (lexicographic works)
      if (sortColumn === 'date' && typeof aVal === 'string' && typeof bVal === 'string') {
        const cmp = aVal.localeCompare(bVal);
        return sortDirection === 'asc' ? cmp : -cmp;
      }

      // Numeric comparison
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        const cmp = aVal - bVal;
        return sortDirection === 'asc' ? cmp : -cmp;
      }

      // String comparison
      const cmp = String(aVal).localeCompare(String(bVal));
      return sortDirection === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [snapshots, sortColumn, sortDirection]);

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

  const SortIcon: React.FC<{ column: SortColumn }> = ({ column }) => {
    if (sortColumn !== column) return <span className={styles.sortIcon} />;
    return <span className={styles.sortIcon}>{sortDirection === 'asc' ? ' ▲' : ' ▼'}</span>;
  };

    const getSnapshotType = (snapshot: Snapshot): string => {
    // If snapshot has a 'type' field, use it; otherwise infer from ID pattern
    if ('type' in snapshot && snapshot.type) return snapshot.type;

    // Common patterns: daily (no suffix), weekly (ends with -w), monthly (ends with -m)
    const id = snapshot.id;
    if (id.endsWith('-w')) return 'weekly';
    if (id.endsWith('-m')) return 'monthly';
    if (id.endsWith('-y')) return 'yearly';
    return 'full';
  };

  return (
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
            <th
              className={styles.idCol}
              onClick={() => handleHeaderClick('id')}
              role="button"
              tabIndex={0}
            >
              ID <SortIcon column="id" />
            </th>
            <th
              className={styles.dateCol}
              onClick={() => handleHeaderClick('date')}
              role="button"
              tabIndex={0}
            >
              Date <SortIcon column="date" />
            </th>
            <th
              className={styles.typeCol}
              onClick={() => handleHeaderClick('type')}
              role="button"
              tabIndex={0}
            >
              Type <SortIcon column="type" />
            </th>
            {showBackupStatus && (
              <th className={styles.statusCol}>Backup Status</th>
            )}
            <th className={styles.actionsCol}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr className={styles.emptyRow}>
              <td colSpan={showBackupStatus ? 6 : 5} className={styles.emptyCell}>
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
                    <span
                      className={styles.typeTag}
                      style={
                        customColors && customColors[type as keyof typeof customColors]
                          ? {
                              backgroundColor: customColors[type as keyof typeof customColors].bg,
                              color: customColors[type as keyof typeof customColors].text,
                              borderColor: customColors[type as keyof typeof customColors].border,
                            }
                          : {}
                      }
                    >
                      {type}
                    </span>
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
  );
};

export default SnapshotsTable;
