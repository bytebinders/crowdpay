# CrowdPay Backend API

## Contribution conversion model

- Campaigns define a default settlement asset via `campaigns.asset_type` (`USDC` or `XLM`).
- Contributors can pay using `send_asset`.
- If `send_asset !== campaign.asset_type`, the backend uses Stellar `pathPaymentStrictReceive` so the campaign receives the exact requested `amount` in its settlement asset.
- Conversion path discovery uses Stellar Horizon `strictReceivePaths` and applies a `5%` slippage buffer when computing `sendMax`.
- Additional credit assets can be enabled through `STELLAR_EXTRA_ASSETS` in `.env` as a JSON object (`{"CODE":"ISSUER"}`).

## Endpoints

### `GET /api/contributions/quote`

Get a DEX quote before submitting a conversion contribution.

Query params:

- `send_asset` (required): `XLM` or `USDC`
- `dest_asset` (required): `XLM` or `USDC`
- `dest_amount` (required): amount the campaign should receive

Success response (`200`):

```json
{
  "send_asset": "XLM",
  "dest_asset": "USDC",
  "dest_amount": "9",
  "quoted_source_amount": "10.0000000",
  "max_send_amount": "10.5000000",
  "estimated_rate": "0.900000000000000",
  "path": ["AQUA"],
  "path_count": 3
}
```

Errors:

- `400` missing/invalid params
- `404` no path found on Stellar DEX

### `POST /api/contributions`

Submit a contribution (direct payment or path payment).

Body:

- `campaign_id` (required)
- `amount` (required): amount the campaign must receive in campaign asset
- `send_asset` (required): `XLM` or `USDC`

Success response (`202`):

```json
{
  "tx_hash": "c8d6...",
  "message": "Transaction submitted",
  "conversion_quote": {
    "send_asset": "XLM",
    "campaign_asset": "USDC",
    "campaign_amount": "4.5000000",
    "quoted_source_amount": "5.0000000",
    "max_send_amount": "5.2500000",
    "path": []
  }
}
```

`conversion_quote` is `null` for direct same-asset contributions.

Errors:

- `400` missing fields / unsupported assets
- `404` campaign not found or not active
- `422` no conversion path found for requested asset pair

### `GET /api/contributions/campaign/:campaignId`

Fetch indexed contributions with conversion audit fields.

Success response (`200`):

```json
[
  {
    "id": "0f3f...",
    "sender_public_key": "G...",
    "amount": "4.5000000",
    "asset": "USDC",
    "payment_type": "path_payment_strict_receive",
    "source_amount": "4.9973210",
    "source_asset": "XLM",
    "conversion_rate": "0.900482150000000",
    "path": ["AQUA"],
    "tx_hash": "c8d6...",
    "created_at": "2026-04-23T08:13:34.392Z"
  }
]
```

### `POST /api/withdrawals/request`

Create a pending withdrawal request (creator only). The backend verifies campaign wallet multisig thresholds/signers before storing the XDR.

Body:

- `campaign_id` (required)
- `destination_key` (required)
- `amount` (required)

Returns `201` with withdrawal request (`creator_signed=false`, `platform_signed=false`, `status=pending`).

### `POST /api/withdrawals/:id/approve/creator`

Creator approval step. Signs withdrawal XDR using creator custodial key and marks `creator_signed=true`.

Errors:

- `403` caller is not campaign creator
- `409` request no longer pending or already creator-approved

### `POST /api/withdrawals/:id/approve/platform`

Platform approval/finalization step. Signs with platform key, validates dual-signature presence, and submits to Stellar.

Errors:

- `409` creator approval missing
- `422` insufficient signatures in XDR

Success:

- marks request as `status=submitted`
- stores Stellar `tx_hash`

### `GET /api/withdrawals/campaign/:campaignId`

List withdrawal requests and signature statuses for a campaign.

## Auditability and traceability

- Every indexed contribution stores:
  - `payment_type` (`payment` vs `path_payment_strict_receive`)
  - destination settlement `amount` and `asset`
  - conversion source `source_amount` and `source_asset` (when applicable)
  - `conversion_rate` (`destination_amount / source_amount`)
  - conversion `path` as JSON
  - immutable Stellar `tx_hash`
- This enables independent reconciliation against Horizon payment records by `tx_hash`.

## Test coverage

`node --test src/**/*.test.js` includes route coverage for:

- quote endpoint success
- quote endpoint no-path behavior
- direct payment path for `XLM -> XLM`
- direct payment path for `USDC -> USDC`
- conversion path payment for `XLM -> USDC`
- conversion path payment for `USDC -> XLM`
- withdrawal request creation with multisig validation
- withdrawal creator/platform approval flow
- withdrawal denial paths (missing creator approval, insufficient signatures)
