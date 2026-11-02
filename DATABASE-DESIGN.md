# AYUDA CEBU database design

This document describes the database that the current AYUDA CEBU server uses and a target design for evolving it safely. It is grounded in the live schema in [server/database.cjs](server/database.cjs) and behavior in [server/app.cjs](server/app.cjs). The running system uses SQLite; this document does not claim that recommended future constraints or tables are already implemented.

## Scope and design goals

AYUDA coordinates household assistance requests, barangay review, donor pledges and general donations, private conversations, notifications, account approval, authentication, and DSWS reporting.

The design aims to:

- Keep a household request as an individual, auditable case; donor browse groups are derived summaries, never merged requests.
- Make ownership and barangay scoping explicit and enforceable.
- Preserve lifecycle history and actor identity without relying on mutable display names.
- Avoid storing secrets in clear text and avoid exposing sensitive location and contact data in reports.
- Keep operational and authentication records distinct from relief transactions.
- Support reliable concurrent updates and indexed dashboard/report queries.

## Current implementation at a glance

The current SQLite database has ten tables: `users`, `sessions`, `password_resets`, `rate_limits`, `requests`, `donations`, `request_messages`, `donation_messages`, and `notifications` (nine tables; the count is nine). Account role, account status, and role-specific profile attributes are embedded in `users.profile` JSON. Request photos are JSON data URLs in `requests.photos`. Request and donation states are text values validated primarily in the server. The schema reference below distinguishes current behavior from proposed improvements.

## Entity relationship diagram

```mermaid
erDiagram
    USERS ||--o{ SESSIONS : owns
    USERS ||--o| HOUSEHOLD_PROFILES : has
    USERS ||--o| DONOR_PROFILES : has
    USERS ||--o| OFFICIAL_ASSIGNMENTS : receives
    BARANGAYS ||--o{ OFFICIAL_ASSIGNMENTS : scopes
    USERS ||--o{ REQUESTS : submits
    BARANGAYS ||--o{ REQUESTS : serves
    REQUESTS ||--o{ REQUEST_PHOTOS : includes
    REQUESTS ||--o{ REQUEST_EVENTS : records
    USERS o|--o{ REQUEST_EVENTS : acts
    REQUESTS ||--o{ DONATIONS : may_receive
    USERS ||--o{ DONATIONS : contributes
    DONATIONS ||--o{ DONATION_EVENTS : records
    USERS o|--o{ DONATION_EVENTS : acts
    REQUESTS ||--o{ REQUEST_MESSAGES : has
    DONATIONS ||--o{ DONATION_MESSAGES : has
    USERS ||--o{ REQUEST_MESSAGES : sends
    USERS ||--o{ DONATION_MESSAGES : sends
    USERS ||--o{ NOTIFICATIONS : receives
    USERS ||--o{ ACCOUNT_EVENTS : records
    USERS ||--o{ PASSWORD_RESETS : requests

    USERS {
        TEXT id PK
        TEXT email UK
        TEXT password_hash
        TEXT profile "current JSON profile"
    }
    BARANGAYS {
        TEXT id PK "target"
        TEXT name UK "target"
    }
    REQUESTS {
        TEXT id PK
        TEXT household_id FK
        TEXT barangay "current name; target FK"
        TEXT status
        TEXT created_at
    }
    DONATIONS {
        TEXT id PK
        TEXT donor_id FK
        TEXT request_id FK_nullable
        TEXT status
    }
```

The diagram includes target entities such as `BARANGAYS`, `REQUEST_EVENTS`, and `REQUEST_PHOTOS`; these do not exist in the current schema. Today, `password_resets` is keyed by email, and the event tables described below are represented by current-row status fields and timestamps.

## Current schema reference

All timestamps in transaction tables are ISO 8601 text as produced by the server. Authentication expiry timestamps are Unix milliseconds. IDs are generated application-side with prefixes such as `ACC-`, `REQ-`, and `DON-`.

### Identity and access

#### `users`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | TEXT PK | Account ID. |
| `email` | TEXT NOT NULL UNIQUE COLLATE NOCASE | Case-insensitive login. |
| `password_hash` | TEXT NOT NULL | Password hash only. |
| `profile` | TEXT NOT NULL | JSON with name, role, status, barangay/contact where applicable, and created time. |

Roles: `HOUSEHOLD`, `BARANGAY_OFFICIAL`, `DONOR`, `DSWS_ADMIN`. Household and official account approval is stored in this JSON profile. DSWS admins approve official accounts; donors are approved at registration in the current flow.

