const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');

function canPerformPlatformSignature(userId) {
  if (!process.env.PLATFORM_APPROVER_USER_ID) return true;
  return userId === process.env.PLATFORM_APPROVER_USER_ID;
}

router.get('/campaign/:campaignId', async (req, res) => {
  const { rows } = await db.query(
    `SELECT m.id, m.campaign_id, m.title, m.sort_order, m.status, m.created_at
     FROM milestones m
     WHERE m.campaign_id = $1
     ORDER BY m.sort_order ASC, m.created_at ASC`,
    [req.params.campaignId]
  );
  res.json(rows);
});

router.post('/', requireAuth, async (req, res) => {
  const { campaign_id: campaignId, title, sort_order: sortOrder } = req.body || {};
  if (!campaignId || !title) {
    return res.status(400).json({ error: 'campaign_id and title are required' });
  }
  const { rows: camp } = await db.query(
    'SELECT id, creator_id FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!camp.length) return res.status(404).json({ error: 'Campaign not found' });
  if (camp[0].creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Only the campaign creator can add milestones' });
  }

  const { rows } = await db.query(
    `INSERT INTO milestones (campaign_id, title, sort_order)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [campaignId, title, Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0]
  );
  res.status(201).json(rows[0]);
});

router.post('/:id/approve', requireAuth, async (req, res) => {
  if (!canPerformPlatformSignature(req.user.userId)) {
    return res.status(403).json({ error: 'Only the designated platform approver can approve milestones' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: ms } = await client.query(
      `SELECT m.*, c.creator_id
       FROM milestones m
       JOIN campaigns c ON c.id = m.campaign_id
       WHERE m.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!ms.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Milestone not found' });
    }
    const row = ms[0];
    if (row.status === 'approved') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Milestone already approved' });
    }

    const { rows: updated } = await client.query(
      `UPDATE milestones SET status = 'approved' WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id]
    );
    if (!updated.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Milestone could not be approved' });
    }
    await client.query('COMMIT');

    setImmediate(() => {
      emitWebhookEventForUser(row.creator_id, WEBHOOK_EVENTS.MILESTONE_APPROVED, {
        milestone: updated[0],
        campaign_id: row.campaign_id,
      }).catch((e) => console.error('[milestones] webhook:', e.message));
    });

    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[milestones] approve failed:', err.message);
    res.status(500).json({ error: 'Could not approve milestone' });
  } finally {
    client.release();
  }
});

module.exports = router;
