const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const logger = require('../config/logger');
const { sendAlert } = require('../services/alerting');
const {
  buildWithdrawalTransaction,
  getAccountMultisigConfig,
  signTransactionXdr,
  signatureCountFromXdr,
  submitSignedWithdrawal,
  PLATFORM_PUBLIC_KEY,
} = require('../services/stellarService');
const {
  insertWithdrawalPendingSignatures,
  finalizeWithdrawalSubmitted,
  markWithdrawalFailed,
} = require('../services/stellarTransactionService');
const { sendEmail } = require('../services/emailService');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');

const ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST = ['active', 'funded'];

function hasSigner(signers, publicKey) {
  return signers.some((s) => s.key === publicKey && s.weight >= 1);
}

/** Dev / open mode: any authenticated user may perform platform signature API calls when unset. */
function canPerformPlatformSignature(userId) {
  if (!process.env.PLATFORM_APPROVER_USER_ID) return true;
  return userId === process.env.PLATFORM_APPROVER_USER_ID;
}

/** For viewing audit trails: only creator or an explicitly configured platform approver. */
function isPlatformApproverForAudit(userId) {
  if (!process.env.PLATFORM_APPROVER_USER_ID) return false;
  return userId === process.env.PLATFORM_APPROVER_USER_ID;
}

async function logWithdrawalEvent(client, { withdrawalRequestId, actorUserId, action, note, metadata }) {
  const runner = client || db;
  await runner.query(
    `INSERT INTO withdrawal_approval_events
       (withdrawal_request_id, actor_user_id, action, note, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [withdrawalRequestId, actorUserId || null, action, note || null, metadata ? JSON.stringify(metadata) : null]
  );
}

async function assertWithdrawalAccess(req, campaignId) {
  const { rows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [campaignId]);
  if (!rows.length) return { error: 'Campaign not found', status: 404 };
  const isCreator = rows[0].creator_id === req.user.userId;
  const isPlatform = isPlatformApproverForAudit(req.user.userId);
  if (!isCreator && !isPlatform) {
    return { error: 'Not authorized to view or manage withdrawals for this campaign', status: 403 };
  }
  return { creatorId: rows[0].creator_id, isCreator, isPlatform };
}

router.get('/capabilities', requireAuth, (req, res) => {
  res.json({ can_approve_platform: canPerformPlatformSignature(req.user.userId) });
});

router.post('/request', requireAuth, async (req, res) => {
  const { campaign_id, destination_key, amount } = req.body;
  if (!campaign_id || !destination_key || !amount) {
    return res.status(400).json({ error: 'campaign_id, destination_key and amount are required' });
  }
  if (!Number(amount) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const { rows: campaigns } = await db.query(
    `SELECT id, creator_id, wallet_public_key, asset_type, status
     FROM campaigns WHERE id = $1`,
    [campaign_id]
  );
  if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = campaigns[0];

  if (campaign.creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Only campaign creator can request withdrawal' });
  }
  if (!ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST.includes(campaign.status)) {
    return res.status(409).json({
      error: `Withdrawals cannot be requested while campaign status is "${campaign.status}".`,
    });
  }

  const { rows: pending } = await db.query(
    `SELECT id FROM withdrawal_requests
     WHERE campaign_id = $1 AND status = 'pending' LIMIT 1`,
    [campaign_id]
  );
  if (pending.length) {
    return res.status(409).json({
      error: 'A pending withdrawal already exists for this campaign. Cancel it or wait for completion before opening another.',
    });
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

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO withdrawal_requests
         (campaign_id, requested_by, amount, destination_key, unsigned_xdr, creator_signed, platform_signed)
       VALUES ($1, $2, $3, $4, $5, FALSE, FALSE)
       RETURNING *`,
      [campaign_id, req.user.userId, amount, destination_key, xdr]
    );
    await logWithdrawalEvent(client, {
      withdrawalRequestId: rows[0].id,
      actorUserId: req.user.userId,
      action: 'requested',
      note: null,
      metadata: { amount, destination_key, asset_type: campaign.asset_type },
    });
    await insertWithdrawalPendingSignatures(client, {
      campaignId: campaign_id,
      withdrawalRequestId: rows[0].id,
      userId: req.user.userId,
      unsignedXdr: xdr,
      metadata: {
        amount,
        destination_key,
        asset_type: campaign.asset_type,
      },
    });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Withdrawal request creation failed', { error: err.message, campaign_id });
    res.status(500).json({ error: 'Could not create withdrawal request' });
  } finally {
    client.release();
  }
});

