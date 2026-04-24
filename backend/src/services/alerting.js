const logger = require('../config/logger');

async function sendAlert(message, context = {}) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;

  const hasContext = Object.keys(context).length > 0;
  const payload = {
    text: `*[CrowdPay Alert]* ${message}`,
    ...(hasContext && {
      attachments: [{ text: '```' + JSON.stringify(context, null, 2) + '```', color: 'danger' }],
    }),
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn('Alert webhook returned non-2xx', { status: res.status });
    }
  } catch (err) {
    logger.warn('Failed to deliver alert', { error: err.message });
  }
}

module.exports = { sendAlert };
