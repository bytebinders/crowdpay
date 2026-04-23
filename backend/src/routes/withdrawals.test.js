const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, stellarImpl, userId = 'creator-1' }) {
  const stellarStub = {
    buildWithdrawalTransaction: async () => 'xdr-base',
    getAccountMultisigConfig: async () => ({
      thresholds: { med_threshold: 2 },
      signers: [{ key: 'GCREATOR', weight: 1 }, { key: 'GPLATFORM', weight: 1 }],
    }),
    signTransactionXdr: () => 'xdr-signed',
    signatureCountFromXdr: () => 2,
    submitSignedWithdrawal: async () => 'tx-hash',
    PLATFORM_PUBLIC_KEY: 'GPLATFORM',
    ...stellarImpl,
  };

  const router = proxyquire('./withdrawals', {
    '../config/database': {
      connect: async () => ({
        query: queryImpl,
        release: () => {},
      }),
      query: queryImpl,
    },
    '../services/stellarService': stellarStub,
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId };
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/withdrawals', router);

  return { app, cleanup: () => {} };
}

function campaignRow(overrides = {}) {
  return {
    id: 'camp-1',
    creator_id: 'creator-1',
    wallet_public_key: 'GCAMPAIGN',
    asset_type: 'USDC',
    status: 'active',
    ...overrides,
  };
}

test('GET /api/withdrawals/capabilities reflects approver env', async () => {
  const prev = process.env.PLATFORM_APPROVER_USER_ID;
  process.env.PLATFORM_APPROVER_USER_ID = 'platform-1';
  try {
    const { app, cleanup } = buildApp({
      queryImpl: async () => ({ rows: [] }),
      userId: 'platform-1',
    });
    const res = await request(app).get('/api/withdrawals/capabilities').set('Authorization', 'Bearer t');
    cleanup();
    assert.equal(res.status, 200);
    assert.equal(res.body.can_approve_platform, true);
  } finally {
    if (prev === undefined) delete process.env.PLATFORM_APPROVER_USER_ID;
    else process.env.PLATFORM_APPROVER_USER_ID = prev;
  }
});

test('POST /api/withdrawals/request creates pending request and logs event', async () => {
  const calls = [];
  const { app, cleanup } = buildApp({
    queryImpl: async (text, params) => {
      calls.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('FROM campaigns WHERE id')) {
        return { rows: [campaignRow()] };
      }
      if (text.includes("FROM withdrawal_requests") && text.includes("status = 'pending'")) {
        return { rows: [] };
      }
      if (text.includes('wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR' }] };
      }
      if (text.includes('INSERT INTO withdrawal_requests')) {
        return { rows: [{ id: 'w-1', status: 'pending', creator_signed: false, platform_signed: false }] };
      }
      if (text.includes('INSERT INTO withdrawal_approval_events')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/request')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: 'camp-1', destination_key: 'GDEST', amount: '10.0000000' });

  cleanup();
  assert.equal(response.status, 201);
  assert.equal(response.body.status, 'pending');
  assert.ok(calls.some((c) => c.includes('INSERT INTO withdrawal_approval_events')));
});

test('POST /api/withdrawals/request blocks when campaign not active or funded', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns WHERE id')) {
        return { rows: [campaignRow({ status: 'closed' })] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/request')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: 'camp-1', destination_key: 'GDEST', amount: '10.0000000' });

  cleanup();
  assert.equal(response.status, 409);
});

test('POST /api/withdrawals/request blocks duplicate pending', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns WHERE id')) {
        return { rows: [campaignRow()] };
      }
      if (text.includes("status = 'pending'")) {
        return { rows: [{ id: 'existing' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/request')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: 'camp-1', destination_key: 'GDEST', amount: '10.0000000' });

  cleanup();
  assert.equal(response.status, 409);
});

test('POST /api/withdrawals/request denies invalid multisig config', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns WHERE id')) {
        return { rows: [campaignRow()] };
      }
      if (text.includes("status = 'pending'")) return { rows: [] };
      if (text.includes('wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR' }] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      getAccountMultisigConfig: async () => ({
        thresholds: { med_threshold: 1 },
        signers: [{ key: 'GCREATOR', weight: 1 }],
      }),
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/request')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: 'camp-1', destination_key: 'GDEST', amount: '10.0000000' });

  cleanup();
  assert.equal(response.status, 422);
});

test('POST /api/withdrawals/:id/approve/platform denies before creator approval', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async () => ({
      rows: [{
        id: 'w-1',
        status: 'pending',
        creator_signed: false,
        platform_signed: false,
        unsigned_xdr: 'xdr-base',
        campaign_status: 'active',
      }],
    }),
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/approve/platform')
    .set('Authorization', 'Bearer token')
    .send({});

  cleanup();
  assert.equal(response.status, 409);
  assert.match(response.body.error, /Creator approval/);
});

test('POST /api/withdrawals/:id/approve/creator signs withdrawal request', async () => {
  const calls = [];
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      calls.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('FROM withdrawal_requests wr')) {
        return {
          rows: [{
            id: 'w-1',
            status: 'pending',
            creator_signed: false,
            platform_signed: false,
            unsigned_xdr: 'xdr-base',
            creator_id: 'creator-1',
            campaign_status: 'active',
          }],
        };
      }
      if (text.includes('wallet_secret_encrypted FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SCREATOR' }] };
      }
      if (text.includes('UPDATE withdrawal_requests') && text.includes('creator_signed = TRUE')) {
        return { rows: [{ id: 'w-1', creator_signed: true, unsigned_xdr: 'xdr-signed' }] };
      }
      if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/approve/creator')
    .set('Authorization', 'Bearer token')
    .send({});

  cleanup();
  assert.equal(response.status, 200);
  assert.equal(response.body.creator_signed, true);
  assert.ok(calls.some((c) => c.includes('creator_signed')));
});