router.post('/:id/approve/creator', requireAuth, async (req, res) => {
  const { rows: requests } = await db.query(
    `SELECT wr.*, c.creator_id, c.status AS campaign_status
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
  if (!requestRow.is_refund && !ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST.includes(requestRow.campaign_status)) {
    return res.status(409).json({
      error: `Campaign status is "${requestRow.campaign_status}". Creator approval is not allowed.`,
    });
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

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE withdrawal_requests
       SET unsigned_xdr = $1, creator_signed = TRUE
       WHERE id = $2 AND status = 'pending' AND creator_signed = FALSE
       RETURNING *`,
      [signedXdr, req.params.id]
    );
    if (!updated.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Withdrawal request changed; refresh and try again.' });
    }
    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'creator_signed',
      note: null,
      metadata: {},
    });
    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Creator approval recording failed', { withdrawal_id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Could not record creator approval' });
  } finally {
    client.release();
  }
});

router.post('/:id/approve/platform', requireAuth, async (req, res) => {
  if (!canPerformPlatformSignature(req.user.userId)) {
    return res.status(403).json({ error: 'Only designated platform approver can sign as platform' });
  }

  const { rows: requests } = await db.query(
    `SELECT wr.*, c.status AS campaign_status
     FROM withdrawal_requests wr
     JOIN campaigns c ON c.id = wr.campaign_id
     WHERE wr.id = $1`,
    [req.params.id]
  );
  if (!requests.length) return res.status(404).json({ error: 'Withdrawal request not found' });
  const requestRow = requests[0];

  if (!requestRow.is_refund && !ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST.includes(requestRow.campaign_status)) {
    return res.status(409).json({
      error: `Campaign status is "${requestRow.campaign_status}". Platform release is blocked.`,
    });
  }
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

  let txHash;
  try {
    txHash = await submitSignedWithdrawal({ xdr: signedXdr });
  } catch (err) {
    logger.error('Withdrawal Stellar submission failed', {
      withdrawal_id: req.params.id,
      error: err.message,
    });
    sendAlert('Withdrawal submission failed', {
      withdrawal_id: req.params.id,
      error: err.message,
    });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE withdrawal_requests SET status = 'failed' WHERE id = $1 AND status = 'pending'`,
        [req.params.id]
      );
      await logWithdrawalEvent(client, {
        withdrawalRequestId: req.params.id,
        actorUserId: req.user.userId,
        action: 'submit_failed',
        note: err.message || 'Stellar submit failed',
        metadata: { detail: String(err) },
      });
      await markWithdrawalFailed(client, {
        withdrawalRequestId: req.params.id,
        reason: err.message || 'Stellar submit failed',
      });
      await client.query('COMMIT');
    } catch (logErr) {
      await client.query('ROLLBACK');
      logger.error('Failed to persist withdrawal submit error', { withdrawal_id: req.params.id, error: logErr.message });
    } finally {
      client.release();
    }
    return res.status(502).json({
      error: 'Stellar network rejected the transaction after dual approval. Request marked failed; see audit log.',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE withdrawal_requests
       SET unsigned_xdr = $1, platform_signed = TRUE, status = 'submitted', tx_hash = $2
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [signedXdr, txHash, req.params.id]
    );
    if (!updated.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Withdrawal request changed; refresh and try again.' });
    }
    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'platform_signed',
      note: null,
      metadata: { tx_hash: txHash },
    });
    await finalizeWithdrawalSubmitted(client, {
      withdrawalRequestId: req.params.id,
      txHash,
      signedXdr,
    });
    await client.query('COMMIT');

    // Notify creator
    const { rows: cRows } = await db.query(
      `SELECT u.email FROM users u JOIN campaigns c ON c.creator_id = u.id WHERE c.id = $1`,
      [requestRow.campaign_id]
    );
    if (cRows.length) {
      sendEmail({
        to: cRows[0].email,
        subject: 'Withdrawal Approved',
        text: `Your withdrawal for ${requestRow.amount} has been approved by the platform. Transaction Hash: ${txHash}`
      });
    }

    const withdrawalRow = updated[0];
    setImmediate(() => {
      db.query('SELECT creator_id FROM campaigns WHERE id = $1', [withdrawalRow.campaign_id])
        .then(({ rows: cr }) => {
          if (!cr.length) return;
          return emitWebhookEventForUser(cr[0].creator_id, WEBHOOK_EVENTS.WITHDRAWAL_COMPLETED, {
            withdrawal: { ...withdrawalRow, tx_hash: txHash },
          });
        })
        .catch((e) => console.error('[withdrawals] webhook:', e.message));
    });
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Platform approval persistence failed after Stellar submit', {
      withdrawal_id: req.params.id,
      tx_hash: txHash,
      error: err.message,
    });
    res.status(500).json({ error: 'Transaction submitted but failed to update records; check Stellar and audit trail.' });
  } finally {
    client.release();
  }
});

router.post('/:id/cancel', requireAuth, async (req, res) => {
  const reason = (req.body && req.body.reason) || 'Cancelled by creator';

  const { rows: requests } = await db.query(
    `SELECT wr.*, c.creator_id
     FROM withdrawal_requests wr
     JOIN campaigns c ON c.id = wr.campaign_id
     WHERE wr.id = $1`,
    [req.params.id]
  );
  if (!requests.length) return res.status(404).json({ error: 'Withdrawal request not found' });
  const requestRow = requests[0];

  if (requestRow.creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Only the campaign creator can cancel this request' });
  }
  if (requestRow.status !== 'pending') {
    return res.status(409).json({ error: 'Only pending requests can be cancelled' });
  }
  if (requestRow.creator_signed) {
    return res.status(409).json({
      error: 'Creator signature is already attached. Use platform reject flow instead of cancel.',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE withdrawal_requests
       SET status = 'denied', denial_reason = $1
       WHERE id = $2 AND status = 'pending' AND creator_signed = FALSE
       RETURNING *`,
      [reason, req.params.id]
    );
    if (!updated.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Withdrawal request changed; refresh and try again.' });
    }
    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'creator_cancelled',
      note: reason,
      metadata: {},
    });
    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Withdrawal cancellation failed', { withdrawal_id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Could not cancel withdrawal request' });
  } finally {
    client.release();
  }
});

