/**
 * ledgerMonitor.js
 *
 * Streams Horizon payments for campaign wallets. Persists paging cursors so
 * restarts can REST-replay missed operations, then resumes the SSE stream.
 * Reconnects with exponential backoff on stream errors.
 */

const { server } = require('../config/stellar');
const db = require('../config/database');
const { markContributionIndexed } = require('./stellarTransactionService');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('./webhookDispatcher');

/** wallet_public_key -> stream metadata */
const streamRegistry = new Map();

/** Consecutive stream failures per wallet (survives registry clears between errors). */
const reconnectAttempts = new Map();

const MAX_RECONNECT_DELAY_MS = 60_000;

function extractPagingToken(record) {
  if (!record || typeof record !== 'object') return null;
  return record.paging_token || record.pagingToken || record.id || null;
}

async function loadCursor(campaignId) {
  const { rows } = await db.query(
    'SELECT last_cursor FROM ledger_stream_cursors WHERE campaign_id = $1',
    [campaignId]
  );
  return rows.length ? rows[0].last_cursor : null;
}

async function saveCursor(campaignId, walletPublicKey, cursorToken) {
  if (!cursorToken) return;
  await db.query(
    `INSERT INTO ledger_stream_cursors (campaign_id, wallet_public_key, last_cursor, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (campaign_id) DO UPDATE
     SET last_cursor = EXCLUDED.last_cursor,
         wallet_public_key = EXCLUDED.wallet_public_key,
         updated_at = NOW()`,
    [campaignId, walletPublicKey, String(cursorToken)]
  );
}

function registrySet(walletPublicKey, patch) {
  const prev = streamRegistry.get(walletPublicKey) || {
    wallet_public_key: walletPublicKey,
    state: 'idle',
    last_message_at: null,
    last_error: null,
    reconnect_attempt: 0,
  };
  streamRegistry.set(walletPublicKey, { ...prev, ...patch, wallet_public_key: walletPublicKey });
}

/**
 * REST page through operations after stored cursor (missed while server was down).
 */
async function replayMissedPayments(campaignId, walletPublicKey) {
  let cursor = await loadCursor(campaignId);
  if (!cursor) return;

  for (;;) {
    let page;
    try {
      page = await server
        .payments()
        .forAccount(walletPublicKey)
        .cursor(cursor)
        .order('asc')
        .limit(100)
        .call();
    } catch (err) {
      console.error(
        `[monitor] REST replay failed for ${walletPublicKey}; continuing with stream:`,
        err.message
      );
      return;
    }

    const records = page.records || [];
    if (!records.length) break;

    for (const record of records) {
      await onPaymentRecord(campaignId, walletPublicKey, record);
    }

    const pageToken = page.paging_token || extractPagingToken(records[records.length - 1]);
    if (!pageToken || pageToken === cursor) break;
    cursor = pageToken;
    if (records.length < 100) break;
  }
}

/**
 * Process one Horizon payment record and always advance stored cursor when possible.
 */
async function onPaymentRecord(campaignId, walletPublicKey, record) {
  const token = extractPagingToken(record);
  try {
    await handlePayment(campaignId, walletPublicKey, record);
  } finally {
    if (token) {
      try {
        await saveCursor(campaignId, walletPublicKey, token);
      } catch (e) {
        console.error('[monitor] Failed to persist ledger cursor:', e.message);
      }
    }
  }
}

