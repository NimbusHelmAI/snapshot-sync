/**
 * DeleteDialog
 *
 * Deletes the selected snapshots of one config from one disk (NHA-107).
 *
 * Flow: the dialog previews the batch first (the API checks it against btrfs and
 * the exported links, and queues nothing). It shows what would be deleted and
 * what would be refused. A snapshot with no copy on the other disk is deleted
 * only after the user ticks the confirmation. Submitting queues the batch for the
 * host, which checks it again from btrfs before it deletes anything; the dialog
 * then polls for the host's result.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  previewDelete,
  requestDelete,
  loadDeleteResult,
  type DeletePlan,
  type DeleteResult,
  type DeleteSide,
} from '../utils/snapshotApi';
import styles from './DeleteDialog.module.css';

/** How long to wait for the host to run a queued delete before giving up on the wait. */
const POLL_MS = 1000;
const POLL_ATTEMPTS = 120;

export interface DeleteDialogProps {
  side: DeleteSide;
  diskLabel: string;
  diskPath: string;
  config: string;
  ids: string[];
  onClose: () => void;
  /** Called once with the host's result, so the caller can reload and deselect. */
  onDone: (result: DeleteResult) => void;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const DeleteDialog: React.FC<DeleteDialogProps> = ({
  side,
  diskLabel,
  diskPath,
  config,
  ids,
  onClose,
  onDone,
}) => {
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [confirmOnlyCopy, setConfirmOnlyCopy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<DeleteResult | null>(null);
  // Kept in a ref so a re-render of the caller does not restart the poll.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const diskName = side === 'source' ? 'local disk' : 'backup disk';
  const otherName = side === 'source' ? 'backup disk' : 'local disk';

  // Preview the batch once, when the dialog opens.
  useEffect(() => {
    let alive = true;
    previewDelete(side, config, ids, diskPath)
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch((error) => {
        if (alive) setPlanError(errorText(error));
      });
    return () => {
      alive = false;
    };
    // The preview is for the batch the dialog was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for the host's result after the request is queued.
  useEffect(() => {
    if (!requestId) return;
    let alive = true;
    let attempts = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      attempts += 1;
      try {
        const found = await loadDeleteResult(requestId);
        if (!alive) return;
        if (found) {
          setResult(found);
          setRequestId(null);
          onDoneRef.current(found);
          return;
        }
      } catch (error) {
        if (!alive) return;
        setSubmitError(errorText(error));
        setRequestId(null);
        return;
      }
      if (attempts >= POLL_ATTEMPTS) {
        setSubmitError(
          'The host has not run this delete yet. Check that snapshot-delete.path is active on the host.'
        );
        setRequestId(null);
        return;
      }
      timeout = setTimeout(poll, POLL_MS);
    };
    timeout = setTimeout(poll, POLL_MS);

    return () => {
      alive = false;
      if (timeout) clearTimeout(timeout);
    };
  }, [requestId]);

  const onlyCopyAllowed = plan ? plan.onlyCopy.filter((id) => plan.allowed.includes(id)) : [];
  const hasRefused = (plan?.refused.length ?? 0) > 0;
  const submitting = requestId !== null;
  const canSubmit =
    !!plan &&
    !hasRefused &&
    plan.allowed.length > 0 &&
    (onlyCopyAllowed.length === 0 || confirmOnlyCopy) &&
    !submitting &&
    !result;

  const submit = async () => {
    if (!plan) return;
    setSubmitError(null);
    try {
      // Submit exactly the batch the preview showed.
      const id = await requestDelete(side, config, plan.allowed, diskPath, confirmOnlyCopy);
      setRequestId(id);
    } catch (error) {
      // A 409 here means the snapshots changed since the preview.
      setSubmitError(errorText(error));
    }
  };

  return (
    <div className={styles.overlay} role="presentation">
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
        <div className={styles.header}>
          <h2 id="delete-dialog-title">
            Delete from {diskName}: {diskLabel}
          </h2>
          <button className={styles.close} onClick={onClose} aria-label="Close" disabled={submitting}>
            ×
          </button>
        </div>

        <div className={styles.body}>
          <p className={styles.note}>
            Config <strong>{config}</strong>, {ids.length} selected snapshot{ids.length === 1 ? '' : 's'}.
            Snapshots are deleted on the {diskName}. The {otherName} is not changed.
          </p>

          {!plan && !planError && <p>Checking the selection…</p>}

          {planError && <p className={styles.error}>{planError}</p>}

          {plan && !result && (
            <>
              {plan.allowed.length > 0 ? (
                <section>
                  <h3>Will delete ({plan.allowed.length})</h3>
                  <p className={styles.ids}>{plan.allowed.join(', ')}</p>
                </section>
              ) : (
                <p className={styles.warn}>Nothing in the selection can be deleted.</p>
              )}

              {hasRefused && (
                <section>
                  <h3>Not deleted ({plan.refused.length})</h3>
                  <ul className={styles.refused}>
                    {plan.refused.map((r) => (
                      <li key={r.id}>
                        <strong>{r.id}</strong>: {r.reason}
                      </li>
                    ))}
                  </ul>
                  <p className={styles.note}>
                    Deselect these snapshots and open the dialog again to delete the rest.
                  </p>
                </section>
              )}

              {onlyCopyAllowed.length > 0 && (
                <section className={styles.onlyCopy}>
                  <h3>Only copy</h3>
                  <p>
                    No copy of these snapshots exists on the {otherName}. Deleting them removes the
                    only copy: {onlyCopyAllowed.join(', ')}.
                  </p>
                  <label className={styles.confirmRow}>
                    <input
                      type="checkbox"
                      checked={confirmOnlyCopy}
                      onChange={(e) => setConfirmOnlyCopy(e.target.checked)}
                      disabled={submitting}
                    />
                    I understand these have no other copy and want to delete them.
                  </label>
                </section>
              )}
            </>
          )}

          {submitting && <p>Queued. Waiting for the host to run the delete…</p>}

          {submitError && <p className={styles.error}>{submitError}</p>}

          {result && (
            <section>
              <h3>Result: {result.status}</h3>
              <p>
                Deleted: {result.deleted.length > 0 ? result.deleted.join(', ') : 'none'}
              </p>
              {result.refused.length > 0 && (
                <ul className={styles.refused}>
                  {result.refused.map((r) => (
                    <li key={r.id}>
                      <strong>{r.id}</strong>: {r.reason}
                    </li>
                  ))}
                </ul>
              )}
              {result.error && <p className={styles.error}>{result.error}</p>}
            </section>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.secondary} onClick={onClose} disabled={submitting}>
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button className={styles.primary} onClick={submit} disabled={!canSubmit}>
              {plan ? `Delete ${plan.allowed.length}` : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
