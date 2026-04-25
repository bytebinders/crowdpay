import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';

function progressPct(campaign) {
  if (!Number(campaign.target_amount)) return 0;
  return Math.min(100, (Number(campaign.raised_amount) / Number(campaign.target_amount)) * 100);
}

export default function Dashboard() {
  const { token, user } = useAuth();
  const [stats, setStats] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    Promise.all([api.getMyStats(token), api.getMyCampaigns(token)])
      .then(([s, c]) => {
        setStats(s);
        setCampaigns(c);
      })
      .catch((err) => setError(err.message || 'Could not load dashboard'))
      .finally(() => setLoading(false));
  }, [token]);

  if (!token) return <Navigate to="/login" replace />;
  if (user?.role !== 'creator' && user?.role !== 'admin') return <Navigate to="/" replace />;

  return (
    <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '1rem' }}>Creator Dashboard</h1>
      {error && <p className="alert alert--error">{error}</p>}
      {loading ? (
        <p style={{ color: '#666' }}>Loading dashboard...</p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
            <div className="campaign-card"><strong>{stats?.total_campaigns || 0}</strong><div>Total campaigns</div></div>
            <div className="campaign-card"><strong>{Number(stats?.total_raised || 0).toLocaleString()}</strong><div>Total raised</div></div>
            <div className="campaign-card"><strong>{stats?.active_campaigns || 0}</strong><div>Active campaigns</div></div>
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <Link to="/campaigns/new" style={{ color: '#7c3aed', fontWeight: 600 }}>+ Create new campaign</Link>
          </div>
          {campaigns.length === 0 ? (
            <p className="alert alert--info">No campaigns yet. Create your first campaign to get started.</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {campaigns.map((campaign) => {
                const pct = progressPct(campaign).toFixed(1);
                return (
                  <div key={campaign.id} className="campaign-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <strong>{campaign.title}</strong>
                      <span>{campaign.status}</span>
                    </div>
                    <div style={{ marginTop: '0.35rem', fontSize: '0.9rem' }}>
                      {Number(campaign.raised_amount).toLocaleString()} / {Number(campaign.target_amount).toLocaleString()} {campaign.asset_type}
                    </div>
                    <div style={{ background: '#eee', borderRadius: '99px', height: '6px', marginTop: '0.35rem' }}>
                      <div style={{ background: '#7c3aed', height: '6px', borderRadius: '99px', width: `${pct}%` }} />
                    </div>
                    <div style={{ marginTop: '0.35rem', color: '#666', fontSize: '0.85rem' }}>
                      {campaign.contributor_count} contributors {campaign.deadline ? `• Deadline ${new Date(campaign.deadline).toLocaleDateString()}` : ''}
                    </div>
                    <div style={{ marginTop: '0.45rem', display: 'flex', gap: '0.75rem' }}>
                      <Link to={`/campaigns/${campaign.id}`} style={{ color: '#7c3aed' }}>View</Link>
                      <Link to={`/campaigns/${campaign.id}`} style={{ color: '#7c3aed' }}>Manage withdrawals</Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </main>
  );
}