async function handlePayment(campaignId, walletPublicKey, payment) {
  if (payment.to !== walletPublicKey) return;
  if (payment.type !== 'payment' && payment.type !== 'path_payment_strict_receive') return;

  const destinationAsset = payment.asset_type === 'native' ? 'XLM' : payment.asset_code;
  const destinationAmount = parseFloat(payment.amount);
  const sourceAsset = payment.source_asset_type
    ? (payment.source_asset_type === 'native' ? 'XLM' : payment.source_asset_code)
    : null;
  const sourceAmount = payment.source_amount ? parseFloat(payment.source_amount) : null;
  const path = Array.isArray(payment.path)
    ? payment.path.map((asset) => (asset.asset_type === 'native' ? 'XLM' : asset.asset_code))
    : null;
  const paymentType = payment.type;
  const conversionRate =
    sourceAmount && destinationAmount ? destinationAmount / sourceAmount : null;
  const txHash = payment.transaction_hash;

  const client = await db.connect();
  let postCommitHooks = null;
  try {
    const existing = await client.query(
      'SELECT id FROM contributions WHERE tx_hash = $1',
      [txHash]
    );
    if (existing.rows.length > 0) return;

    await client.query('BEGIN');

    const { rows: creatorRows } = await client.query(
      'SELECT creator_id FROM campaigns WHERE id = $1',
      [campaignId]
    );
    const creatorId = creatorRows[0].creator_id;

    const { rows: inserted } = await client.query(
      `INSERT INTO contributions
         (campaign_id, sender_public_key, amount, asset, payment_type, source_amount,
          source_asset, conversion_rate, path, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING id`,
      [
        campaignId,
        payment.from,
        destinationAmount,
        destinationAsset,
        paymentType,
        sourceAmount,
        sourceAsset,
        conversionRate,
        path ? JSON.stringify(path) : null,
        txHash,
      ]
    );

    await client.query(
      `UPDATE campaigns SET raised_amount = raised_amount + $1 WHERE id = $2`,
      [destinationAmount, campaignId]
    );

    const { rows: fundedRows } = await client.query(
      `UPDATE campaigns SET status = 'funded'
       WHERE id = $1 AND status = 'active' AND raised_amount >= target_amount
       RETURNING id, creator_id, title, raised_amount, target_amount, asset_type`,
      [campaignId]
    );

    await markContributionIndexed(client, txHash, inserted[0].id);

    await client.query('COMMIT');
    postCommitHooks = {
      creatorId,
      contributionId: inserted[0].id,
      campaignId,
      fundedCampaign: fundedRows[0] || null,
      contributionPayload: {
        id: inserted[0].id,
        campaign_id: campaignId,
        tx_hash: txHash,
        sender_public_key: payment.from,
        amount: String(destinationAmount),
        asset: destinationAsset,
        payment_type: paymentType,
      },
    };
    console.log(
      `[monitor] Contribution indexed: ${destinationAmount} ${destinationAsset} -> campaign ${campaignId}`
    );
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors after failed work
    }
    console.error('[monitor] Failed to index contribution:', err.message);
  } finally {
    client.release();
  }

  if (postCommitHooks) {
    setImmediate(() => {
      emitWebhookEventForUser(
        postCommitHooks.creatorId,
        WEBHOOK_EVENTS.CONTRIBUTION_RECEIVED,
        postCommitHooks.contributionPayload
      ).catch((e) => console.error('[monitor] contribution webhook:', e.message));
      if (postCommitHooks.fundedCampaign) {
        emitWebhookEventForUser(
          postCommitHooks.fundedCampaign.creator_id,
          WEBHOOK_EVENTS.CAMPAIGN_FUNDED,
          { campaign: postCommitHooks.fundedCampaign }
        ).catch((e) => console.error('[monitor] funded webhook:', e.message));
      }
    });
  }
}

function scheduleStreamReconnect(campaignId, walletPublicKey, attempt) {
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.max(0, attempt - 1));
  registrySet(walletPublicKey, {
    state: 'reconnecting',
    reconnect_attempt: attempt,
    next_reconnect_at: new Date(Date.now() + delay).toISOString(),
  });
  console.log(
    `[monitor] Scheduling stream reconnect for ${walletPublicKey} in ${delay}ms (attempt ${attempt})`
  );
  setTimeout(() => {
    watchCampaignWallet(campaignId, walletPublicKey)
      .then(() => reconnectAttempts.delete(walletPublicKey))
      .catch((err) =>
        console.error(`[monitor] Reconnect failed for ${walletPublicKey}:`, err.message)
      );
  }, delay);
}

