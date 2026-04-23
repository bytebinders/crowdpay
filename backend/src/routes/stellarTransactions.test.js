const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, userId = 'creator-1' }) {
  const router = proxyquire('./stellarTransactions', {
    '../config/database': { query: queryImpl },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId };
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/stellar/transactions', router);
  return app;
}

test('GET /api/stellar/transactions requires campaign_id for non-platform users', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    userId: 'creator-1',
  });

  const res = await request(app)
    .get('/api/stellar/transactions')
    .set('Authorization', 'Bearer t');

  assert.equal(res.status, 400);
});

test('GET /api/stellar/transactions lists rows for campaign creator', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('FROM stellar_transactions st')) {
        return {
          rows: [
            {
              id: 'st-1',
              kind: 'contribution',
              status: 'submitted',
              tx_hash: 'h1',
              campaign_id: 'camp-1',
              withdrawal_request_id: null,
              initiated_by_user_id: 'user-2',
              metadata: {},
              contribution_id: null,
              failure_reason: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              campaign_title: 'Test',
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .get('/api/stellar/transactions?campaign_id=camp-1')
    .set('Authorization', 'Bearer t');

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].tx_hash, 'h1');
});

test('GET /api/stellar/transactions rejects invalid status filter', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .get('/api/stellar/transactions?campaign_id=camp-1&status=bad')
    .set('Authorization', 'Bearer t');

  assert.equal(res.status, 400);
});

test('GET /api/stellar/transactions/:id denies unrelated users', async () => {
  const app = buildApp({
    queryImpl: async () => ({
      rows: [
        {
          id: 'st-1',
          creator_id: 'someone-else',
        },
      ],
    }),
    userId: 'creator-1',
  });

  const res = await request(app)
    .get('/api/stellar/transactions/st-1')
    .set('Authorization', 'Bearer t');

  assert.equal(res.status, 403);
});
