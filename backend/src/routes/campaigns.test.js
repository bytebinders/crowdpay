const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, buildWithdrawalTransactionImpl, insertWithdrawalPendingSignaturesImpl }) {
  const router = proxyquire('./campaigns', {
    '../config/database': {
      query: queryImpl,
      connect: async () => ({ query: queryImpl, release: async () => {} }),
    },
    '../services/stellarService': {
      createCampaignWallet: async () => ({ publicKey: 'GPK', secret: 'S' }),
      getCampaignBalance: async () => ({}),
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
      buildWithdrawalTransaction: buildWithdrawalTransactionImpl,
    },
    '../services/ledgerMonitor': {
      watchCampaignWallet: async () => {},
    },
    '../services/stellarTransactionService': {
      insertWithdrawalPendingSignatures: insertWithdrawalPendingSignaturesImpl,
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'platform-1' };
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return app;
}

test('POST /api/campaigns/cron/fail-expired returns failed campaigns', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('UPDATE campaigns SET status =')) {
        return {
          rows: [{ id: 'c-1', title: 'Campaign 1', target_amount: '100', raised_amount: '50', deadline: '2026-04-23' }],
        };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns/cron/fail-expired')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.failedCampaigns.length, 1);
  assert.equal(response.body.failedCampaigns[0].id, 'c-1');
});

test('POST /api/campaigns/:id/trigger-refunds creates refund requests for contributions', async () => {
  const created = [];
  const queryImpl = async (text, params) => {
    if (text.includes('SELECT id, wallet_public_key, status FROM campaigns')) {
      return { rows: [{ id: 'c-1', wallet_public_key: 'GPK', status: 'failed' }] };
    }
    if (text.includes('FROM contributions c')) {
      return {
        rows: [
          {
            id: 'contrib-1',
            campaign_id: 'c-1',
            sender_public_key: 'GSENDER',
            amount: '15.0000000',
            asset: 'USDC',
            payment_type: 'payment',
            source_amount: null,
            source_asset: null,
            conversion_rate: null,
            path: null,
            tx_hash: 'tx-1',
            created_at: '2026-04-23T12:00:00Z',
          },
        ],
      };
    }
    if (text.includes('INSERT INTO withdrawal_requests')) {
      return { rows: [{ id: 'wr-1' }] };
    }
    return { rows: [] };
  };

  const app = buildApp({
    queryImpl,
    buildWithdrawalTransactionImpl: async () => 'unsigned-xdr',
    insertWithdrawalPendingSignaturesImpl: async ({ withdrawalRequestId }) => {
      created.push(withdrawalRequestId);
      return 'stellar-row-id';
    },
  });

  const response = await request(app)
    .post('/api/campaigns/c-1/trigger-refunds')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 201);
  assert.equal(response.body.refundsCreated, 1);
  assert.equal(created.length, 1);
  assert.equal(created[0], 'wr-1');
});
