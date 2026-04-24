-- Seed data for Users, Campaigns, and Contributions

-- Insert mock users
INSERT INTO users (id, email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
VALUES 
  ('00000000-0000-0000-0000-000000000001', 'alice@example.com', 'hashedpassword1', 'Alice Smith', 'GAlicePublicKey1234567890123456789012345678901234567890', 'encryptedSecret1'),
  ('00000000-0000-0000-0000-000000000002', 'bob@example.com', 'hashedpassword2', 'Bob Jones', 'GBobPublicKey123456789012345678901234567890123456789012', 'encryptedSecret2')
ON CONFLICT (email) DO NOTHING;

-- Insert mock campaigns
INSERT INTO campaigns (id, creator_id, title, description, target_amount, raised_amount, asset_type, wallet_public_key, status, deadline)
VALUES
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000001', 'Alice Tech Startup', 'Help me build a tech startup', 5000.00, 1500.00, 'USDC', 'GCampaignAlicePub12345678901234567890123456789012345678', 'active', '2026-12-31'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000002', 'Bob Community Garden', 'A community garden for the neighborhood', 1000.00, 1000.00, 'XLM', 'GCampaignBobPub1234567890123456789012345678901234567890', 'funded', '2026-06-01')
ON CONFLICT (id) DO NOTHING;

-- Insert mock contributions
INSERT INTO contributions (id, campaign_id, sender_public_key, amount, asset, payment_type, tx_hash)
VALUES
  ('33333333-3333-3333-3333-333333333331', '11111111-1111-1111-1111-111111111111', 'GSenderOnePub123456789012345678901234567890123456789012', 1000.00, 'USDC', 'payment', 'TxHash1000000000000000000000000000000000000000000000001'),
  ('33333333-3333-3333-3333-333333333332', '11111111-1111-1111-1111-111111111111', 'GSenderTwoPub123456789012345678901234567890123456789012', 500.00, 'USDC', 'payment', 'TxHash1000000000000000000000000000000000000000000000002'),
  ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'GSenderThreePub12345678901234567890123456789012345678901', 1000.00, 'XLM', 'payment', 'TxHash1000000000000000000000000000000000000000000000003')
ON CONFLICT (id) DO NOTHING;
