#!/usr/bin/env bash
# Tests the delete-safety rules in backend/src/deleteCheck.ts. Compiles the module
# into a temp folder and runs the assertions with node. Changes nothing in the repo.
set -euo pipefail

# Needs node and npx for the delete-rule tests, and python3 for the JSON checks.
for tool in node npx python3; do
  command -v "$tool" >/dev/null || { echo "missing $tool: install it to run this test" >&2; exit 1; }
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

(cd "$ROOT/backend" && npx tsc src/deleteCheck.ts --outDir "$OUT" --module commonjs --target es2020 --strict --skipLibCheck)

node - "$OUT/deleteCheck.js" <<'JS'
const assert = require('node:assert/strict');
const { checkDelete, checkBackupDelete, localParentOf, planDelete, sourceItem, backupItem } = require(process.argv[2]);

const now = '2026-11-01T00:00:00Z';

// Source: 1382 (uuid A) has a backup copy 1390; 1400 (uuid B) has none;
// 1385 is built on 1382. 1382 also exists on the backup under another UUID.
const local = {
  config: 'root',
  exportedAt: now,
  snapshots: {
    1382: { uuid: 'A', parentUuid: null },
    1385: { uuid: 'C', parentUuid: 'A' },
    1400: { uuid: 'B', parentUuid: null },
  },
};
const backup = {
  path: '/mnt/Backup',
  config: 'root',
  exportedAt: now,
  parentOf: { 1390: null, 1391: '1390', 1382: null },
  snapshots: {
    1390: { uuid: 'X1', receivedUuid: 'A' },   // copy of source 1382
    1391: { uuid: 'X2', receivedUuid: 'C' },   // copy of source 1385, built on 1390
    1382: { uuid: 'X3', receivedUuid: 'Z' },   // same number, different snapshot
  },
};

// 1. Backed up: found by UUID, not by number.
let r = checkDelete('root', '1382', local, backup);
assert.equal(r.onSource, true);
assert.deepEqual(r.backupIds, ['1390']);
assert.equal(r.onlyCopy, false);

// 2. Only copy: no backup holds UUID B, even though a backup has number 1400.
r = checkDelete('root', '1400', local, backup);
assert.deepEqual(r.backupIds, []);
assert.equal(r.onlyCopy, true);

// 3. Same number on the backup must not count as a copy.
const numberOnly = checkDelete('root', '1382', local, {
  ...backup,
  snapshots: { 1382: { uuid: 'X3', receivedUuid: 'Z' } },
});
assert.equal(numberOnly.onlyCopy, true);

// 4. Not on the source: nothing to protect here.
r = checkDelete('root', '999', local, backup);
assert.equal(r.onSource, false);
assert.equal(r.onlyCopy, false);

// 5. Source dependents are the snapshots whose parent UUID is ours.
r = checkDelete('root', '1382', local, backup);
assert.deepEqual(r.localDependents, ['1385']);

// 6. Backup dependents are backup snapshots built on one of our copies.
assert.deepEqual(r.backupDependents, ['1391']);

// 7. No exports at all: source is unknown, nothing is claimed.
r = checkDelete('root', '1382', null, null);
assert.equal(r.onSource, false);
assert.equal(r.onlyCopy, false);

// 8. Numeric order: 999 before 1000.
const sorted = checkDelete('root', '5', { ...local, snapshots: { 5: { uuid: 'S', parentUuid: null } } }, {
  ...backup,
  snapshots: { 1000: { uuid: 'p', receivedUuid: 'S' }, 999: { uuid: 'q', receivedUuid: 'S' } },
});
assert.deepEqual(sorted.backupIds, ['999', '1000']);

// 9. Local parents by UUID; a parent missing from the export maps to null.
assert.deepEqual(localParentOf(local), { 1382: null, 1385: '1382', 1400: null });

// 10. Backup side: a copy finds its source snapshots by received UUID.
let b = checkBackupDelete('root', '1390', local, backup);
assert.equal(b.onBackup, true);
assert.deepEqual(b.sourceIds, ['1382']);
assert.deepEqual(b.backupDependents, ['1391']);

// 11. Backup side: a copy whose received UUID matches no source snapshot is an only copy.
b = checkBackupDelete('root', '1382', local, backup);
assert.deepEqual(b.sourceIds, []);
assert.equal(b.onBackup, true);

// 12. Backup side: not on the backup disk.
b = checkBackupDelete('root', '1400', local, backup);
assert.equal(b.onBackup, false);

// 13. Source batch: a snapshot with a newer dependent outside the batch is refused.
let plan = planDelete([sourceItem(checkDelete('root', '1382', local, backup))], 'source', false);
assert.deepEqual(plan.allowed, []);
assert.match(plan.refused[0].reason, /newer snapshot 1385 is built on it/);

// 14. Source only copy: refused without confirmation, allowed with it.
plan = planDelete([sourceItem(checkDelete('root', '1400', local, backup))], 'source', false);
assert.deepEqual(plan.onlyCopy, ['1400']);
assert.equal(plan.refused[0].reason, 'only copy: no backup holds it; confirm to delete it');
plan = planDelete([sourceItem(checkDelete('root', '1400', local, backup))], 'source', true);
assert.deepEqual(plan.allowed, ['1400']);

// 15. Source: not on the source disk.
plan = planDelete([sourceItem(checkDelete('root', '999', local, backup))], 'source', false);
assert.equal(plan.refused[0].reason, 'not on the source disk');

// 16. Backup batch: a copy built on by another copy in the batch is allowed together.
plan = planDelete([
  backupItem(checkBackupDelete('root', '1390', local, backup)),
  backupItem(checkBackupDelete('root', '1391', local, backup)),
], 'backup', false);
assert.deepEqual(plan.allowed, ['1390', '1391']);

// 17. Backup only copy: refused without confirmation, allowed with it.
plan = planDelete([backupItem(checkBackupDelete('root', '1382', local, backup))], 'backup', false);
assert.equal(plan.refused[0].reason, 'only copy: no source snapshot holds it; confirm to delete it');
plan = planDelete([backupItem(checkBackupDelete('root', '1382', local, backup))], 'backup', true);
assert.deepEqual(plan.allowed, ['1382']);

console.log('delete-check: all assertions passed');
JS
