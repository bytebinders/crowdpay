ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_status_check;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_status_check
    CHECK (status IN ('active', 'funded', 'closed', 'withdrawn', 'failed'));

ALTER TABLE withdrawal_requests
  ADD COLUMN contribution_id UUID REFERENCES contributions(id);

ALTER TABLE withdrawal_requests
  ADD COLUMN is_refund BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS withdrawal_requests_contribution_id_idx
  ON withdrawal_requests (contribution_id);
