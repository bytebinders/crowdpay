const db = require('../config/database');

async function insertContributionSubmitted(client, row) {
  const runner = client || db;
  const { rows } = await runner.query(
    `INSERT INTO stellar_transactions
       (kind, status, tx_hash, campaign_id, initiated_by_user_id,
        unsigned_xdr, signed_xdr, metadata)
     VALUES ('contribution', 'submitted', $1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [
      row.txHash,
      row.campaignId,
      row.userId,
      row.unsignedXdr,
      row.signedXdr,
      JSON.stringify(row.metadata || {}),
    ]
  );
  return rows[0].id;
}

async function insertWithdrawalPendingSignatures(client, row) {
  const runner = client || db;
  const { rows } = await runner.query(
    `INSERT INTO stellar_transactions
       (kind, status, campaign_id, withdrawal_request_id, initiated_by_user_id,
        unsigned_xdr, metadata)
     VALUES ('withdrawal', 'pending_signatures', $1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      row.campaignId,
      row.withdrawalRequestId,
      row.userId,
      row.unsignedXdr,
      JSON.stringify(row.metadata || {}),
    ]
  );
  return rows[0].id;
}

async function markContributionIndexed(client, txHash, contributionId) {
  const runner = client || db;
  await runner.query(
    `UPDATE stellar_transactions
     SET status = 'indexed', contribution_id = $1, updated_at = NOW()
     WHERE tx_hash = $2 AND kind = 'contribution'`,
    [contributionId, txHash]
  );
}

async function finalizeWithdrawalSubmitted(client, { withdrawalRequestId, txHash, signedXdr }) {
  const runner = client || db;
  await runner.query(
    `UPDATE stellar_transactions
     SET status = 'submitted', tx_hash = $1, signed_xdr = $2, updated_at = NOW()
     WHERE withdrawal_request_id = $3 AND kind = 'withdrawal'`,
    [txHash, signedXdr, withdrawalRequestId]
  );
}

async function markWithdrawalFailed(client, { withdrawalRequestId, reason }) {
  const runner = client || db;
  await runner.query(
    `UPDATE stellar_transactions
     SET status = 'failed', failure_reason = $1, updated_at = NOW()
     WHERE withdrawal_request_id = $2 AND kind = 'withdrawal'`,
    [reason || 'unknown', withdrawalRequestId]
  );
}

module.exports = {
  insertContributionSubmitted,
  insertWithdrawalPendingSignatures,
  markContributionIndexed,
  finalizeWithdrawalSubmitted,
  markWithdrawalFailed,
};
