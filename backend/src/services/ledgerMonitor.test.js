const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('handlePayment updates stellar_transactions when a contribution row is created', async () => {
  const updates = [];
  const mockQuery = async (text, params) => {
    if (text.includes('SELECT id FROM contributions')) return { rows: [] };
    if (text.includes('SELECT creator_id FROM campaigns')) {
      return { rows: [{ creator_id: 'user-creator' }] };
    }
    if (text === 'BEGIN') return { rows: [] };
    if (text.includes('INSERT INTO contributions')) return { rows: [{ id: 'contrib-id' }] };
    if (text.includes('UPDATE campaigns')) return { rows: [] };
    if (text.includes('UPDATE stellar_transactions') && text.includes("kind = 'contribution'")) {
      updates.push({ text, params });
      return { rows: [] };
    }
    if (text === 'COMMIT') return { rows: [] };
    if (text === 'ROLLBACK') return { rows: [] };
    return { rows: [] };
  };

  const mockDb = {
    connect: async () => ({
      query: mockQuery,
      release: () => {},
    }),
  };

  const ledgerMonitor = proxyquire('./ledgerMonitor', {
    '../config/database': mockDb,
    '../config/stellar': { server: {} },
    './webhookDispatcher': {
      emitWebhookEventForUser: async () => {},
      WEBHOOK_EVENTS: {},
    },
  });

  const payment = {
    to: 'GWALLET',
    from: 'GFROM',
    type: 'payment',
    asset_type: 'native',
    amount: '1',
    transaction_hash: 'txhash-abc',
  };

  await ledgerMonitor.handlePayment('camp-1', 'GWALLET', payment);

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params, ['contrib-id', 'txhash-abc']);
});
