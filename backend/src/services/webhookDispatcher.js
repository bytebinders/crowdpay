const crypto = require('crypto');
const db = require('../config/database');

const WEBHOOK_EVENTS = {
  CAMPAIGN_FUNDED: 'campaign.funded',
  CONTRIBUTION_RECEIVED: 'contribution.received',
  MILESTONE_APPROVED: 'milestone.approved',
  WITHDRAWAL_COMPLETED: 'withdrawal.completed',
};

const ALL_WEBHOOK_EVENTS = Object.values(WEBHOOK_EVENTS);
const MAX_DELIVERY_ATTEMPTS = 5;

function hmacSignature(secret, bodyUtf8) {
  return crypto.createHmac('sha256', secret).update(bodyUtf8, 'utf8').digest('hex');
}

function backoffMs(attemptNumber) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attemptNumber - 1));
}

/** Queue outbound webhook deliveries for every active endpoint owned by `ownerUserId`. */
async function emitWebhookEventForUser(ownerUserId, eventType, payload) {
  if (!ownerUserId) return;
  const { rows: hooks } = await db.query(
    `SELECT id, url, secret FROM webhooks
     WHERE user_id = $1 AND revoked_at IS NULL AND $2 = ANY(events)`,
    [ownerUserId, eventType]
  );
  for (const h of hooks) {
    const { rows: inserted } = await db.query(
      `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status)
       VALUES ($1, $2, $3::jsonb, 'pending') RETURNING id`,
      [h.id, eventType, JSON.stringify(payload)]
    );
    const deliveryId = inserted[0].id;
    setImmediate(() => {
      processDelivery(deliveryId).catch((err) =>
        console.error(`[webhooks] delivery ${deliveryId}:`, err.message)
      );
    });
  }
}

async function processDelivery(deliveryId) {
  const { rows } = await db.query(
    `SELECT d.id, d.attempt_count, d.status, d.payload, d.event_type,
            w.url, w.secret, w.revoked_at
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.id = $1`,
    [deliveryId]
  );
  if (!rows.length) return;
  const row = rows[0];
  if (row.revoked_at) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'failed', last_error = 'webhook revoked', updated_at = NOW() WHERE id = $1`,
      [deliveryId]
    );
    return;
  }
  if (row.status === 'delivered') return;

  const nextAttempt = row.attempt_count + 1;
  if (nextAttempt > MAX_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [deliveryId, 'max delivery attempts exceeded']
    );
    return;
  }

  const bodyUtf8 = JSON.stringify(row.payload);
  const sig = hmacSignature(row.secret, bodyUtf8);

  await db.query(
    `UPDATE webhook_deliveries SET attempt_count = $2, status = 'delivering', updated_at = NOW() WHERE id = $1`,
    [deliveryId, nextAttempt]
  );

  let res;
  let responseText = '';
  try {
    res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CrowdPay-Signature': `sha256=${sig}`,
        'X-CrowdPay-Event': row.event_type,
        'X-CrowdPay-Delivery-Id': deliveryId,
      },
      body: bodyUtf8,
      signal: AbortSignal.timeout(9000),
    });
    responseText = await res.text();
  } catch (err) {
    await scheduleRetry(deliveryId, nextAttempt, err.message || String(err), null, null);
    return;
  }

  const snippet = responseText.slice(0, 512);
  if (res.ok) {
    await db.query(
      `UPDATE webhook_deliveries
       SET status = 'delivered', response_status = $2, response_body_snippet = $3,
           delivered_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, res.status, snippet]
    );
    return;
  }

  await scheduleRetry(
    deliveryId,
    nextAttempt,
    `HTTP ${res.status}`,
    res.status,
    snippet
  );
}

async function scheduleRetry(deliveryId, attemptJustUsed, errMsg, httpStatus, snippet) {
  if (attemptJustUsed >= MAX_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE webhook_deliveries
       SET status = 'failed', last_error = $2, response_status = $3, response_body_snippet = $4, updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, errMsg, httpStatus, snippet]
    );
    return;
  }

  const delay = backoffMs(attemptJustUsed);
  const nextAt = new Date(Date.now() + delay);
  await db.query(
    `UPDATE webhook_deliveries
     SET status = 'retrying', next_retry_at = $2, last_error = $3,
         response_status = $4, response_body_snippet = $5, updated_at = NOW()
     WHERE id = $1`,
    [deliveryId, nextAt.toISOString(), errMsg, httpStatus, snippet]
  );

  setTimeout(() => {
    processDelivery(deliveryId).catch((err) =>
      console.error(`[webhooks] retry ${deliveryId}:`, err.message)
    );
  }, delay);
}

async function processDueRetries() {
  const { rows } = await db.query(
    `SELECT id FROM webhook_deliveries
     WHERE status = 'retrying' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()
     LIMIT 25`
  );
  for (const r of rows) {
    processDelivery(r.id).catch((err) =>
      console.error(`[webhooks] poller ${r.id}:`, err.message)
    );
  }
}

function startWebhookRetryPoller() {
  setInterval(() => {
    processDueRetries().catch((e) => console.error('[webhooks] poller:', e.message));
  }, 5000);
}

module.exports = {
  WEBHOOK_EVENTS,
  ALL_WEBHOOK_EVENTS,
  MAX_DELIVERY_ATTEMPTS,
  hmacSignature,
  emitWebhookEventForUser,
  processDelivery,
  startWebhookRetryPoller,
};
