const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Keypair } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const logger = require('../config/logger');
const { ensureCustodialAccountFundedAndTrusted } = require('../services/stellarService');
const { sendEmail } = require('../services/emailService');
const { requireAuth } = require('../middleware/auth');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Register — creates user + custodial Stellar keypair
router.post('/register', authLimiter, async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password and name are required' });
  }
  const allowedRoles = new Set(['contributor', 'creator']);
  const userRole = role || 'contributor';
  if (!allowedRoles.has(userRole)) {
    return res.status(400).json({ error: 'role must be contributor or creator' });
  }

  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const keypair = Keypair.random();

  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted, role)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, name, wallet_public_key, role`,
    [email, passwordHash, name, keypair.publicKey(), keypair.secret(), userRole]
    // TODO: encrypt secret with KMS before storing in production
  );

  const token = jwt.sign({ userId: rows[0].id, role: rows[0].role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });

  const publicKey = keypair.publicKey();
  const secret = keypair.secret();
  const requestId = req.id;
  setImmediate(() => {
    ensureCustodialAccountFundedAndTrusted({ publicKey, secret }).catch((err) => {
      logger.error('Background Stellar funding/trustlines failed', {
        request_id: requestId,
        error: err.message,
      });
    });

    sendEmail({
      to: email,
      subject: 'Welcome to CrowdPay!',
      text: `Welcome ${name}! Your custodial wallet public key is ${publicKey}.`
    });
  });

  res.status(201).json({ token, user: rows[0] });
});

// Login
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);

  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ userId: rows[0].id, role: rows[0].role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });

  res.json({
    token,
    user: {
      id: rows[0].id,
      email: rows[0].email,
      name: rows[0].name,
      wallet_public_key: rows[0].wallet_public_key,
      role: rows[0].role,
    },
  });
});

// Forgot password
router.post('/forgot-password', authLimiter, async (req, res) => {
  // Real implementation would send a reset link
  res.json({ message: 'If that email exists, a password reset link has been sent.' });
});

router.get('/me/campaigns', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.status, c.asset_type, c.target_amount, c.raised_amount,
            c.deadline, c.created_at,
            COALESCE(stats.contributor_count, 0) AS contributor_count
     FROM campaigns c
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT sender_public_key)::int AS contributor_count
       FROM contributions ctr
       WHERE ctr.campaign_id = c.id
     ) stats ON TRUE
     WHERE c.creator_id = $1
     ORDER BY c.created_at DESC`,
    [req.user.userId]
  );
  res.json(rows);
});

router.get('/me/stats', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT
      COUNT(*)::int AS total_campaigns,
      COALESCE(SUM(raised_amount), 0)::numeric AS total_raised,
      COUNT(*) FILTER (WHERE status = 'active')::int AS active_campaigns,
      COUNT(*) FILTER (WHERE status = 'funded')::int AS funded_campaigns,
      COUNT(*) FILTER (WHERE status IN ('closed', 'withdrawn', 'failed'))::int AS closed_campaigns
     FROM campaigns
     WHERE creator_id = $1`,
    [req.user.userId]
  );
  res.json(rows[0]);
});

router.get('/me/contributions', requireAuth, async (req, res) => {
  const { rows: userRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (!userRows.length) return res.status(404).json({ error: 'User not found' });

  const senderPublicKey = userRows[0].wallet_public_key;
  const { rows } = await db.query(
    `SELECT ctr.id, ctr.amount, ctr.asset, ctr.tx_hash, ctr.created_at,
            c.id AS campaign_id, c.title AS campaign_title, c.status AS campaign_status,
            c.target_amount, c.raised_amount
     FROM contributions ctr
     JOIN campaigns c ON c.id = ctr.campaign_id
     WHERE ctr.sender_public_key = $1
     ORDER BY ctr.created_at DESC`,
    [senderPublicKey]
  );
  res.json(rows);
});

module.exports = router;
