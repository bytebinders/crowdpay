require('dotenv').config();
require('./config/env').validateEnv();

const express = require('express');
const cors = require('cors');
const { startLedgerMonitor, getLedgerStreamHealth } = require('./services/ledgerMonitor');

const app = express();

app.use(cors());
app.use(express.json());
app.use(requestIdMiddleware);

app.use('/api/users', require('./routes/users'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/contributions', require('./routes/contributions'));
app.use('/api/withdrawals', require('./routes/withdrawals'));
app.use('/api/stellar/transactions', require('./routes/stellarTransactions'));
app.use('/api/api-keys', require('./routes/apiKeys'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/milestones', require('./routes/milestones'));

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.get('/health/ledger', async (_req, res) => {
  try {
    const body = await getLedgerStreamHealth();
    res.json(body);
  } catch (err) {
    res.status(500).json({ error: err.message || 'ledger health failed' });
  }
});

const { startWebhookRetryPoller } = require('./services/webhookDispatcher');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`CrowdPay backend running on port ${PORT}`);
  console.log(`Stellar network: ${process.env.STELLAR_NETWORK}`);
  startLedgerMonitor();
  startWebhookRetryPoller();
});