#### `sessions`

| Column | Type | Meaning |
| --- | --- | --- |
| `token_hash` | TEXT PK | Hash of the secret cookie token. |
| `user_id` | TEXT FK → users | Session owner; cascades on user deletion. |
| `expires_at` | INTEGER | Expiry in Unix milliseconds. |

Index: `sessions_user(user_id)`. Session rows are removed when expired and when the account's password is reset or changed, subject to preserving the current session on a normal password change.

#### `password_resets`

One active challenge per normalized email, keyed by `email` (NOCASE). Stores `challenge_id`, `code_hash`, `expires_at`, failed `attempts`, and `created_at`. It stores a hash, not the emailed recovery code.

#### `rate_limits`

Temporary hashed bucket key, request `count`, and `expires_at`. Used for operational throttling rather than domain history.

### Relief operations

#### `requests`

One row per submitted household case.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | TEXT PK | Public request reference. |
| `household_id` | TEXT FK → users | Submitting household. |
| `household` | TEXT | Submitter name snapshot. |
| `barangay` | TEXT | Barangay name snapshot and current scope value. |
| `contact` | TEXT nullable | Contact snapshot. |
| `category`, `disaster`, `urgency`, `description` | TEXT | Assistance classification and case details. |
| `status` | TEXT | Current lifecycle state. |
| `location`, `gps` | TEXT | Address/landmark and coordinate representation. |
| `gps_accuracy` | REAL nullable | Device-reported accuracy, metres. |
| `gps_captured_at` | TEXT nullable | Capture time. |
| `photos` | TEXT JSON array | Up to three bounded image data URLs in current code. |
| `rejection_reason` | TEXT nullable | Review explanation. |
| `approved_at`, `approved_by`, `reviewed_by` | TEXT nullable | Approval/review data; names are snapshots, no actor FK. |
| `pledged_at`, `pledged_by` | TEXT nullable | First active pledge summary fields. |
| `fulfilled_at`, `fulfilled_by_id` | TEXT nullable | Fulfilment time and official ID (not currently declared as an FK). |
| `created_at`, `updated_at` | TEXT | Submission and last update time. |

Current states: `Under Verification`, `Approved`, `Pledged`, `Fulfilled`, `Rejected`. The application enforces allowed transitions. The DB does not currently constrain state values. An escalation is computed when a request remains under verification for at least 72 hours.

Indexes: `requests_household(household_id)`, `requests_barangay(barangay)`, `requests_status(status)`.

#### `donations`

A row represents either a general donation (`request_id IS NULL`) or a pledge to one request.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | TEXT PK | Donation/pledge reference. |
| `donor_id` | TEXT FK → users | Donor account. |
| `request_id` | TEXT nullable FK → requests | Target request; deletion of request cascades to pledge. |
| `donor` | TEXT | Donor name snapshot. |
| `barangay` | TEXT | Receiving/reviewing barangay name. |
| `type`, `amount` | TEXT | Contribution category and free-text quantity/description. |
| `status` | TEXT | Lifecycle state. |
| `created_at`, `expires_at` | TEXT | Submission and reservation expiry. |
| `reviewed_by`, `reviewed_by_id` | TEXT nullable | Reviewer snapshot and account ID (no declared FK). |
| `approved_at`, `rejected_at`, `rejection_reason` | TEXT nullable | General donation review outcome. |
| `completed_at`, `cancelled_at`, `expired_at` | TEXT nullable | Pledge outcome times. |

General donation states: `Pending Approval`, `Approved`, `Rejected`. Pledge states: `Reserved`, `Completed`, `Cancelled`, `Expired`. Pledges reserve for 48 hours. A donor may not have more than one active reservation for the same request; current application logic checks this. Indexes: `donations_donor(donor_id)`, `donations_request(request_id)`, `donations_barangay_status(barangay, status)`.

### Collaboration and inbox

#### `request_messages` and `donation_messages`

Both tables store `id`, parent ID, `sender_id` FK to users, sender name/role snapshots, `message`, and `created_at`. A message is limited by the API to 2,000 characters. Thread indexes are `(request_id, created_at, id)` and `(donation_id, created_at, id)`. Request chat opens after request approval and remains available through fulfilment. Pledge/general-donation chat is private to its donor and approved officials in the donation's barangay. Current actor access rules are in the application.

