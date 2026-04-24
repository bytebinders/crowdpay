/**
 * ledgerMonitor.js
 *
 * Opens Horizon streaming connections for all active campaign wallets.
 * When a payment is detected, it indexes the contribution in PostgreSQL
 * and updates the campaign's raised amount.
 */

const { server } = require('../config/stellar');
const db = require('../config/database');
const { markContributionIndexed } = require('./stellarTransactionService');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('./webhookDispatcher');

// Map of publicKey -> EventSource (so we can close them if needed)
const activeStreams = new Map();

async function watchCampaignWallet(campaignId, walletPublicKey) {
  if (activeStreams.has(walletPublicKey)) return;

  logger.info('Watching campaign wallet', { campaign_id: campaignId, wallet: walletPublicKey });

  const closeStream = server
    .payments()
    .forAccount(walletPublicKey)
    .cursor('now')
    .stream({
      onmessage: (payment) => handlePayment(campaignId, walletPublicKey, payment),
      onerror: (err) => {
        logger.error('Ledger stream error', {
          campaign_id: campaignId,
          wallet: walletPublicKey,
          error: err.message || String(err),
        });
        sendAlert('Ledger monitor stream error', {
          campaign_id: campaignId,
          wallet: walletPublicKey,
          error: err.message || String(err),
        });
      },
    });

  activeStreams.set(walletPublicKey, closeStream);
}

async function handlePayment(campaignId, walletPublicKey, payment) {
  // Only process incoming payments
  if (payment.to !== walletPublicKey) return;
  if (payment.type !== 'payment' && payment.type !== 'path_payment_strict_receive') return;

  const { rows: campaignRows } = await db.query(
    'SELECT status FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!campaignRows.length || campaignRows[0].status !== 'active') return;

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
    logger.error('Failed to index contribution', {
      campaign_id: campaignId,
      tx_hash: txHash,
      error: err.message,
    });
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

async function startLedgerMonitor() {
  const { rows } = await db.query(
    `SELECT id, wallet_public_key FROM campaigns WHERE status = 'active'`
  );

  for (const campaign of rows) {
    watchCampaignWallet(campaign.id, campaign.wallet_public_key);
  }

  logger.info('Ledger monitor started', { active_campaigns: rows.length });
}

module.exports = { startLedgerMonitor, watchCampaignWallet, handlePayment };
