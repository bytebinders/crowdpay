const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const pool = require('./config/database');
const fs = require('fs');
const path = require('path');

describe('Database Models & Constraints', async () => {
  let client;

  before(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    
    // Create the schema within the transaction to ensure a clean slate 
    // and that the test doesn't fail if the db is completely empty
    const schemaSql = fs.readFileSync(path.join(__dirname, '../db/migrations/20260401_users_campaigns_contributions.sql'), 'utf-8');
    
    // We drop if exists just to be safe, but since it's a transaction that rolls back it shouldn't be needed 
    // unless the DB already has these tables. To avoid conflicts with existing tables, we can test in a temp schema.
    await client.query('CREATE SCHEMA IF NOT EXISTS test_models_schema');
    await client.query('SET search_path TO test_models_schema');
    
    // Run the migration script
    await client.query(schemaSql);
  });

  after(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('should allow creating a valid user', async () => {
    const res = await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('test@example.com', 'hash', 'Test User', 'G_PUB_1', 'enc_sec')
      RETURNING id;
    `);
    assert.strictEqual(res.rows.length, 1);
  });

  it('should enforce unique email for users', async () => {
    await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('duplicate@example.com', 'hash', 'Test User 1', 'G_PUB_2', 'enc_sec')
    `);
    
    await assert.rejects(
      client.query(`
        INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
        VALUES ('duplicate@example.com', 'hash', 'Test User 2', 'G_PUB_3', 'enc_sec')
      `),
      (err) => err.code === '23505' // unique_violation
    );
  });

  it('should enforce valid asset_type on campaigns', async () => {
    const userRes = await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('creator@example.com', 'hash', 'Creator', 'G_PUB_4', 'enc_sec')
      RETURNING id;
    `);
    const creatorId = userRes.rows[0].id;

    await assert.rejects(
      client.query(`
        INSERT INTO campaigns (creator_id, title, target_amount, asset_type, wallet_public_key, status)
        VALUES ($1, 'Invalid Asset Campaign', 1000, 'BTC', 'G_CAMPAIGN_PUB_1', 'active')
      `, [creatorId]),
      (err) => err.code === '23514' // check_violation
    );
  });

  it('should allow creating a valid campaign', async () => {
    const userRes = await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('creator2@example.com', 'hash', 'Creator 2', 'G_PUB_5', 'enc_sec')
      RETURNING id;
    `);
    const creatorId = userRes.rows[0].id;

    const res = await client.query(`
      INSERT INTO campaigns (creator_id, title, target_amount, asset_type, wallet_public_key, status)
      VALUES ($1, 'Valid Campaign', 1000, 'USDC', 'G_CAMPAIGN_PUB_2', 'active')
      RETURNING id;
    `, [creatorId]);
    assert.strictEqual(res.rows.length, 1);
  });

  it('should enforce valid status on campaigns', async () => {
    const userRes = await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('creator3@example.com', 'hash', 'Creator 3', 'G_PUB_6', 'enc_sec')
      RETURNING id;
    `);
    const creatorId = userRes.rows[0].id;

    await assert.rejects(
      client.query(`
        INSERT INTO campaigns (creator_id, title, target_amount, asset_type, wallet_public_key, status)
        VALUES ($1, 'Invalid Status Campaign', 1000, 'USDC', 'G_CAMPAIGN_PUB_3', 'unknown_status')
      `, [creatorId]),
      (err) => err.code === '23514' // check_violation
    );
  });
  
  it('should enforce payment_type constraint on contributions', async () => {
    const userRes = await client.query(`
      INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
      VALUES ('creator4@example.com', 'hash', 'Creator 4', 'G_PUB_7', 'enc_sec')
      RETURNING id;
    `);
    const creatorId = userRes.rows[0].id;

    const campRes = await client.query(`
      INSERT INTO campaigns (creator_id, title, target_amount, asset_type, wallet_public_key, status)
      VALUES ($1, 'Campaign for Contribs', 1000, 'USDC', 'G_CAMPAIGN_PUB_4', 'active')
      RETURNING id;
    `, [creatorId]);
    const campaignId = campRes.rows[0].id;

    await assert.rejects(
      client.query(`
        INSERT INTO contributions (campaign_id, sender_public_key, amount, asset, payment_type, tx_hash)
        VALUES ($1, 'G_SENDER_1', 100, 'USDC', 'invalid_payment_type', 'TX_1')
      `, [campaignId]),
      (err) => err.code === '23514' // check_violation
    );
  });

});
