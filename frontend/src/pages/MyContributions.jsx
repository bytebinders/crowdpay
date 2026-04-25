import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import { stellarExpertTxUrl } from '../config/stellar';

export default function MyContributions() {
  const { token } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    api.getMyContributions(token)
      .then(setRows)
      .catch((err) => setError(err.message || 'Could not load contributions'))
      .finally(() => setLoading(false));
  }, [token]);

  if (!token) return <Navigate to="/login" replace />;

  return (
    <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '1rem' }}>My Contributions</h1>
      {error && <p className="alert alert--error">{error}</p>}
      {loading ? (
        <p style={{ color: '#666' }}>Loading...</p>
      ) : rows.length === 0 ? (
        <p className="alert alert--info">You haven't backed any campaigns yet — browse campaigns.</p>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {rows.map((row) => (
            <div key={row.id} className="campaign-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <Link to={`/campaigns/${row.campaign_id}`} style={{ color: '#7c3aed', fontWeight: 700 }}>{row.campaign_title}</Link>
                <span>{row.campaign_status}</span>
              </div>
              <div style={{ marginTop: '0.35rem' }}>
                {Number(row.amount).toLocaleString()} {row.asset} • {new Date(row.created_at).toLocaleString()}
              </div>
              <a href={stellarExpertTxUrl(row.tx_hash)} target="_blank" rel="noopener noreferrer" style={{ marginTop: '0.35rem', display: 'inline-block', color: '#7c3aed' }}>
                View transaction
              </a>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