router.post('/:id/reject', requireAuth, async (req, res) => {
  if (!canPerformPlatformSignature(req.user.userId)) {
    return res.status(403).json({ error: 'Only designated platform approver can reject at this stage' });
  }
  const reason = (req.body && req.body.reason) || 'Rejected by platform';

  const { rows: requests } = await db.query(
    'SELECT * FROM withdrawal_requests WHERE id = $1',
    [req.params.id]
  );
  if (!requests.length) return res.status(404).json({ error: 'Withdrawal request not found' });
  const requestRow = requests[0];

  if (requestRow.status !== 'pending') {
    return res.status(409).json({ error: 'Only pending requests can be rejected' });
  }
  if (!requestRow.creator_signed) {
    return res.status(409).json({ error: 'Creator must sign before platform can reject this release' });
  }
  if (requestRow.platform_signed) {
    return res.status(409).json({ error: 'Platform has already signed; cannot reject' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE withdrawal_requests
       SET status = 'denied', denial_reason = $1
       WHERE id = $2 AND status = 'pending' AND creator_signed = TRUE AND platform_signed = FALSE
       RETURNING *`,
      [reason, req.params.id]
    );
    if (!updated.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Withdrawal request changed; refresh and try again.' });
    }
    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'platform_rejected',
      note: reason,
      metadata: {},
    });
    await client.query('COMMIT');

    const { rows: cRows } = await db.query(
      `SELECT u.email FROM users u JOIN campaigns c ON c.creator_id = u.id WHERE c.id = $1`,
      [requestRow.campaign_id]
    );
    if (cRows.length) {
      sendEmail({
        to: cRows[0].email,
        subject: 'Withdrawal Rejected',
        text: `Your withdrawal request has been rejected by the platform. Reason: ${reason}`
      });
    }

    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Withdrawal rejection failed', { withdrawal_id: req.params.id, error: err.message });
    res.status(500).json({ error: 'Could not reject withdrawal request' });
  } finally {
    client.release();
  }
});

router.get('/campaign/:campaignId', requireAuth, async (req, res) => {
  const access = await assertWithdrawalAccess(req, req.params.campaignId);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const { rows } = await db.query(
    `SELECT id, campaign_id, requested_by, amount, destination_key, creator_signed,
            platform_signed, status, denial_reason, tx_hash, created_at
     FROM withdrawal_requests
     WHERE campaign_id = $1
     ORDER BY created_at DESC`,
    [req.params.campaignId]
  );
  res.json(rows);
});

router.get('/:id/events', requireAuth, async (req, res) => {
  const { rows: wr } = await db.query(
    `SELECT wr.campaign_id FROM withdrawal_requests wr WHERE wr.id = $1`,
    [req.params.id]
  );
  if (!wr.length) return res.status(404).json({ error: 'Withdrawal request not found' });

  const access = await assertWithdrawalAccess(req, wr[0].campaign_id);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const { rows } = await db.query(
    `SELECT e.id, e.withdrawal_request_id, e.actor_user_id, e.action, e.note, e.metadata, e.created_at
     FROM withdrawal_approval_events e
     WHERE e.withdrawal_request_id = $1
     ORDER BY e.created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
});

module.exports = router;
