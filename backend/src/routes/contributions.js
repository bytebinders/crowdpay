const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const logger = require('../config/logger');
const { sendAlert } = require('../services/alerting');
const {
  prepareSignedContributionPayment,
  prepareSignedContributionPathPayment,
  submitPreparedTransaction,
  getPathPaymentQuote,
  getSupportedAssetCodes,
  ensureCustodialAccountFundedAndTrusted,
} = require('../services/stellarService');
const { insertContributionSubmitted } = require('../services/stellarTransactionService');

const SLIPPAGE_BPS = 500; // 5.00%
const SUPPORTED_ASSETS = getSupportedAssetCodes();

// Get contributions for a campaign
router.get('/campaign/:campaignId', async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.sender_public_key, c.amount, c.asset, c.payment_type,
            c.source_amount, c.source_asset, c.conversion_rate, c.path,
            c.tx_hash, c.created_at,
            wr.status AS refund_status, wr.tx_hash AS refund_tx_hash
     FROM contributions c
     LEFT JOIN LATERAL (
       SELECT status, tx_hash
       FROM withdrawal_requests
       WHERE contribution_id = c.id
       ORDER BY created_at DESC
       LIMIT 1
     ) wr ON TRUE
     WHERE c.campaign_id = $1
     ORDER BY c.created_at DESC`,
    [req.params.campaignId]
  );
  res.json(rows);
});

// Trace contribution settlement by Stellar tx hash (submitted vs indexed on ledger)
router.get('/finalization/:txHash', requireAuth, async (req, res) => {
  const txHash = req.params.txHash;
  const { rows } = await db.query(
    `SELECT st.id, st.status, st.tx_hash, st.campaign_id, st.contribution_id,
            st.initiated_by_user_id, st.metadata, st.created_at, st.updated_at,
            c.creator_id,
            ct.id AS contribution_row_id, ct.sender_public_key, ct.amount,
            ct.asset, ct.created_at AS contribution_created_at
     FROM stellar_transactions st
     JOIN campaigns c ON c.id = st.campaign_id
     LEFT JOIN contributions ct ON ct.id = st.contribution_id
     WHERE st.tx_hash = $1 AND st.kind = 'contribution'`,
    [txHash]
  );
  if (!rows.length) return res.status(404).json({ error: 'No contribution transaction found' });
  const row = rows[0];

  const { rows: userRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  const userPk = userRows[0]?.wallet_public_key;
  const isInitiator = row.initiated_by_user_id === req.user.userId;
  const isCreator = row.creator_id === req.user.userId;
  const isContributor = userPk && row.sender_public_key && row.sender_public_key === userPk;
  const isPlatform =
    process.env.PLATFORM_APPROVER_USER_ID &&
    req.user.userId === process.env.PLATFORM_APPROVER_USER_ID;

  if (!isInitiator && !isCreator && !isContributor && !isPlatform) {
    return res.status(403).json({ error: 'Not authorized to view this transaction' });
  }

  let finalizationStatus = 'awaiting_ledger';
  if (row.status === 'indexed') finalizationStatus = 'finalized';
  if (row.status === 'failed') finalizationStatus = 'failed';

  res.json({
    tx_hash: row.tx_hash,
    finalization_status: finalizationStatus,
    stellar_transaction_id: row.id,
    campaign_id: row.campaign_id,
    contribution: row.contribution_row_id
      ? {
          id: row.contribution_row_id,
          sender_public_key: row.sender_public_key,
          amount: row.amount,
          asset: row.asset,
          created_at: row.contribution_created_at,
        }
      : null,
    metadata: row.metadata,
    updated_at: row.updated_at,
  });
});

// Quote conversion before a path payment contribution
router.get('/quote', requireAuth, async (req, res) => {
  const { send_asset, dest_asset, dest_amount } = req.query;
  if (!send_asset || !dest_asset || !dest_amount) {
    return res.status(400).json({
      error: 'send_asset, dest_asset and dest_amount are required query params',
    });
  }
  if (!SUPPORTED_ASSETS.includes(send_asset) || !SUPPORTED_ASSETS.includes(dest_asset)) {
    return res.status(400).json({ error: `Supported assets: ${SUPPORTED_ASSETS.join(', ')}` });
  }

  const paths = await getPathPaymentQuote({
    sendAsset: send_asset,
    destAsset: dest_asset,
    destAmount: dest_amount,
  });

  if (!paths.length) {
    return res.status(404).json({ error: 'No conversion path found for requested assets' });
  }

  const bestPath = paths[0];
  const maxSendWithSlippage = (
    parseFloat(bestPath.source_amount) *
    (1 + SLIPPAGE_BPS / 10000)
  ).toFixed(7);

  res.json({
    send_asset,
    dest_asset,
    dest_amount: String(dest_amount),
    quoted_source_amount: bestPath.source_amount,
    max_send_amount: maxSendWithSlippage,
    estimated_rate: (
      parseFloat(dest_amount) / parseFloat(bestPath.source_amount)
    ).toFixed(15),
    path: bestPath.path,
    path_count: paths.length,
  });
});

// Contribute to a campaign (authenticated, custodial)
router.post('/', requireAuth, async (req, res) => {
  const { campaign_id, amount, send_asset } = req.body;
  if (!campaign_id || !amount || !send_asset) {
    return res.status(400).json({ error: 'campaign_id, amount and send_asset are required' });
  }
  if (!SUPPORTED_ASSETS.includes(send_asset)) {
    return res.status(400).json({ error: `Supported assets: ${SUPPORTED_ASSETS.join(', ')}` });
  }

  // Load campaign
  const { rows: campaigns } = await db.query(
    'SELECT * FROM campaigns WHERE id = $1 AND status = $2',
    [campaign_id, 'active']
  );
  if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });

  const campaign = campaigns[0];

  // Load contributor's custodial secret
  const { rows: users } = await db.query(
    'SELECT wallet_secret_encrypted, wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  const senderSecret = users[0].wallet_secret_encrypted; // decrypt in production
  const contributorPublicKey = users[0].wallet_public_key;

  try {
    await ensureCustodialAccountFundedAndTrusted({
      publicKey: contributorPublicKey,
      secret: senderSecret,
    });
  } catch (err) {
    logger.error('Custodial account setup failed', { campaign_id, error: err.message });
    return res.status(503).json({
      error: 'Wallet setup is still completing; please retry in a few seconds.',
    });
  }

  let txHash;
  let conversionQuote = null;
  let unsignedXdr;
  let signedXdr;
  let flowMetadata;

  if (send_asset === campaign.asset_type) {
    const prepared = await prepareSignedContributionPayment({
      senderSecret,
      destinationPublicKey: campaign.wallet_public_key,
      asset: send_asset,
      amount,
      memo: `cp-${campaign_id}`,
    });
    unsignedXdr = prepared.unsignedXdr;
    signedXdr = prepared.signedXdr;
    flowMetadata = {
      flow: 'payment',
      send_asset,
      amount: String(amount),
      contributor_public_key: contributorPublicKey,
    };
  } else {
    const paths = await getPathPaymentQuote({
      sendAsset: send_asset,
      destAsset: campaign.asset_type,
      destAmount: amount,
    });
    if (!paths.length) {
      return res.status(422).json({
        error: `No conversion path found for ${send_asset} -> ${campaign.asset_type}`,
      });
    }

    const bestPath = paths[0];
    const sendMax = (
      parseFloat(bestPath.source_amount) *
      (1 + SLIPPAGE_BPS / 10000)
    ).toFixed(7);

    const prepared = await prepareSignedContributionPathPayment({
      senderSecret,
      destinationPublicKey: campaign.wallet_public_key,
      sendAsset: send_asset,
      sendMax,
      destAmount: amount,
      destAssetCode: campaign.asset_type,
      memo: `cp-${campaign_id}`,
    });
    unsignedXdr = prepared.unsignedXdr;
    signedXdr = prepared.signedXdr;

    conversionQuote = {
      send_asset,
      campaign_asset: campaign.asset_type,
      campaign_amount: String(amount),
      quoted_source_amount: bestPath.source_amount,
      max_send_amount: sendMax,
      path: bestPath.path,
    };
    flowMetadata = {
      flow: 'path_payment_strict_receive',
      send_asset,
      dest_asset: campaign.asset_type,
      dest_amount: String(amount),
      max_send_amount: sendMax,
      contributor_public_key: contributorPublicKey,
    };
  }

  try {
    txHash = await submitPreparedTransaction(signedXdr);
  } catch (err) {
    logger.error('Stellar transaction submission failed', { campaign_id, error: err.message });
    sendAlert('Stellar transaction submission failed', { campaign_id, error: err.message });
    return res.status(502).json({
      error: 'Stellar network rejected the transaction',
      detail: err.message || String(err),
    });
  }

  const stellarTransactionId = await insertContributionSubmitted(null, {
    txHash,
    campaignId: campaign_id,
    userId: req.user.userId,
    unsignedXdr,
    signedXdr,
    metadata: flowMetadata,
  });

  res.status(202).json({
    tx_hash: txHash,
    stellar_transaction_id: stellarTransactionId,
    message: 'Transaction submitted',
    conversion_quote: conversionQuote,
  });
});

module.exports = router;