test('POST /api/withdrawals/:id/approve/platform denies insufficient signatures', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async () => ({
      rows: [{
        id: 'w-1',
        status: 'pending',
        creator_signed: true,
        platform_signed: false,
        unsigned_xdr: 'xdr-base',
        campaign_status: 'active',
      }],
    }),
    stellarImpl: {
      signatureCountFromXdr: () => 1,
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/approve/platform')
    .set('Authorization', 'Bearer token')
    .send({});

  cleanup();
  assert.equal(response.status, 422);
});

test('POST /api/withdrawals/:id/approve/platform submits with dual signatures', async () => {
  const calls = [];
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      calls.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT wr.*, c.status')) {
        return {
          rows: [{
            id: 'w-1',
            status: 'pending',
            creator_signed: true,
            platform_signed: false,
            unsigned_xdr: 'xdr-creator-signed',
            campaign_status: 'active',
          }],
        };
      }
      if (text.includes('UPDATE withdrawal_requests') && text.includes("status = 'submitted'")) {
        return { rows: [{ id: 'w-1', status: 'submitted', tx_hash: 'tx-hash' }] };
      }
      if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/approve/platform')
    .set('Authorization', 'Bearer token')
    .send({});

  cleanup();
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'submitted');
  assert.ok(calls.some((c) => c.includes("status = 'submitted'")));
});

test('POST /api/withdrawals/:id/cancel denies after creator signed', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async () => ({
      rows: [{
        id: 'w-1',
        status: 'pending',
        creator_signed: true,
        creator_id: 'creator-1',
      }],
    }),
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/cancel')
    .set('Authorization', 'Bearer token')
    .send({ reason: 'Never mind' });

  cleanup();
  assert.equal(response.status, 409);
});

test('POST /api/withdrawals/:id/cancel succeeds before creator signs', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('FROM withdrawal_requests wr')) {
        return {
          rows: [{
            id: 'w-1',
            status: 'pending',
            creator_signed: false,
            creator_id: 'creator-1',
          }],
        };
      }
      if (text.includes("SET status = 'denied'")) {
        return { rows: [{ id: 'w-1', status: 'denied', denial_reason: 'x' }] };
      }
      if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/cancel')
    .set('Authorization', 'Bearer token')
    .send({ reason: 'Wrong destination' });

  cleanup();
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'denied');
});

test('POST /api/withdrawals/:id/reject marks denied after creator signed', async () => {
  const { app, cleanup } = buildApp({
    userId: 'platform-user',
    queryImpl: async (text) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT * FROM withdrawal_requests WHERE id')) {
        return {
          rows: [{
            id: 'w-1',
            status: 'pending',
            creator_signed: true,
            platform_signed: false,
          }],
        };
      }
      if (text.includes("SET status = 'denied'")) {
        return { rows: [{ id: 'w-1', status: 'denied' }] };
      }
      if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
      return { rows: [] };
    },
  });

  const prev = process.env.PLATFORM_APPROVER_USER_ID;
  process.env.PLATFORM_APPROVER_USER_ID = 'platform-user';
  let response;
  try {
    response = await request(app)
      .post('/api/withdrawals/w-1/reject')
      .set('Authorization', 'Bearer t')
      .send({ reason: 'Compliance hold' });
  } finally {
    if (prev === undefined) delete process.env.PLATFORM_APPROVER_USER_ID;
    else process.env.PLATFORM_APPROVER_USER_ID = prev;
  }

  cleanup();
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'denied');
});

test('POST /api/withdrawals/:id/approve/platform logs failure when Stellar rejects', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT wr.*, c.status')) {
        return {
          rows: [{
            id: 'w-1',
            status: 'pending',
            creator_signed: true,
            platform_signed: false,
            unsigned_xdr: 'xdr',
            campaign_status: 'active',
          }],
        };
      }
      if (text.includes("SET status = 'failed'")) return { rows: [] };
      if (text.includes('INSERT INTO withdrawal_approval_events')) return { rows: [] };
      return { rows: [] };
    },
    stellarImpl: {
      submitSignedWithdrawal: async () => {
        throw new Error('op_underfunded');
      },
    },
  });

  const response = await request(app)
    .post('/api/withdrawals/w-1/approve/platform')
    .set('Authorization', 'Bearer token')
    .send({});

  cleanup();
  assert.equal(response.status, 502);
});
