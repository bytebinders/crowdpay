const BASE = '/api';

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request(method, path, body, token, options = {}) {
  const { query } = options;
  let url = `${BASE}${path}`;
  if (query && Object.keys(query).length) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    });
    url += `?${params.toString()}`;
  }

  const res = await fetch(url, {
    method,
    headers: authHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Unexpected server response. Please try again.');
    }
  }

  if (!res.ok) {
    const msg = data.error || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  return data;
}

export const api = {
  register: (body) => request('POST', '/users/register', body),
  login: (body) => request('POST', '/users/login', body),

  getCampaigns: () => request('GET', '/campaigns'),
  getCampaign: (id) => request('GET', `/campaigns/${id}`),
  getCampaignBalance: (id) => request('GET', `/campaigns/${id}/balance`),
  createCampaign: (body, token) => request('POST', '/campaigns', body, token),

  getContributions: (campaignId) => request('GET', `/contributions/campaign/${campaignId}`),
  contribute: (body, token) => request('POST', '/contributions', body, token),
  quoteContribution: ({ send_asset, dest_asset, dest_amount }, token) =>
    request('GET', '/contributions/quote', null, token, {
      query: { send_asset, dest_asset, dest_amount },
    }),

  getWithdrawalCapabilities: (token) => request('GET', '/withdrawals/capabilities', null, token),
  listWithdrawals: (campaignId, token) =>
    request('GET', `/withdrawals/campaign/${campaignId}`, null, token),
  requestWithdrawal: (body, token) => request('POST', '/withdrawals/request', body, token),
  approveWithdrawalCreator: (id, token) =>
    request('POST', `/withdrawals/${id}/approve/creator`, {}, token),
  approveWithdrawalPlatform: (id, token) =>
    request('POST', `/withdrawals/${id}/approve/platform`, {}, token),
  cancelWithdrawal: (id, body, token) => request('POST', `/withdrawals/${id}/cancel`, body || {}, token),
  rejectWithdrawal: (id, body, token) => request('POST', `/withdrawals/${id}/reject`, body || {}, token),
  getWithdrawalEvents: (id, token) => request('GET', `/withdrawals/${id}/events`, null, token),
};
