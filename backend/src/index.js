require('dotenv').config();
require('./config/env').validateEnv();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const logger = require('./config/logger');
const { requestIdMiddleware } = require('./middleware/requestId');
const { startLedgerMonitor } = require('./services/ledgerMonitor');
const { sendAlert } = require('./services/alerting');

const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : '*'
}));
app.use(express.json({ limit: '50kb' }));

app.use('/api/users', require('./routes/users'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/contributions', require('./routes/contributions'));
app.use('/api/withdrawals', require('./routes/withdrawals'));
app.use('/api/stellar/transactions', require('./routes/stellarTransactions'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/api-keys', require('./routes/apiKeys'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/milestones', require('./routes/milestones'));

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const { startWebhookRetryPoller } = require('./services/webhookDispatcher');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`CrowdPay backend running on port ${PORT}`);
  console.log(`Stellar network: ${process.env.STELLAR_NETWORK}`);
  startLedgerMonitor();
  startWebhookRetryPoller();
});
