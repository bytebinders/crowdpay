import React, { useEffect, useState } from 'react';
import { Link, useParams, useLocation } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import ContributeModal from '../components/ContributeModal';
import WithdrawalsSection from '../components/WithdrawalsSection';

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function markdownToHtml(markdown) {
  const escaped = escapeHtml(markdown || '');
  return escaped
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n/g, '<br />');
}

export default function Campaign() {
  const { id } = useParams();
  const location = useLocation();
  const { user, token } = useAuth();
  const [campaign, setCampaign] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [contributions, setContributions] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [contributed, setContributed] = useState(false);
  const [showCreatedBanner, setShowCreatedBanner] = useState(!!location.state?.created);
  const [updates, setUpdates] = useState([]);
  const [updateForm, setUpdateForm] = useState({ title: '', body: '' });
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updatesError, setUpdatesError] = useState('');

  useEffect(() => {
    setLoadError('');
    api
      .getCampaign(id)
      .then(setCampaign)
      .catch((err) => setLoadError(err.message || 'Could not load campaign.'));
    api.getContributions(id).then(setContributions).catch(() => setContributions([]));
    api.getCampaignUpdates(id, { limit: 20 }).then(setUpdates).catch(() => setUpdates([]));
  }, [id, contributed]);

  useEffect(() => {
    if (location.state?.created) {
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  if (loadError && !campaign) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '2.5rem' }}>
        <p className="alert alert--error" role="alert">
          {loadError}
        </p>
        <Link to="/" style={{ color: '#7c3aed', fontWeight: 600 }}>
          ← Back home
        </Link>
      </main>
    );
  }

  if (!campaign) {
    return (
      <main className="container" style={{ paddingTop: '3rem' }}>
        <p style={{ color: '#666' }}>Loading campaign…</p>
      </main>
    );
  }

  const pct = Math.min(100, (campaign.raised_amount / campaign.target_amount) * 100).toFixed(1);
  const canPostUpdate = user?.id && campaign.creator_id === user.id;

  async function submitUpdate(e) {
    e.preventDefault();
    setUpdatesError('');
    setUpdateBusy(true);
    try {
      await api.postCampaignUpdate(
        campaign.id,
        { title: updateForm.title.trim(), body: updateForm.body.trim() },
        token
      );
      setUpdateForm({ title: '', body: '' });
      const list = await api.getCampaignUpdates(id, { limit: 20 });
      setUpdates(list);
    } catch (err) {
      setUpdatesError(err.message || 'Could not publish update');
    } finally {
      setUpdateBusy(false);
    }
  }

  return (
    <main className="container" style={{ paddingTop: '2.5rem', paddingBottom: '4rem', maxWidth: '760px' }}>
      {showCreatedBanner && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Campaign is live.</strong> Share the link — contributors can fund in XLM or USDC when conversion paths
          are available.
          <button
            type="button"
            onClick={() => setShowCreatedBanner(false)}
            style={{
              marginLeft: '0.5rem',
              background: 'transparent',
              color: '#065f46',
              textDecoration: 'underline',
              fontWeight: 600,
              padding: 0,
              minHeight: 'auto',
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {campaign.status === 'failed' && (
        <div className="alert alert--error" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>This campaign did not reach its goal.</strong> Contributions are closed and refunds can be requested.
        </div>
      )}
      <div style={styles.header}>
        <span style={styles.asset}>{campaign.asset_type}</span>
        <h1 style={styles.title}>{campaign.title}</h1>
        <p style={styles.desc}>{campaign.description}</p>
      </div>

      <div style={styles.card}>
        <div style={styles.amounts}>
          <div>
            <div style={styles.big}>{Number(campaign.raised_amount).toLocaleString()} {campaign.asset_type}</div>
            <div style={styles.small}>raised of {Number(campaign.target_amount).toLocaleString()} goal</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={styles.big}>{pct}%</div>
            <div style={styles.small}>funded</div>
          </div>
        </div>
        <div style={styles.bar}><div style={{ ...styles.fill, width: `${pct}%` }} /></div>

        {campaign.status === 'active' ? (
          user ? (
            <button type="button" className="btn-primary" style={styles.cta} onClick={() => setShowModal(true)}>
              Contribute
            </button>
          ) : (
            <p style={{ color: '#555', fontSize: '0.9rem', lineHeight: 1.5 }}>
              <Link to="/login" state={{ from: `/campaigns/${id}` }} style={{ color: '#7c3aed', fontWeight: 600 }}>
                Log in
              </Link>{' '}
              or{' '}
              <Link to="/register" style={{ color: '#7c3aed', fontWeight: 600 }}>
                create an account
              </Link>{' '}
              to contribute. You will get a custodial Stellar wallet automatically.
            </p>
          )
        ) : (
          <p style={{ color: '#555', fontSize: '0.9rem', lineHeight: 1.5 }}>
            Contributions are closed while this campaign is <strong>{campaign.status}</strong>.
          </p>
        )}
      </div>

      <div style={styles.walletInfo}>
        <span style={styles.walletLabel}>Campaign wallet</span>
        <code style={styles.walletKey}>{campaign.wallet_public_key}</code>
      </div>

      {token && (
        <WithdrawalsSection
          campaign={campaign}
          user={user}
          token={token}
          onReleased={() => {
            api.getCampaign(id).then(setCampaign).catch(() => {});
          }}
        />
      )}

      <h2 style={styles.sectionTitle}>Updates ({updates.length})</h2>
      {canPostUpdate && (
        <form onSubmit={submitUpdate} className="campaign-card" style={{ marginBottom: '1rem' }}>
          <strong style={{ marginBottom: '0.5rem', display: 'block' }}>Post update</strong>
          <input
            placeholder="Update title"
            value={updateForm.title}
            onChange={(e) => setUpdateForm((s) => ({ ...s, title: e.target.value }))}
            required
            style={{ marginBottom: '0.5rem' }}
          />
          <textarea
            placeholder="Write markdown update..."
            value={updateForm.body}
            onChange={(e) => setUpdateForm((s) => ({ ...s, body: e.target.value }))}
            rows={4}
            required
          />
          {updatesError && <p className="alert alert--error" style={{ marginTop: '0.5rem' }}>{updatesError}</p>}
          <button type="submit" className="btn-primary" disabled={updateBusy} style={{ marginTop: '0.5rem' }}>
            {updateBusy ? 'Posting...' : 'Post update'}
          </button>
        </form>
      )}
      {updates.length === 0 ? (
        <p style={{ color: '#999', marginBottom: '1rem' }}>No updates posted yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1.25rem' }}>
          {updates.map((update) => (
            <article key={update.id} className="campaign-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <strong>{update.title}</strong>
                <span style={{ color: '#666', fontSize: '0.85rem' }}>
                  {update.author_name} • {new Date(update.created_at).toLocaleString()}
                </span>
              </div>
              <div
                style={{ marginTop: '0.5rem', color: '#333', lineHeight: 1.5 }}
                dangerouslySetInnerHTML={{ __html: markdownToHtml(update.body) }}
              />
            </article>
          ))}
        </div>
      )}

      <h2 style={styles.sectionTitle}>Contributions ({contributions.length})</h2>
      {contributions.length === 0 ? (
        <p style={{ color: '#999' }}>No contributions yet.</p>
      ) : (
        <div style={styles.list}>
          {contributions.map((c) => (
            <div key={c.id} style={styles.row}>
              <div style={{ minWidth: 0 }}>
                <div style={styles.sender}>
                  {c.sender_public_key.slice(0, 8)}…{c.sender_public_key.slice(-4)}
                </div>
                {c.payment_type === 'path_payment_strict_receive' && c.source_asset && c.source_amount != null && (
                  <div style={styles.convHint}>
                    via {Number(c.source_amount).toLocaleString()} {c.source_asset}
                  </div>
                )}
                {c.refund_status && (
                  <div style={styles.refundTag}>
                    {c.refund_status === 'pending' && 'Refund pending'}
                    {c.refund_status === 'submitted' && 'Refunded'}
                    {c.refund_status === 'indexed' && 'Refunded'}
                    {c.refund_status === 'failed' && 'Refund failed'}
                    {c.refund_status === 'denied' && 'Refund denied'}
                  </div>
                )}
              </div>
              <span style={styles.amount}>
                +{Number(c.amount).toLocaleString()} {c.asset}
              </span>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <ContributeModal
          campaign={campaign}
          onClose={() => setShowModal(false)}
          onSuccess={() => setContributed((v) => !v)}
        />
      )}
    </main>
  );
}

const styles = {
  header: { marginBottom: '1.5rem' },
  asset: { background: '#ede9fe', color: '#7c3aed', fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: '99px' },
  title: { fontSize: '1.8rem', fontWeight: 800, margin: '0.5rem 0', color: '#111' },
  desc: { color: '#555', fontSize: '1rem', lineHeight: 1.6 },
  card: { background: '#fff', border: '1px solid #e5e5e5', borderRadius: '10px', padding: '1.5rem', marginBottom: '1rem' },
  amounts: { display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' },
  big: { fontSize: '1.5rem', fontWeight: 800, color: '#111' },
  small: { fontSize: '0.85rem', color: '#888' },
  bar: { background: '#f0f0f0', borderRadius: '99px', height: '8px', marginBottom: '1.25rem', overflow: 'hidden' },
  fill: { background: '#7c3aed', height: '100%', borderRadius: '99px' },
  cta: { width: '100%', padding: '0.85rem', fontSize: '1rem' },
  walletInfo: { background: '#f8f8f8', borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1.75rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' },
  walletLabel: { fontSize: '0.75rem', fontWeight: 600, color: '#888', textTransform: 'uppercase' },
  walletKey: { fontSize: '0.8rem', color: '#555', wordBreak: 'break-all' },
  sectionTitle: { fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.75rem' },
  list: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  row: { display: 'flex', justifyContent: 'space-between', background: '#fff', border: '1px solid #eee', borderRadius: '6px', padding: '0.6rem 0.85rem' },
  sender: { fontSize: '0.85rem', color: '#555', fontFamily: 'monospace' },
  amount: { fontSize: '0.85rem', fontWeight: 600, flexShrink: 0 },
  convHint: { fontSize: '0.72rem', color: '#888', marginTop: '0.15rem' },
  refundTag: { marginTop: '0.45rem', fontSize: '0.75rem', color: '#7c3aed', fontWeight: 700 },
};
