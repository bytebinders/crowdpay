const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, stellarImpl }) {
  const stellarStub = {
    ensureCustodialAccountFundedAndTrusted: async () => {},
    ...stellarImpl,
  };

  const router = proxyquire('./users', {
    '@stellar/stellar-sdk': {
      Keypair: {
        random: () => ({
          publicKey: () => 'GUSER',
          secret: () => 'SUSERSECRET',
        }),
      },
    },
    '../config/database': { query: queryImpl },
    '../services/stellarService': stellarStub,
    jsonwebtoken: {
      sign: () => 'jwt-token',
    },
    bcryptjs: {
      hash: async () => 'hashed',
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/users', router);
  return app;
}

test('POST /api/users/register schedules Stellar funding and trustlines', async () => {
  let ensureCalled = false;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT id FROM users WHERE email')) {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO users')) {
        return {
          rows: [
            {
              id: 'user-new',
              email: 'a@b.c',
              name: 'N',
              wallet_public_key: 'GUSER',
            },
          ],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      ensureCustodialAccountFundedAndTrusted: async ({ publicKey, secret }) => {
        assert.equal(publicKey, 'GUSER');
        assert.ok(typeof secret === 'string' && secret.length > 0);
        ensureCalled = true;
      },
    },
  });

  const res = await request(app)
    .post('/api/users/register')
    .send({ email: 'a@b.c', password: 'longpassword1', name: 'N' });

  assert.equal(res.status, 201);
  assert.equal(res.body.token, 'jwt-token');

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ensureCalled, true);
});
