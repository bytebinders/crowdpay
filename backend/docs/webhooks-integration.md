# Webhook integration for external systems

CrowdPay can `POST` JSON payloads to your HTTPS URL when lifecycle events occur. Configure endpoints and signing secrets under **Developer** in the app, or via `POST /api/webhooks` (JWT or API key with `developer` scope).

## Supported events

| Event | When it fires |
|-------|----------------|
| `campaign.funded` | A campaign’s `raised_amount` reaches `target_amount` (detected when a contribution is indexed). |
| `contribution.received` | A new contribution row is created from the ledger monitor. |
| `milestone.approved` | A milestone is approved by the platform operator (`POST /api/milestones/:id/approve`). |
| `withdrawal.completed` | A withdrawal is fully signed and submitted to Stellar (`status` becomes `submitted`). |

Deliveries are attempted immediately and, on failure, retried **up to 5 times** with exponential backoff (1s, 2s, 4s, … capped at 30s). A background poller also picks up due retries every 5 seconds.

## HTTP request

- **Method:** `POST`
- **Body:** UTF-8 JSON (the `payload` object documented per event).
- **Headers:**
  - `Content-Type: application/json`
  - `X-CrowdPay-Event`: event name (e.g. `contribution.received`)
  - `X-CrowdPay-Delivery-Id`: unique delivery UUID (for idempotency on your side)
  - `X-CrowdPay-Signature`: `sha256=<hex>` where `<hex>` is **HMAC-SHA256** of the **raw request body bytes** using your endpoint’s **webhook secret** (shown once when the endpoint is created).

## Verifying the signature (Node.js)

```javascript
const crypto = require('crypto');

function verifyCrowdPayWebhook(rawBodyBuffer, signatureHeader, secret) {
  const match = /^sha256=(.+)$/.exec(signatureHeader || '');
  if (!match) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBodyBuffer).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(match[1], 'hex'), Buffer.from(expected, 'hex'));
}
```

Use the **raw** body string (before JSON parsing) so the signature matches what CrowdPay signed.

## API keys (server-to-server)

Create keys with `POST /api/api-keys`. Send `Authorization: Bearer cp_live_<secret>` on CrowdPay API requests.

**Scopes:**

- `read` — all `GET`/`HEAD` authenticated routes (and public routes stay public).
- `write` — create/update resources except withdrawal **mutations** and developer routes.
- `withdrawals` — withdrawal actions (`POST` under `/api/withdrawals` except pure reads).
- `developer` — manage API keys and webhooks (`/api/api-keys`, `/api/webhooks`).
- `full` — equivalent to all of the above.

Set `API_KEY_PEPPER` in production (falls back to `JWT_SECRET` only for local dev).