#### `notifications`

Stores recipient `user_id` FK, event `type`, `title`, `body`, polymorphic `target_type` and `target_id`, `created_at`, and nullable `read_at`. The target is intentionally not an SQL FK today because it can refer to more than one parent table. Index: `notifications_user_unread(user_id, read_at, created_at)`. API access is scoped to the authenticated recipient.

## Main workflows and transactional boundaries

### Request review and fulfilment

1. An approved household creates a request in its registered barangay. The server snapshots name/contact and starts it at `Under Verification`.
2. An assigned approved barangay official approves or rejects it. A rejection cancels active reservations for the request.
3. An approved request may receive one or more donor reservations. The first active reservation moves it to `Pledged`; expiry can return it to `Approved` if no active reservation remains.
4. An official fulfils a pledged request. Active reservations become `Completed`, and the request becomes `Fulfilled`.
5. Status changes and their notifications are written together where implemented. These operations should remain atomic.

### General donations

Donors submit a contribution to a barangay, which starts at `Pending Approval`. An official assigned there approves or rejects it. This lifecycle is separate from request-specific pledge lifecycle despite sharing the current `donations` table.

### Conversations and notifications

Request chat belongs to a request. Donation chat belongs to an individual donation/pledge. Messages and recipient notifications should commit atomically so the inbox cannot claim an event whose message failed to save.

### DSWS reporting

Reports aggregate status counts, fulfilment rate, escalation counts, active reservations, category needs, and barangay summaries. Reporting should query de-identified aggregates and must not include contact details, precise household coordinates, photos, or message contents.

## Recommended target design

The current schema is functional for a single-server prototype. For a stronger production design, make these changes in versioned migrations. They are recommendations, not present-day guarantees.

### 1. Normalize identity and geography

- Keep `users` for login identity and common account fields. Move role, approval status, name, contact, and barangay to typed columns or role profile tables.
- Create `barangays(id, name, city, is_active)`; use stable IDs as foreign keys from official assignments and requests. Preserve a name snapshot only when historical display needs it.
- Add `official_assignments(user_id, barangay_id, valid_from, valid_to, assigned_by)` to represent current and historical jurisdiction. Enforce one active assignment per official if the product requires exactly one.
- Add `household_profiles(user_id, barangay_id, contact, ...)` and `donor_profiles(user_id, organization_name, contact, ...)` for role-specific data.

This removes JSON extraction from authorization queries and reduces spelling drift in barangay names.

### 2. Separate request photos and location

- Replace base64 image blobs in JSON with `request_photos(id, request_id, storage_key, content_type, size_bytes, sha256, created_at)`. Store actual media in private object storage or a controlled file store; use an opaque key in SQL.
- Store latitude and longitude as numeric columns (or a spatial type in a future spatial DB), plus accuracy, capture time, and source (`DEVICE`, `MANUAL`, `GEOCODED`). Keep precise coordinates private and expose only to authorized staff.
- Apply retention limits and access logging to precise location, contact, and photos.

### 3. Record lifecycle history explicitly

Add append-only `request_events` and `donation_events` rows with entity ID, prior state, new state, actor ID, event type, reason, and timestamp. Do not make the event log the only source of current state; keep the current status on the entity for efficient reads. Write entity changes, history, and notifications in one transaction. Actor FKs should use `ON DELETE SET NULL` where legally appropriate, while preserving actor display snapshots.

### 4. Model contributions as inventory when needed

The current free-text `type` and `amount` cannot support dependable stock totals. If inventory, receipt, or distribution tracking becomes a requirement, introduce typed `contribution_items` and `distribution_records` with a unit, numeric quantity, and (where relevant) value/currency. Avoid interpreting free-text amounts as money.

### 5. Strengthen relational constraints

Use `CHECK` constraints for role/status/category values and nonnegative quantities. Add composite foreign keys or validated assignment joins so a barangay official cannot act outside their assigned barangay even if an application query is accidentally weakened. Keep authorization checks in the server as well; DB constraints are a second line of integrity.

### 6. Improve authentication records

Use a surrogate reset ID and `user_id` FK for password resets after account lookup, retaining normalized email only where needed for delivery/audit. Add creation/last-seen metadata for sessions and appropriate uniqueness/expiry indexes. Keep rate-limit buckets operational and ephemeral. Never persist raw session tokens or recovery codes.

### 7. Clarify deletion, retention, and audit policy