async function openStreamForWallet(campaignId, walletPublicKey) {
  const stored = await loadCursor(campaignId);
  const streamCursor = stored || 'now';

  console.log(
    `[monitor] Stream ${walletPublicKey} cursor=${stored ? 'resumed' : 'now'} campaign=${campaignId}`
  );

  const closeStream = server
    .payments()
    .forAccount(walletPublicKey)
    .cursor(streamCursor)
    .stream({
      onmessage: (record) => {
        reconnectAttempts.delete(walletPublicKey);
        registrySet(walletPublicKey, {
          state: 'connected',
          last_message_at: new Date().toISOString(),
          reconnect_attempt: 0,
          last_error: null,
        });
        onPaymentRecord(campaignId, walletPublicKey, record).catch((err) =>
          console.error('[monitor] onPaymentRecord:', err.message)
        );
      },
      onerror: (err) => {
        console.error(`[monitor] Stream error for ${walletPublicKey}:`, err.message);
        const snap = streamRegistry.get(walletPublicKey);
        const attempt = (reconnectAttempts.get(walletPublicKey) || 0) + 1;
        reconnectAttempts.set(walletPublicKey, attempt);
        try {
          if (snap && typeof snap.close === 'function') snap.close();
        } catch {
          // ignore
        }
        streamRegistry.delete(walletPublicKey);
        scheduleStreamReconnect(campaignId, walletPublicKey, attempt);
      },
    });

  registrySet(walletPublicKey, {
    close: closeStream,
    campaign_id: campaignId,
    wallet_public_key: walletPublicKey,
    state: 'connected',
    stream_cursor: streamCursor,
    opened_at: new Date().toISOString(),
    reconnect_attempt: 0,
    last_error: null,
  });
}

/**
 * REST-replay from DB cursor, then open SSE stream (with auto-reconnect on errors).
 */
async function watchCampaignWallet(campaignId, walletPublicKey) {
  const existing = streamRegistry.get(walletPublicKey);
  if (existing && existing.state === 'connected' && typeof existing.close === 'function') {
    return;
  }
  if (existing) {
    try {
      if (typeof existing.close === 'function') existing.close();
    } catch {
      // ignore
    }
    streamRegistry.delete(walletPublicKey);
  }

  await replayMissedPayments(campaignId, walletPublicKey);
  await openStreamForWallet(campaignId, walletPublicKey);
}

async function startLedgerMonitor() {
  const { rows } = await db.query(
    `SELECT id, wallet_public_key FROM campaigns WHERE status = 'active'`
  );

  await Promise.all(
    rows.map((campaign) =>
      watchCampaignWallet(campaign.id, campaign.wallet_public_key).catch((err) =>
        console.error(`[monitor] Failed to watch ${campaign.wallet_public_key}:`, err.message)
      )
    )
  );

  console.log(`[monitor] Watching ${rows.length} active campaign(s)`);

  setInterval(() => {
    getLedgerStreamHealth()
      .then((h) => {
        const bad = h.streams.filter((s) => s.stale_stream_no_messages_15m);
        if (bad.length) {
          console.warn(
            '[monitor] health: connected streams idle >15m:',
            bad.map((b) => b.wallet_public_key).join(', ')
          );
        }
      })
      .catch(() => {});
  }, 5 * 60 * 1000);
}

/** For GET /health/ledger — in-process stream status + DB cursors. */
async function getLedgerStreamHealth() {
  const { rows: dbCursors } = await db.query(
    `SELECT c.id AS campaign_id, c.wallet_public_key, c.status AS campaign_status,
            lc.last_cursor, lc.updated_at AS cursor_updated_at
     FROM campaigns c
     LEFT JOIN ledger_stream_cursors lc ON lc.campaign_id = c.id
     WHERE c.status = 'active'`
  );

  const streams = dbCursors.map((row) => {
    const live = streamRegistry.get(row.wallet_public_key) || {};
    return {
      campaign_id: row.campaign_id,
      wallet_public_key: row.wallet_public_key,
      campaign_status: row.campaign_status,
      last_cursor: row.last_cursor || null,
      cursor_updated_at: row.cursor_updated_at || null,
      stream_state: live.state || 'not_connected',
      stream_opened_at: live.opened_at || null,
      last_stream_message_at: live.last_message_at || null,
      last_stream_error: live.last_error || null,
      reconnect_attempt:
        live.reconnect_attempt || reconnectAttempts.get(row.wallet_public_key) || 0,
      next_reconnect_at: live.next_reconnect_at || null,
    };
  });

  const staleMs = 15 * 60 * 1000;
  const now = Date.now();
  const streamsWithStale = streams.map((s) => {
    const last = s.last_stream_message_at ? new Date(s.last_stream_message_at).getTime() : 0;
    const stale =
      s.stream_state === 'connected' && last > 0 && now - last > staleMs;
    return { ...s, stale_stream_no_messages_15m: stale };
  });

  return {
    active_campaigns: streamsWithStale.length,
    streams: streamsWithStale,
  };
}

module.exports = {
  startLedgerMonitor,
  watchCampaignWallet,
  handlePayment,
  getLedgerStreamHealth,
};
