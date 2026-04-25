const router = require('express').Router();
const db = require('../config/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireAdmin);

// GET /stats
router.get('/stats', async (req, res) => {
  const users = await db.query('SELECT COUNT(*) FROM users');
  const campaigns = await db.query('SELECT status, COUNT(*) FROM campaigns GROUP BY status');
  const raised = await db.query('SELECT SUM(raised_amount) as total FROM campaigns');
  const contributions = await db.query('SELECT COUNT(*) FROM contributions');

  res.json({
    total_users: parseInt(users.rows[0].count),
    campaign_status: campaigns.rows,
    total_raised: parseFloat(raised.rows[0]?.total || 0),
    total_contributions: parseInt(contributions.rows[0].count),
    platform_fees_collected: 0
  });
});

// GET /campaigns
router.get('/campaigns', async (req, res) => {
  const { rows } = await db.query(`
    SELECT c.*, u.name as creator_name, u.email as creator_email 
    FROM campaigns c 
    JOIN users u ON c.creator_id = u.id
    ORDER BY c.created_at DESC
  `);
  res.json(rows);
});

// PATCH /campaigns/:id/status
router.patch('/campaigns/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['active', 'funded', 'closed', 'withdrawn', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const { rows } = await db.query(
    'UPDATE campaigns SET status = $1 WHERE id = $2 RETURNING *',
    [status, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  res.json(rows[0]);
});

// GET /users
router.get('/users', async (req, res) => {
  const { rows } = await db.query(`
    SELECT u.id, u.name, u.email, u.wallet_public_key, u.role, u.created_at,
           (SELECT COUNT(*) FROM campaigns WHERE creator_id = u.id) as campaign_count,
           (SELECT COUNT(*) FROM contributions WHERE sender_public_key = u.wallet_public_key) as contribution_count
    FROM users u
    ORDER BY u.created_at DESC
  `);
  res.json(rows);
});

module.exports = router;
