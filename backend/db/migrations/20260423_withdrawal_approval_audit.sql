BEGIN;

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS denial_reason TEXT;

ALTER TABLE withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;
ALTER TABLE withdrawal_requests ADD CONSTRAINT withdrawal_requests_status_check
  CHECK (status IN ('pending', 'submitted', 'failed', 'denied'));

CREATE TABLE IF NOT EXISTS withdrawal_approval_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_request_id   UUID NOT NULL REFERENCES withdrawal_requests(id) ON DELETE CASCADE,
  actor_user_id           UUID REFERENCES users(id),
  action                  TEXT NOT NULL CHECK (action IN (
                            'requested',
                            'creator_signed',
                            'platform_signed',
                            'creator_cancelled',
                            'platform_rejected',
                            'submit_failed'
                          )),
  note                    TEXT,
  metadata                JSONB,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS withdrawal_approval_events_wr_idx
  ON withdrawal_approval_events (withdrawal_request_id);
CREATE INDEX IF NOT EXISTS withdrawal_approval_events_created_idx
  ON withdrawal_approval_events (created_at DESC);

COMMIT;
