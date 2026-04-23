import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import CampaignCard from '../components/CampaignCard';
import { useAuth } from '../context/AuthContext';
import OnboardingCallout from '../components/OnboardingCallout';
import {
  isContributorOnboardingVisible,
  dismissContributorOnboarding,
  consumeJustRegistered,
} from '../lib/onboarding';

export default function Home() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const { user } = useAuth();
  const [showContributorTips, setShowContributorTips] = useState(isContributorOnboardingVisible);
  const [welcomeNewUser, setWelcomeNewUser] = useState(false);

  useEffect(() => {
    if (consumeJustRegistered()) {
      setWelcomeNewUser(true);
    }
  }, []);

  useEffect(() => {
    setListError('');
    api
      .getCampaigns()
      .then(setCampaigns)
      .catch((err) => setListError(err.message || 'Could not load campaigns.'))
      .finally(() => setLoading(false));
  }, []);

  function dismissContributorTips() {
    dismissContributorOnboarding();
    setShowContributorTips(false);
  }

  return (
    <main className="container" style={{ paddingTop: '1.5rem', paddingBottom: '4rem' }}>
      {welcomeNewUser && (
        <div className="alert alert--success" style={{ marginBottom: '1rem' }} role="status">
          <strong>Welcome to CrowdPay.</strong> Your account includes a custodial Stellar wallet. Explore active
          campaigns and fund one in seconds.
          <button
            type="button"
            onClick={() => setWelcomeNewUser(false)}
            style={{
              marginLeft: '0.5rem',
              background: 'transparent',
              color: '#065f46',
              fontWeight: 600,
              textDecoration: 'underline',
              padding: 0,
              minHeight: 'auto',
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {user && showContributorTips && (
        <OnboardingCallout title="How contributing works" onDismiss={dismissContributorTips}>
          <ul>
            <li>Each campaign settles in either USDC or XLM — that is what moves the progress bar.</li>
            <li>You can pay with XLM or USDC; if they differ, Stellar converts automatically when a path exists.</li>
            <li>Watch for live quotes in the contribute window before you confirm.</li>
          </ul>
        </OnboardingCallout>
      )}

      <div style={styles.hero}>
        <h1 style={styles.h1}>Fund anything, from anywhere.</h1>
        <p style={styles.sub}>
          CrowdPay runs on Stellar: fast settlement, optional cross-asset conversion, and a clear path from pledge to
          on-chain receipt.
        </p>
        {user ? (
          <div className="hero-actions">
            <Link to="/campaigns/new" style={{ width: '100%' }}>
              <button type="button" className="btn-primary" style={{ fontSize: '1rem', padding: '0.75rem 1.5rem', width: '100%' }}>
                Start a campaign
              </button>
            </Link>
            <span style={styles.muted}>or browse below and tap a card to contribute.</span>
          </div>
        ) : (
          <div className="hero-actions hero-actions--row-sm">
            <Link to="/register" style={{ flex: '1 1 140px', minWidth: '140px' }}>
              <button type="button" className="btn-primary" style={{ fontSize: '1rem', padding: '0.75rem 1.5rem', width: '100%' }}>
                Create account
              </button>
            </Link>
            <Link to="/login" style={{ flex: '1 1 140px', minWidth: '140px' }}>
              <button type="button" className="btn-secondary" style={{ fontSize: '1rem', padding: '0.75rem 1.5rem', width: '100%' }}>
                Log in
              </button>
            </Link>
          </div>
        )}
      </div>

      <h2 style={styles.sectionTitle}>Active campaigns</h2>

      {loading ? (
        <p style={{ color: '#666' }}>Loading campaigns…</p>
      ) : listError ? (
        <p className="alert alert--error" role="alert">
          {listError}
        </p>
      ) : campaigns.length === 0 ? (
        <div className="alert alert--info">
          {user ? (
            <>
              No campaigns yet.{' '}
              <Link to="/campaigns/new" style={{ color: '#1e40af', fontWeight: 700 }}>
                Launch the first one
              </Link>
              .
            </>
          ) : (
            <>No public campaigns yet. Sign up to get notified when you create or back the first project.</>
          )}
        </div>
      ) : (
        <div style={styles.grid}>
          {campaigns.map((c) => (
            <CampaignCard key={c.id} campaign={c} />
          ))}
        </div>
      )}
    </main>
  );
}

const styles = {
  hero: { textAlign: 'center', padding: '2rem 0 2.5rem' },
  h1: { fontSize: 'clamp(1.85rem, 5vw, 2.85rem)', fontWeight: 800, marginBottom: '1rem', color: '#111' },
  sub: {
    fontSize: 'clamp(0.95rem, 2.5vw, 1.1rem)',
    color: '#555',
    marginBottom: '1.5rem',
    maxWidth: '560px',
    margin: '0 auto 1.5rem',
    lineHeight: 1.55,
  },
  muted: { fontSize: '0.85rem', color: '#777', maxWidth: '320px', lineHeight: 1.4, textAlign: 'center' },
  sectionTitle: { fontSize: '1.2rem', fontWeight: 700, marginBottom: '1.1rem', color: '#111' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: '1.25rem' },
};
