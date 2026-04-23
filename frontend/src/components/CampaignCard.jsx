import React from 'react';
import { Link } from 'react-router-dom';

export default function CampaignCard({ campaign }) {
  const pct = Math.min(100, (campaign.raised_amount / campaign.target_amount) * 100).toFixed(1);

  return (
    <Link to={`/campaigns/${campaign.id}`} style={{ display: 'block' }} className="campaign-card-link">
      <div className="campaign-card" style={styles.card}>
        <div style={styles.header}>
          <span style={styles.asset}>{campaign.asset_type}</span>
        </div>
        <h3 style={styles.title}>{campaign.title}</h3>
        <p style={styles.desc}>{campaign.description?.slice(0, 100)}{campaign.description?.length > 100 ? '…' : ''}</p>
        <div style={styles.bar}>
          <div style={{ ...styles.fill, width: `${pct}%` }} />
        </div>
        <div style={styles.meta}>
          <span><strong>{Number(campaign.raised_amount).toLocaleString()}</strong> {campaign.asset_type} raised</span>
          <span>{pct}%</span>
        </div>
        <div style={styles.target}>
          Goal: {Number(campaign.target_amount).toLocaleString()} {campaign.asset_type}
        </div>
      </div>
    </Link>
  );
}

const styles = {
  card: { background: '#fff', border: '1px solid #e5e5e5', borderRadius: '10px', padding: '1.25rem', transition: 'box-shadow 0.15s' },
  header: { marginBottom: '0.6rem' },
  asset: { background: '#ede9fe', color: '#7c3aed', fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: '99px' },
  title: { fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.4rem', color: '#111' },
  desc: { fontSize: '0.875rem', color: '#666', marginBottom: '1rem' },
  bar: { background: '#f0f0f0', borderRadius: '99px', height: '6px', marginBottom: '0.5rem', overflow: 'hidden' },
  fill: { background: '#7c3aed', height: '100%', borderRadius: '99px', transition: 'width 0.3s' },
  meta: { display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: '#444' },
  target: { fontSize: '0.8rem', color: '#999', marginTop: '0.3rem' },
};
