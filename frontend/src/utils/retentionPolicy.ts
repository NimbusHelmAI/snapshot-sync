/**
 * Snapshot Retention Policy Utilities
 *
 * Handles retention policy configuration, chain validation, and safe deletion.
 * Default: Friday 02:00 AM Israeli time (UTC+2/+3)
 *          Daily: 7 days
 *          Weekly: 4 weeks
 *          Monthly: 6 months
 */

/** Day of week for cleanup scheduling */
export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

/** Retention policy configuration, stored in config.yml */
export interface RetentionPolicy {
  // Cleanup scheduling
  cleanupDay: DayOfWeek;
  cleanupHour: number; // 0-23, UTC+0 (adjusted by backend)

  // Retention periods
  dailyRetention: number;    // days
  weeklyRetention: number;   // weeks (converted to days * 7)
  monthlyRetention: number;  // months (converted to days * 30)
}

/** Default retention policy: Friday 02:00 AM Israeli time */
export const defaultRetentionPolicy: RetentionPolicy = {
  cleanupDay: 'friday',
  cleanupHour: 2,
  dailyRetention: 7,
  weeklyRetention: 4,
  monthlyRetention: 6,
};

/** Snapshot metadata for chain and retention calculations */
export interface SnapshotMetadata {
  id: string;
  date: string; // YYYY-MM-DD format
  type: 'full' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  isIncremental: boolean;
  parentId?: string; // ID of parent snapshot if incremental
  childIds: string[]; // IDs of snapshots that depend on this one
  size?: number;
}

/**
 * Infer snapshot type from ID pattern
 * Common patterns: daily (no suffix), weekly (-w), monthly (-m), yearly (-y)
 */
export function inferSnapshotType(id: string): SnapshotMetadata['type'] {
  if (id.endsWith('-w')) return 'weekly';
  if (id.endsWith('-m')) return 'monthly';
  if (id.endsWith('-y')) return 'yearly';
  return 'daily';
}

/**
 * Build a chain map: { parentId -> [childIds] }
 * This allows quick lookup of dependencies when validating deletion safety
 */
export function buildChainMap(snapshots: SnapshotMetadata[]): Map<string, string[]> {
  const chains = new Map<string, string[]>();

  snapshots.forEach(snap => {
    if (snap.parentId) {
      if (!chains.has(snap.parentId)) {
        chains.set(snap.parentId, []);
      }
      chains.get(snap.parentId)!.push(snap.id);
    }
  });

  return chains;
}

/**
 * Check if deleting a snapshot would break the chain
 *
 * Safe to delete if:
 * 1. It has no children (not a parent of any incremental snapshot), OR
 * 2. It's the last in the chain (no dependents)
 *
 * Unsafe to delete if:
 * 1. It has children (deleting it orphans incremental snapshots)
 */
export function canDeleteSnapshot(
  snapshotId: string,
    chainMap: Map<string, string[]>
): {
  canDelete: boolean;
  reason?: string;
  dependents?: string[];
} {
  const children = chainMap.get(snapshotId);

  if (children && children.length > 0) {
    return {
      canDelete: false,
      reason: `Cannot delete: ${children.length} incremental snapshot(s) depend on this one`,
      dependents: children,
    };
  }

  return { canDelete: true };
}

/**
 * Determine if a snapshot should be kept based on retention policy
 */
export function shouldRetainSnapshot(
  snapshot: SnapshotMetadata,
  policy: RetentionPolicy,
  referenceDate: Date = new Date()
): { retain: boolean; reason?: string } {
  const snapshotDate = new Date(snapshot.date);
  const ageInDays = Math.floor(
    (referenceDate.getTime() - snapshotDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  // Always keep full snapshots if they're within their retention period
  if (snapshot.type === 'full' || snapshot.type === 'yearly') {
    const retentionDays = policy.monthlyRetention * 30; // Conservative estimate
    if (ageInDays <= retentionDays) {
      return {
        retain: true,
        reason: `Full snapshot within ${policy.monthlyRetention}-month retention`,
      };
    }
  }

  // Check daily snapshots
  if (snapshot.type === 'daily') {
    if (ageInDays <= policy.dailyRetention) {
      return {
        retain: true,
        reason: `Daily snapshot within ${policy.dailyRetention}-day retention`,
      };
    }
  }

  // Check weekly snapshots
  if (snapshot.type === 'weekly') {
    const retentionDays = policy.weeklyRetention * 7;
    if (ageInDays <= retentionDays) {
      return {
        retain: true,
        reason: `Weekly snapshot within ${policy.weeklyRetention}-week retention`,
      };
    }
  }

  // Check monthly snapshots
  if (snapshot.type === 'monthly') {
    const retentionDays = policy.monthlyRetention * 30;
    if (ageInDays <= retentionDays) {
      return {
        retain: true,
        reason: `Monthly snapshot within ${policy.monthlyRetention}-month retention`,
      };
    }
  }

  return {
    retain: false,
    reason: `Exceeds retention policy (${snapshot.type} snapshot, ${ageInDays} days old)`,
  };
}

/**
 * Plan snapshots to delete based on retention policy
 * Returns a list of snapshots that can be safely deleted
 */
export function planDeletion(
  snapshots: SnapshotMetadata[],
  policy: RetentionPolicy,
  referenceDate: Date = new Date()
): {
  canDelete: SnapshotMetadata[];
  mustKeep: SnapshotMetadata[];
  warnings: Array<{ snapshotId: string; message: string }>;
} {
  const chainMap = buildChainMap(snapshots);
  const canDelete: SnapshotMetadata[] = [];
  const mustKeep: SnapshotMetadata[] = [];
  const warnings: Array<{ snapshotId: string; message: string }> = [];

  snapshots.forEach((snap) => {
    // First check retention policy
    const retentionCheck = shouldRetainSnapshot(snap, policy, referenceDate);
    if (retentionCheck.retain) {
      mustKeep.push(snap);
      return;
    }

    // Then check chain safety
    const chainCheck = canDeleteSnapshot(snap.id, chainMap);
    if (!chainCheck.canDelete) {
      mustKeep.push(snap);
      warnings.push({
        snapshotId: snap.id,
        message: chainCheck.reason || 'Cannot delete: has dependent snapshots',
      });
      return;
    }

    // Safe to delete
    canDelete.push(snap);
  });

  return { canDelete, mustKeep, warnings };
}

/**
 * Format retention policy for display
 */
export function formatRetentionPolicy(policy: RetentionPolicy): string {
  const day = policy.cleanupDay.charAt(0).toUpperCase() + policy.cleanupDay.slice(1);
  const hour = String(policy.cleanupHour).padStart(2, '0');

  return (
    `${day} at ${hour}:00 UTC — ` +
    `Daily: ${policy.dailyRetention}d, ` +
    `Weekly: ${policy.weeklyRetention}w, ` +
    `Monthly: ${policy.monthlyRetention}mo`
  );
}
