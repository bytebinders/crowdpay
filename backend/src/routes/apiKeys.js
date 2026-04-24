const crypto = require('crypto');
const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { hashApiKey } = require('../middleware/auth');

const ALLOWED_SCOPES = new Set(['read', 'write', 'withdrawals', 'developer', 'full']);

function normalizeScopes(input) {
  if (!input || !Array.isArray(input) || !input.length) {
    return ['read', 'write', 'withdrawals'];
  }
  const out = [...new Set(input.filter((s) => typeof s === 'string' && ALLOWED_SCOPES.has(s)))];
  return out.length ? out : ['read', 'write', 'withdrawals'];
}

router.get('/', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, label, scopes, key_prefix, last_used_at, created_at, revoked_at
     FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.userId]
  );
  res.json(rows);
});

router.post('/', requireAuth, async (req, res) => {
  const label = (req.body && req.body.label) || 'API key';
  const scopes = normalizeScopes(req.body && req.body.scopes);
  const rawKey = `cp_live_${crypto.randomBytes(24).toString('hex')}`;
  const keyPrefix = `${rawKey.slice(0, 14)}…`;
  const keyHash = hashApiKey(rawKey);

  const { rows } = await db.query(
    `INSERT INTO api_keys (user_id, key_prefix, key_hash, label, scopes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, label, scopes, key_prefix, created_at`,
    [req.user.userId, keyPrefix, keyHash, label, scopes]
  );

  res.status(201).json({
    ...rows[0],
    api_key: rawKey,
    message: 'Store this key securely; it cannot be shown again.',
  });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `UPDATE api_keys SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [req.params.id, req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'API key not found' });
  res.json({ revoked: true, id: rows[0].id });
});

module.exports = router;
