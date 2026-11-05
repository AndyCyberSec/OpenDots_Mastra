import { useEffect, useRef, useState } from 'react';
import { Check, Users } from 'lucide-react';
import {
  delegationActionSchema,
  type DelegationApprovalView,
} from '../shared/delegation';
import { api } from './api';

/**
 * Owner approval for Dot-to-Dot delegation.
 *
 * The card shows the server's record of the exact request and the current names
 * of both Dots (which may have been renamed since the request was created).
 * Nothing runs until Approve; the target then applies its own permissions.
 */
export function DelegationCard({
  args,
  status: toolStatus,
  result,
  respond,
}: {
  args: unknown;
  status: string;
  result?: unknown;
  respond?: (result: unknown) => Promise<void>;
}) {
  const action = delegationActionSchema.safeParse(args);
  const approvalId = action.success ? action.data.approvalId : '';
  const [view, setView] = useState<DelegationApprovalView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<{
    status: string;
    text?: string;
    message?: string;
  }>();
  const finished = toolStatus === 'complete' && !outcome;
  const delivered = useRef(false);
  const recorded =
    !outcome && result && typeof result === 'object'
      ? (result as { status?: string; text?: string; message?: string })
      : undefined;

  useEffect(() => {
    if (!approvalId) return;
    let active = true;
    void api<DelegationApprovalView>(
      `/delegations/approvals/${encodeURIComponent(approvalId)}`,
    )
      .then(async (value) => {
        if (!active) return;
        setView(value);
        const terminal =
          value.status === 'completed'
            ? {
                status: 'completed',
                text: value.result ?? '',
                approved: true,
              }
            : value.status === 'declined'
              ? { status: 'declined', approved: false }
              : value.status === 'failed'
                ? {
                    status: 'failed',
                    message: value.error ?? 'The delegated request failed.',
                    approved: true,
                  }
                : value.expiresAt <= Date.now() && value.status === 'pending'
                  ? {
                      status: 'expired',
                      message: 'This delegation request expired.',
                      approved: false,
                    }
                  : undefined;
        if (!terminal) return;
        setOutcome(terminal);
        // A decision may have been made in another tab: deliver it once so the
        // waiting model can continue, unless this card already shows a result.
        if (respond && toolStatus !== 'complete' && !delivered.current) {
          delivered.current = true;
          await respond(
            terminal.approved
              ? {
                  approved: true,
                  status: terminal.status,
                  ...(terminal.text ? { text: terminal.text } : {}),
                  ...(terminal.message ? { message: terminal.message } : {}),
                }
              : {
                  approved: false,
                  status: 'declined',
                  message:
                    'The owner declined this delegation. Do not perform it or try another way.',
                },
          ).catch(() => {
            delivered.current = false;
          });
        }
      })
      .catch((cause) =>
        active
          ? setError(
              cause instanceof Error
                ? cause.message
                : 'Could not load this delegation request.',
            )
          : undefined,
      );
    return () => {
      active = false;
    };
  }, [approvalId]);

  const decide = async (approve: boolean) => {
    if (!respond || !action.success || busy) return;
    setBusy(true);
    setError('');
    try {
      const value = await api<{
        status: string;
        text?: string;
        message?: string;
        target?: { id: string; name: string };
        threadId?: string;
      }>(
        `/delegations/approvals/${encodeURIComponent(approvalId)}/actions`,
        'POST',
        {
          action: approve ? 'approve' : 'decline',
        },
      );
      if (value.status === 'busy' || value.status === 'unavailable') {
        // Not claimed; the owner can retry.
        setError(value.message ?? 'The request cannot run right now.');
        return;
      }
      setOutcome(value);
      await respond(
        approve
          ? {
              approved: true,
              status: value.status,
              target: value.target,
              threadId: value.threadId,
              ...(value.text ? { text: value.text } : {}),
              ...(value.message ? { message: value.message } : {}),
            }
          : {
              approved: false,
              status: 'declined',
              message:
                'The owner declined this delegation. Do not perform it or try another way.',
            },
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not complete this request.',
      );
    } finally {
      setBusy(false);
    }
  };

  const shown = outcome ?? recorded;
  const label = finished
    ? 'Ended'
    : shown?.status === 'completed'
      ? 'Completed'
      : shown?.status === 'declined'
        ? 'Declined'
        : shown?.status === 'failed'
          ? 'Failed'
          : 'Needs your approval';

  return (
    <section className="page-review-card" aria-label="Approve delegation">
      <header>
        <Users size={17} />
        <strong>
          {view ? `${view.caller.name} → ${view.target.name}` : 'Delegation'}
        </strong>
        <span>{label}</span>
      </header>
      <div className="page-review-body">
        <h3>
          {action.success ? action.data.summary : 'Preparing the request…'}
        </h3>
        <p className="muted">
          {view
            ? view.request
            : 'The exact request is loaded from the server before you decide.'}
        </p>
        {view && (
          <p className="muted">
            {view.target.name} will run this with its own permissions and
            approval gates. Nothing runs until you approve.
          </p>
        )}
        {shown?.text && (
          <div className="connection-action-result">
            <strong>Result from {view?.target.name ?? 'the specialist'}</strong>
            <pre>{shown.text}</pre>
          </div>
        )}
        {shown?.message && shown.status !== 'completed' && (
          <div className="connection-action-result failed">
            <strong>Delegation {shown.status}</strong>
            <pre>{shown.message}</pre>
          </div>
        )}
        {error && (
          <div className="connection-action-result failed">
            <strong>Cannot run</strong>
            <pre>{error}</pre>
          </div>
        )}
      </div>
      <footer>
        {!finished && !shown && respond && (
          <>
            <button
              type="button"
              className="review-primary"
              disabled={busy || !action.success || !view}
              onClick={() => void decide(true)}
            >
              <Check size={15} />
              {busy ? 'Delegating…' : 'Approve & delegate'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Decline
            </button>
          </>
        )}
        <small>
          {busy
            ? 'The target specialist is working. This can take a while.'
            : shown
              ? ''
              : 'The card shows the exact request. Approving runs one turn in the target Dot’s conversation.'}
        </small>
      </footer>
    </section>
  );
}
