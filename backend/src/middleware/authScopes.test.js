const test = require('node:test');
const assert = require('node:assert/strict');
const { assertApiKeyScopes } = require('./auth');

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
    },
  };
}

test('JWT auth bypasses scope checks', () => {
  const req = { originalUrl: '/api/withdrawals/request', method: 'POST', auth: { kind: 'jwt' } };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), true);
});

test('read-only API key cannot POST withdrawals', () => {
  const req = {
    originalUrl: '/api/withdrawals/request',
    method: 'POST',
    auth: { kind: 'api_key', scopes: ['read'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), false);
  assert.equal(res.statusCode, 403);
});

test('API key with withdrawals scope can POST withdrawals', () => {
  const req = {
    originalUrl: '/api/withdrawals/request',
    method: 'POST',
    auth: { kind: 'api_key', scopes: ['read', 'withdrawals'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), true);
});

test('read-only API key can GET withdrawals', () => {
  const req = {
    originalUrl: '/api/withdrawals/campaign/x',
    method: 'GET',
    auth: { kind: 'api_key', scopes: ['read'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), true);
});

test('developer scope required for api-keys routes', () => {
  const req = {
    originalUrl: '/api/api-keys',
    method: 'GET',
    auth: { kind: 'api_key', scopes: ['read', 'write', 'withdrawals'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), false);
  assert.equal(res.statusCode, 403);
});

test('full scope allows developer routes', () => {
  const req = {
    originalUrl: '/api/api-keys',
    method: 'GET',
    auth: { kind: 'api_key', scopes: ['full'] },
  };
  const res = mockRes();
  assert.equal(assertApiKeyScopes(req, res), true);
});