Avoid cascading deletion of fulfilled relief records or messages in a production system. Prefer account deactivation/anonymization and `ON DELETE RESTRICT`/nullable actor references for durable public-service records. Document retention periods for identity, recovery, location, photos, conversations, and audit events, then apply scheduled purging where appropriate. A legal/privacy review is needed before setting a real retention period.

## Suggested target table catalog

| Table | Purpose | Key relationships |
| --- | --- | --- |
| `users` | Authentication identity, normalized email, password hash, account state | Parent of role profiles and sessions |
| `household_profiles` | Household display/contact and barangay | `user_id → users`, `barangay_id → barangays` |
| `donor_profiles` | Donor details | `user_id → users` |
| `barangays` | Canonical jurisdiction directory | Parent of assignments and requests |
| `official_assignments` | Current and past official jurisdiction | `user_id → users`, `barangay_id → barangays` |
| `sessions` | Hashed-token sessions | `user_id → users` |
| `password_resets` | Hashed, expiring recovery challenges | `user_id → users` |
| `requests` | Household case and current state | Household, barangay, optional fulfiller |
| `request_photos` | Private media metadata | `request_id → requests` |
| `request_events` | Append-only review/status history | Request and nullable actor |
| `donations` | General donations and request-specific pledges | Donor, optional request, barangay |
| `donation_events` | Append-only review/reservation history | Donation and nullable actor |
| `request_messages` | Household/barangay conversation | Request and sender |
| `donation_messages` | Donor/barangay conversation | Donation and sender |
| `notifications` | Per-user inbox entries | Recipient, typed parent reference or validated target |
| `rate_limits` | Expiring operational throttle buckets | No domain FK |

## Query and index plan

Current indexes cover basic ownership, status, and thread access. Recommended additions (after measuring real query plans) include:

- `requests(status, barangay, created_at DESC)` for official queues and citywide filters.
- `requests(household_id, created_at DESC)` for household history.
- `donations(barangay, status, created_at DESC)` for official review queues.
- A partial unique index on `donations(donor_id, request_id)` for active reservations, if the exact status/expiry semantics are designed so expired rows are first transitioned atomically.
- `notifications(user_id, created_at DESC)` for inbox paging; retain the unread index for unread counts.
- Thread indexes already sort by parent, creation time, and ID; use keyset pagination for large threads.
- `request_events(request_id, created_at, id)` and `donation_events(donation_id, created_at, id)` for audit timelines.

Validate additions with `EXPLAIN QUERY PLAN`; avoid adding indexes without evidence because each index increases write and storage cost.

## Integrity and operational notes

- SQLite is opened with foreign keys enabled, WAL journaling, and a 5-second busy timeout.
- The default file is `./data/ayuda.sqlite`; `DATABASE_PATH` overrides it.
- The current setup creates tables/indexes with `IF NOT EXISTS` and additively adds three request columns. It does not have a formal schema version table or general migration runner.
- Before changing table shape, back up the database and use ordered, idempotent migrations recorded in a `schema_migrations` table. Do not rely on `CREATE TABLE IF NOT EXISTS` alone to evolve a table.
- Test migrations against a copy of a real database and an empty database. Preserve the existing `DATABASE_PATH` data.
- Use transactions for multi-row lifecycle changes, notifications, and audit event inserts. Add an idempotency key to externally retried create operations if duplicate submissions become a real issue.
- Backups must include a consistent SQLite snapshot (use the SQLite backup API or checkpoint-aware process), and restore procedures should be rehearsed.
- SQLite fits the current single-process prototype. If deployed across multiple hosts or sustained concurrent writers become material, move to a client/server DB such as PostgreSQL using the same normalized relational model.

## Known limits in the current database

- Account fields are JSON and require application checks and `json_extract` queries.
- Status fields are free text without DB constraints or durable transition events.
- Barangay names are duplicated text rather than canonical foreign keys.
- Request photos are large base64 strings inside the database.
- Notification targets are polymorphic, so SQL cannot ensure their target exists.
- Some reviewer fields are name snapshots; not all actor references are foreign keys.
- Deleting a user or request cascades into historical records. This is convenient for test data but should be reconsidered for public-service retention.
- Current chat access and role/barangay authorization are enforced by server handlers, not row-level security.

## References in this repository

- [Database creation and additive upgrades](server/database.cjs)
- [Authorization, validation, and workflows](server/app.cjs)
- [Product scope and operational notes](README.md)

