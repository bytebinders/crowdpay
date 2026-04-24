# Data Model

This document outlines the core foundational data models for CrowdPay: Users, Campaigns, and Contributions.

## Entities

- **Users**: Represents the platform users, including campaign creators.
- **Campaigns**: Represents funding campaigns created by users. Each campaign is tied to a specific target amount and asset on the Stellar network.
- **Contributions**: Represents individual payments made to a campaign. It handles path payment conversion details when applicable.

## Entity-Relationship Diagram

```mermaid
erDiagram
    USERS ||--o{ CAMPAIGNS : creates
    CAMPAIGNS ||--o{ CONTRIBUTIONS : receives

    USERS {
        UUID id PK
        TEXT email "UNIQUE"
        TEXT password_hash
        TEXT name
        TEXT wallet_public_key "UNIQUE"
        TEXT wallet_secret_encrypted
        TIMESTAMPTZ created_at
    }

    CAMPAIGNS {
        UUID id PK
        UUID creator_id FK
        TEXT title
        TEXT description
        NUMERIC target_amount
        NUMERIC raised_amount
        TEXT asset_type "XLM | USDC"
        TEXT wallet_public_key "UNIQUE"
        TEXT status "active | funded | closed | withdrawn"
        DATE deadline
        TIMESTAMPTZ created_at
    }

    CONTRIBUTIONS {
        UUID id PK
        UUID campaign_id FK
        TEXT sender_public_key
        NUMERIC amount
        TEXT asset
        TEXT payment_type "payment | path_payment_strict_receive"
        NUMERIC source_amount
        TEXT source_asset
        NUMERIC conversion_rate
        JSONB path
        TEXT tx_hash "UNIQUE"
        TIMESTAMPTZ created_at
    }
```
