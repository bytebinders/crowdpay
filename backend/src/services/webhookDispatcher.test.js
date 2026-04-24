const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { hmacSignature } = require('./webhookDispatcher');

test('HMAC-SHA256 signature matches Node crypto verify pattern', () => {
  const secret = 'whsec_testsecret';
  const body = JSON.stringify({ hello: 'world' });
  const sig = hmacSignature(secret, body);
  const expected = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  assert.equal(sig, expected);
});
