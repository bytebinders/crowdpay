import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import OnboardingCallout from '../components/OnboardingCallout';
import {
  isCreatorOnboardingVisible,
  dismissCreatorOnboarding,
} from '../lib/onboarding';

const ASSETS = [
  {
    value: 'USDC',
    label: 'USDC',
    hint: 'Stable dollar value on Stellar. Best when backers think in USD.',
  },
  {
    value: 'XLM',
    label: 'XLM',
    hint: 'Native Stellar asset. Simple for contributors who already hold XLM.',
  },
];

export default function CreateCampaign() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    title: '',
    description: '',
    target_amount: '',
    asset_type: 'USDC',
    deadline: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCreatorTips, setShowCreatorTips] = useState(isCreatorOnboardingVisible);

  useEffect(() => {
    if (!token) {
      navigate('/login', { replace: true, state: { from: '/campaigns/new' } });
    }
  }, [token, navigate]);

  function setField(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  function selectAsset(value) {
    setForm((f) => ({ ...f, asset_type: value }));
  }

  function dismissTips() {
    dismissCreatorOnboarding();
    setShowCreatorTips(false);
  }

  function validateStep1() {
    if (!form.title.trim()) {
      setError('Please enter a campaign title.');
      return false;
    }
    if (!form.target_amount || Number(form.target_amount) <= 0) {
      setError('Enter a fundraising goal greater than zero.');
      return false;
    }
    setError('');
    return true;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validateStep1()) return;
    setLoading(true);
    setError('');
    try {
      const campaign = await api.createCampaign(
        {
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          target_amount: form.target_amount,
          asset_type: form.asset_type,
          deadline: form.deadline || undefined,
        },
        token
      );
      navigate(`/campaigns/${campaign.id}`, { state: { created: true } });
    } catch (err) {
      if (err.status === 401) {
        setError('Your session expired. Please log in again.');
        navigate('/login', { state: { from: '/campaigns/new' } });
      } else {
        setError(err.message || 'Could not create campaign. Try again.');
      }
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Redirecting to sign in…</p>
      </main>
    );
  }

  return (
    <main className="container page-mid" style={{ paddingTop: '1.75rem', paddingBottom: '3rem' }}>
      <nav aria-label="Progress" style={{ marginBottom: '1.25rem' }}>
        <ol
          style={{
            listStyle: 'none',
            display: 'flex',
            gap: '0.5rem',
            flexWrap: 'wrap',
            fontSize: '0.8rem',
            fontWeight: 600,
            color: '#666',
          }}
        >
          <li>
            <span style={{ color: step === 1 ? '#7c3aed' : '#999' }}>1. Goal & asset</span>
          </li>
          <li aria-hidden="true">→</li>
          <li>
            <span style={{ color: step === 2 ? '#7c3aed' : '#999' }}>2. Details & launch</span>
          </li>
        </ol>
      </nav>

      <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 1.85rem)', fontWeight: 800, marginBottom: '0.35rem' }}>
        Start a campaign
      </h1>
      <p style={{ color: '#555', marginBottom: '1.25rem', fontSize: '0.95rem', lineHeight: 1.55 }}>
        We create a dedicated Stellar wallet for your campaign. You choose whether the goal is tracked in{' '}
        <strong>USDC</strong> or <strong>XLM</strong> — contributors can still pay from either asset when paths exist.
      </p>

      {showCreatorTips && (
        <OnboardingCallout title="First time creating a campaign?" onDismiss={dismissTips}>
          <ul>
            <li>Pick the asset that matches how you think about your goal (USD-like vs XLM).</li>
            <li>Withdrawals need both you and CrowdPay to sign — funds stay in escrow until then.</li>
            <li>You can edit the story in the description; the title should be clear for backers.</li>
          </ul>
        </OnboardingCallout>
      )}

      <form onSubmit={handleSubmit}>
        {step === 1 && (
          <>
            <div className="form-stack">
              <label className="label-strong" htmlFor="cc-title">
                Campaign title
              </label>
              <input
                id="cc-title"
                value={form.title}
                onChange={setField('title')}
                placeholder="e.g. Community garden rebuild"
                required
                autoComplete="off"
              />
            </div>

            <div className="form-stack" style={{ marginTop: '1rem' }}>
              <label className="label-strong" htmlFor="cc-target">
                Fundraising goal
              </label>
              <input
                id="cc-target"
                type="number"
                inputMode="decimal"
                min="0.0000001"
                step="any"
                value={form.target_amount}
                onChange={setField('target_amount')}
                placeholder="0.00"
                required
              />
            </div>

            <fieldset style={{ border: 'none', margin: '1.25rem 0 0', padding: 0 }}>
              <legend className="label-strong" style={{ marginBottom: '0.5rem' }}>
                Settlement asset
              </legend>
              <p style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.65rem' }}>
                Progress and payouts use this asset. Contributors may use a different asset if Stellar can convert it.
              </p>
              <div className="asset-picker" role="radiogroup" aria-label="Settlement asset">
                {ASSETS.map((a) => (
                  <label
                    key={a.value}
                    className={`asset-picker__option${form.asset_type === a.value ? ' asset-picker__option--selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="asset_type"
                      value={a.value}
                      checked={form.asset_type === a.value}
                      onChange={() => selectAsset(a.value)}
                    />
                    <div className="asset-picker__code">{a.label}</div>
                    <div className="asset-picker__hint">{a.hint}</div>
                  </label>
                ))}
              </div>
            </fieldset>

            {error && (
              <p className="alert alert--error" style={{ marginTop: '1rem' }} role="alert">
                {error}
              </p>
            )}

            <button
              type="button"
              className="btn-primary"
              style={{ width: '100%', marginTop: '1.25rem' }}
              onClick={() => {
                if (validateStep1()) setStep(2);
              }}
            >
              Continue to details
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <div className="form-stack">
              <label className="label-strong" htmlFor="cc-desc">
                Description <span style={{ fontWeight: 500, color: '#888' }}>(optional)</span>
              </label>
              <textarea
                id="cc-desc"
                value={form.description}
                onChange={setField('description')}
                rows={5}
                placeholder="Tell backers what the funds will be used for and any milestones."
                style={{ resize: 'vertical', minHeight: '120px' }}
              />
            </div>

            <div className="form-stack" style={{ marginTop: '1rem' }}>
              <label className="label-strong" htmlFor="cc-deadline">
                Deadline <span style={{ fontWeight: 500, color: '#888' }}>(optional)</span>
              </label>
              <input id="cc-deadline" type="date" value={form.deadline} onChange={setField('deadline')} />
            </div>

            <div
              className="alert alert--info"
              style={{ marginTop: '1.25rem' }}
              role="status"
            >
              <strong>Summary:</strong> Goal of {form.target_amount || '—'} {form.asset_type} — “{form.title || 'Untitled'}”.
              A multisig campaign wallet will be created when you launch.
            </div>

            {error && (
              <p className="alert alert--error" style={{ marginTop: '1rem' }} role="alert">
                {error}
              </p>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', marginTop: '1.25rem' }}>
              <button type="submit" className="btn-primary" disabled={loading} style={{ width: '100%' }}>
                {loading ? 'Creating wallet…' : 'Launch campaign'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%' }}
                disabled={loading}
                onClick={() => {
                  setError('');
                  setStep(1);
                }}
              >
                Back
              </button>
            </div>
          </>
        )}
      </form>

      <p style={{ marginTop: '1.5rem', fontSize: '0.85rem', color: '#777' }}>
        <Link to="/" style={{ color: '#7c3aed', fontWeight: 600 }}>
          ← Back to campaigns
        </Link>
      </p>
    </main>
  );
}
