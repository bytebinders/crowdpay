const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const {
  buildWithdrawalTransaction,
  getAccountMultisigConfig,
  signTransactionXdr,
  signatureCountFromXdr,
  submitSignedWithdrawal,
  PLATFORM_PUBLIC_KEY,
} = require('../services/stellarService');

function hasSigner(signers, publicKey) {
  return signers.some((s) => s.key === publicKey && s.weight >= 1);
}

// Request a withdrawal (creator only). Stores base transaction XDR.
router.post('/request', requireAuth, async (req, res) => {
  const { campaign_id, destination_key, amount } = req.body;
  if (!campaign_id || !destination_key || !amount) {
    return res.status(400).json({ error: 'campaign_id, destination_key and amount are required' });
  }

  const { rows: campaigns } = await db.query(
    'SELECT id, creator_id, wallet_public_key, asset_type FROM campaigns WHERE id = $1',
    [campaign_id]
  );
  if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = campaigns[0];

  if (campaign.creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Only campaign creator can request withdrawal' });
  }

  const { rows: creatorRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  const creatorPublicKey = creatorRows[0].wallet_public_key;

  const multisig = await getAccountMultisigConfig(campaign.wallet_public_key);
  if (
    multisig.thresholds.med_threshold < 2 ||
    !hasSigner(multisig.signers, creatorPublicKey) ||
    !hasSigner(multisig.signers, PLATFORM_PUBLIC_KEY)
  ) {
    return res.status(422).json({
      error: 'Campaign wallet multisig config invalid: creator + platform signatures are required',
    });
  }

  const xdr = await buildWithdrawalTransaction({
    campaignWalletPublicKey: campaign.wallet_public_key,
    destinationPublicKey: destination_key,
    amount,
    asset: campaign.asset_type,
  });

  const { rows } = await db.query(
    `INSERT INTO withdrawal_requests
       (campaign_id, requested_by, amount, destination_key, unsigned_xdr, creator_signed, platform_signed)
     VALUES ($1, $2, $3, $4, $5, FALSE, FALSE)
     RETURNING *`,
    [campaign_id, req.user.userId, amount, destination_key, xdr]
  );

  res.status(201).json(rows[0]);
});

// Creator approval/signature.
router.post('/:id/approve/creator', requireAuth, async (req, res) => {
  const { rows: requests } = await db.query(
    `SELECT wr.*, c.creator_id, c.wallet_public_key AS campaign_wallet_key
     FROM withdrawal_requests wr
     JOIN campaigns c ON c.id = wr.campaign_id
     WHERE wr.id = $1`,
    [req.params.id]
  );
  if (!requests.length) return res.status(404).json({ error: 'Withdrawal request not found' });
  const requestRow = requests[0];

  if (requestRow.creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Only campaign creator can approve creator signature' });
  }
  if (requestRow.status !== 'pending') {
    return res.status(409).json({ error: 'Withdrawal request is no longer pending' });
  }
  if (requestRow.creator_signed) {
    return res.status(409).json({ error: 'Creator already approved this withdrawal' });
  }

  const { rows: users } = await db.query(
    'SELECT wallet_secret_encrypted FROM users WHERE id = $1',
    [req.user.userId]
  );
  const creatorSecret = users[0].wallet_secret_encrypted;

  const signedXdr = signTransactionXdr({
    xdr: requestRow.unsigned_xdr,
    signerSecret: creatorSecret,
  });

  const { rows: updated } = await db.query(
    `UPDATE withdrawal_requests
     SET unsigned_xdr = $1, creator_signed = TRUE
     WHERE id = $2
     RETURNING *`,
    [signedXdr, req.params.id]
  );

  res.json(updated[0]);
});

// Platform approval/signature and final submission.
router.post('/:id/approve/platform', requireAuth, async (req, res) => {
  if (process.env.PLATFORM_APPROVER_USER_ID && req.user.userId !== process.env.PLATFORM_APPROVER_USER_ID) {
    return res.status(403).json({ error: 'Only designated platform approver can sign as platform' });
  }

  const { rows: requests } = await db.query(
    'SELECT * FROM withdrawal_requests WHERE id = $1',
    [req.params.id]
  );
  if (!requests.length) return res.status(404).json({ error: 'Withdrawal request not found' });
  const requestRow = requests[0];

  if (requestRow.status !== 'pending') {
    return res.status(409).json({ error: 'Withdrawal request is no longer pending' });
  }
  if (!requestRow.creator_signed) {
    return res.status(409).json({ error: 'Creator approval is required before platform approval' });
  }
  if (requestRow.platform_signed) {
    return res.status(409).json({ error: 'Platform already approved this withdrawal' });
  }

  const signedXdr = signTransactionXdr({
    xdr: requestRow.unsigned_xdr,
    signerSecret: process.env.PLATFORM_SECRET_KEY,
  });

  const signatureCount = signatureCountFromXdr(signedXdr);
  if (signatureCount < 2) {
    return res.status(422).json({ error: 'Insufficient signatures: expected creator + platform' });
  }

  const txHash = await submitSignedWithdrawal({ xdr: signedXdr });

  const { rows: updated } = await db.query(
    `UPDATE withdrawal_requests
     SET unsigned_xdr = $1, platform_signed = TRUE, status = 'submitted', tx_hash = $2
     WHERE id = $3
     RETURNING *`,
    [signedXdr, txHash, req.params.id]
  );

  res.json(updated[0]);
});

// List withdrawals for campaign.
router.get('/campaign/:campaignId', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, campaign_id, requested_by, amount, destination_key, creator_signed,
            platform_signed, status, tx_hash, created_at
     FROM withdrawal_requests
     WHERE campaign_id = $1
     ORDER BY created_at DESC`,
    [req.params.campaignId]
  );
  res.json(rows);
});

module.exports = router;
