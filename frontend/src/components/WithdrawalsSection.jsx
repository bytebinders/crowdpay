import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../services/api';
import { stellarExpertTxUrl } from '../config/stellar';

const ELIGIBLE = ['active', 'funded'];

function statusLabel(row) {
  if (row.status === 'pending') {
    if (!row.creator_signed) return 'Awaiting creator signature';
    if (!row.platform_signed) return 'Awaiting platform release';
  }
  if (row.status === 'submitted') return 'Released on-chain';
  if (row.status === 'denied') return 'Denied / cancelled';
  if (row.status === 'failed') return 'Failed (see audit)';
  return row.status;
}

export default function WithdrawalsSection({ campaign, user, token, onReleased }) {
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cap, setCap] = useState({ can_approve_platform: false });
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ destination_key: '', amount: '' });
  const [busyId, setBusyId] = useState(null);
  const [eventsById, setEventsById] = useState({});
  const [openAudit, setOpenAudit] = useState(null);

  const isCreator = user?.id && campaign.creator_id === user.id;
  const isAdmin = user?.role === 'admin';
  const canView = !forbidden && (isCreator || cap.can_approve_platform);
  const hasPending = rows.some((r) => r.status === 'pending');
  const canOpenRequest =
    isCreator && ELIGIBLE.includes(campaign.status) && !hasPending;

  const refresh = useCallback(async () => {
    if (!token) return;
    setError('');
    try {
      const caps = await api.getWithdrawalCapabilities(token);
      setCap(caps);
      const list = await api.listWithdrawals(campaign.id, token);
      setRows(list);
      setForbidden(false);
    } catch (e) {
      if (e.status === 403) {
        setForbidden(true);
        setRows([]);
      } else {
        setError(e.message || 'Could not load withdrawals.');
      }
    } finally {
      setLoading(false);
    }
  }, [campaign.id, token]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    refresh();
  }, [token, refresh]);

  async function loadEvents(id) {
    if (openAudit === id) {
      setOpenAudit(null);
      return;
    }
    if (eventsById[id]) {
      setOpenAudit(id);
      return;
    }
    try {
      const ev = await api.getWithdrawalEvents(id, token);
      setEventsById((m) => ({ ...m, [id]: ev }));
      setOpenAudit(id);
    } catch (e) {
      setError(e.message || 'Could not load audit trail.');
    }
  }

  async function handleRequest(e) {
    e.preventDefault();
    setBusyId('new');
    setError('');
    try {
      await api.requestWithdrawal(
        {
          campaign_id: campaign.id,
          destination_key: form.destination_key.trim(),
          amount: form.amount.trim(),
        },
        token
      );
      setForm({ destination_key: '', amount: '' });
      await refresh();
      onReleased?.();
    } catch (err) {
      setError(err.message || 'Request failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function runAction(id, fn) {
    setBusyId(id);
    setError('');
    try {
      await fn();
      await refresh();
      onReleased?.();
    } catch (err) {
      setError(err.message || 'Action failed.');
    } finally {
      setBusyId(null);
    }
  }

  if (!token || forbidden) return null;
  if (loading) {
    return (
      <section style={styles.section} aria-label="Fund release">
        <h2 style={styles.h2}>Manual fund release</h2>
        <p style={{ color: '#888', fontSize: '0.9rem' }}>Loading…</p>
      </section>
    );
  }
  if (!canView) return null;

  return (
    <section style={styles.section} aria-label="Fund release">
      <h2 style={styles.h2}>Manual fund release</h2>
      <p style={styles.intro}>
        Funds leave the campaign wallet only after <strong>you</strong> (creator) and <strong>CrowdPay</strong>{' '}
        (platform) both approve the same transaction. Every step is logged for review.
      </p>

      {!ELIGIBLE.includes(campaign.status) && (
        <p className="alert alert--info" role="status">
          New withdrawal requests are disabled while campaign status is <strong>{campaign.status}</strong>.
        </p>
      )}

      {error && (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}

      {canOpenRequest && (
        <form onSubmit={handleRequest} style={styles.card}>
          <h3 style={styles.h3}>Request a release</h3>
          <p style={styles.hint}>Destination must be a valid Stellar public key. Amount is in {campaign.asset_type}.</p>
          <label className="label-strong" htmlFor="wd-dest">
            Destination address
          </label>
          <input
            id="wd-dest"
            value={form.destination_key}
            onChange={(e) => setForm((f) => ({ ...f, destination_key: e.target.value }))}
            placeholder="G…"
            required
            style={{ marginBottom: '0.75rem' }}
            autoComplete="off"
          />
          <label className="label-strong" htmlFor="wd-amt">
            Amount ({campaign.asset_type})
          </label>
          <input
            id="wd-amt"
            type="number"
            inputMode="decimal"
            min="0.0000001"
            step="any"
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            required
            style={{ marginBottom: '0.75rem' }}
          />
          <button type="submit" className="btn-primary" disabled={busyId === 'new'} style={{ width: '100%' }}>
            {busyId === 'new' ? 'Submitting…' : 'Submit request'}
          </button>
        </form>
      )}

      {isCreator && hasPending && (
        <p className="alert alert--info" style={{ marginTop: '1rem' }} role="status">
          You have a pending release. Complete signatures, cancel before you sign, or wait for platform decision.
        </p>
      )}

      <h3 style={{ ...styles.h3, marginTop: '1.5rem' }}>Requests & audit</h3>
      {rows.length === 0 ? (
        <p style={{ color: '#888', fontSize: '0.9rem' }}>No withdrawal activity yet.</p>
      ) : (
        <ul style={styles.list}>
          {rows.map((row) => (
            <li key={row.id} style={styles.row}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={styles.rowTitle}>
                  {Number(row.amount).toLocaleString()} {campaign.asset_type} →{' '}
                  <code style={styles.code}>{row.destination_key.slice(0, 6)}…{row.destination_key.slice(-4)}</code>
                </div>
                <div style={styles.meta}>{statusLabel(row)}</div>
                {row.denial_reason && (
                  <div className="alert alert--error" style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                    {row.denial_reason}
                  </div>
                )}
                {row.tx_hash && (
                  <a
                    href={stellarExpertTxUrl(row.tx_hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '0.82rem', color: '#7c3aed', fontWeight: 600 }}
                  >
                    View transaction
                  </a>
                )}
                {openAudit === row.id && eventsById[row.id] && (
                  <ol style={styles.audit}>
                    {eventsById[row.id].map((ev) => (
                      <li key={ev.id}>
                        <strong>{ev.action}</strong>
                        {ev.note ? ` — ${ev.note}` : ''}
                        <span style={{ color: '#888' }}>
                          {' '}
                          ({new Date(ev.created_at).toLocaleString()})
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <div style={styles.actions}>
                <button type="button" className="btn-secondary" onClick={() => loadEvents(row.id)} style={{ fontSize: '0.8rem' }}>
                  {openAudit === row.id ? 'Hide audit' : 'Audit trail'}
                </button>
                {row.status === 'pending' && !row.creator_signed && isCreator && (
                  <>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busyId === row.id}
                      onClick={() =>
                        runAction(row.id, () =>
                          api.cancelWithdrawal(row.id, { reason: 'Cancelled by creator' }, token)
                        )
                      }
                      style={{ fontSize: '0.8rem' }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={busyId === row.id}
                      onClick={() => runAction(row.id, () => api.approveWithdrawalCreator(row.id, token))}
                      style={{ fontSize: '0.8rem' }}
                    >
                      Sign as creator
                    </button>
                  </>
                )}
                {row.status === 'pending' && row.creator_signed && !row.platform_signed && cap.can_approve_platform && (
                  <>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busyId === row.id}
                      onClick={async () => {
                        const reason = window.prompt(
                          'Rejection reason (visible in audit log):',
                          'Rejected by platform'
                        );
                        if (reason === null) return;
                        await runAction(row.id, () =>
                          api.rejectWithdrawal(row.id, { reason: reason || 'Rejected' }, token)
                        );
                      }}
                      style={{ fontSize: '0.8rem' }}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={busyId === row.id}
                      onClick={() => runAction(row.id, () => api.approveWithdrawalPlatform(row.id, token))}
                      style={{ fontSize: '0.8rem' }}
                    >
                      Admin approve & submit
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {cap.can_approve_platform && isAdmin && (
        <p style={{ ...styles.hint, marginTop: '1rem' }}>
          Admin actions sign using the platform server key after creator approval. Every transition is written to audit
          history.
        </p>
      )}
    </section>
  );
}

const styles = {
  section: { marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid #e5e5e5' },
  h2: { fontSize: '1.15rem', fontWeight: 800, marginBottom: '0.5rem' },
  h3: { fontSize: '1rem', fontWeight: 700, marginBottom: '0.5rem' },
  intro: { color: '#555', fontSize: '0.9rem', lineHeight: 1.55, marginBottom: '1rem' },
  hint: { color: '#666', fontSize: '0.82rem', lineHeight: 1.45, marginBottom: '0.65rem' },
  card: {
    background: '#fff',
    border: '1px solid #e5e5e5',
    borderRadius: '10px',
    padding: '1.1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  list: { listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.75rem', margin: 0, padding: 0 },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.65rem',
    background: '#fff',
    border: '1px solid #eee',
    borderRadius: '10px',
    padding: '0.85rem 1rem',
  },
  rowTitle: { fontSize: '0.9rem', fontWeight: 600, color: '#111' },
  meta: { fontSize: '0.8rem', color: '#666' },
  code: { fontSize: '0.78rem' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '0.45rem', alignItems: 'center' },
  audit: {
    marginTop: '0.5rem',
    paddingLeft: '1.1rem',
    fontSize: '0.78rem',
    color: '#444',
    lineHeight: 1.5,
  },
};
