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
    '../config/database': { query: queryImpl },
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

  return {
    app,
    cleanup: () => {},
  };
}

test('POST /api/withdrawals/request creates pending request for creator', async () => {
  const dbCalls = [];
  const { app, cleanup } = buildApp({
    queryImpl: async (text, params) => {
      dbCalls.push({ text, params });
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: 'camp-1',
            creator_id: 'creator-1',
            wallet_public_key: 'GCAMPAIGN',
            asset_type: 'USDC',
          }],
        };
      }
      if (text.includes('SELECT wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR' }] };
      }
      if (text.includes('INSERT INTO withdrawal_requests')) {
        return { rows: [{ id: 'w-1', status: 'pending', creator_signed: false, platform_signed: false }] };
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
  assert.ok(dbCalls.some((c) => c.text.includes('INSERT INTO withdrawal_requests')));
});

test('POST /api/withdrawals/request denies invalid multisig config', async () => {
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: 'camp-1',
            creator_id: 'creator-1',
            wallet_public_key: 'GCAMPAIGN',
            asset_type: 'USDC',
          }],
        };
      }
      if (text.includes('SELECT wallet_public_key FROM users')) {
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
  const { app, cleanup } = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM withdrawal_requests wr')) {
        return {
          rows: [{
            id: 'w-1',
            status: 'pending',
            creator_signed: false,
            platform_signed: false,
            unsigned_xdr: 'xdr-base',
            creator_id: 'creator-1',
            campaign_wallet_key: 'GCAMPAIGN',
          }],
        };
      }
      if (text.includes('SELECT wallet_secret_encrypted FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SCREATOR' }] };
      }
      if (text.includes('UPDATE withdrawal_requests')) {
        return { rows: [{ id: 'w-1', creator_signed: true, unsigned_xdr: 'xdr-signed' }] };
      }
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
      if (text.includes('SELECT * FROM withdrawal_requests')) {
        return {
          rows: [{
            id: 'w-1',
            status: 'pending',
            creator_signed: true,
            platform_signed: false,
            unsigned_xdr: 'xdr-creator-signed',
          }],
        };
      }
      if (text.includes('UPDATE withdrawal_requests')) {
        return { rows: [{ id: 'w-1', status: 'submitted', tx_hash: 'tx-hash' }] };
      }
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
