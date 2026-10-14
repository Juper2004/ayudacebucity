# AYUDA CEBU Database Design

This document describes the current SQLite schema used by the AYUDA CEBU server. The schema is created and incrementally upgraded by [`server/database.cjs`](server/database.cjs); authorization and transaction behavior are implemented in [`server/app.cjs`](server/app.cjs).

## Entity Relationship Diagram

```mermaid
erDiagram
    USERS ||--o{ SESSIONS : authenticates
    USERS ||--o{ REQUESTS : submits
    USERS ||--o{ DONATIONS : contributes
    REQUESTS o|--o{ DONATIONS : may_receive
    DONATIONS ||--o{ DONATION_MESSAGES : has_thread
    USERS ||--o{ DONATION_MESSAGES : sends
    REQUESTS ||--o{ REQUEST_MESSAGES : has_thread
    USERS ||--o{ REQUEST_MESSAGES : sends
    USERS ||--o{ NOTIFICATIONS : receives

    USERS {
        TEXT id PK
        TEXT email UK
        TEXT password_hash
        TEXT profile_json
    }
    SESSIONS {
        TEXT token_hash PK
        TEXT user_id FK
        INTEGER expires_at
    }
    REQUESTS {
        TEXT id PK
        TEXT household_id FK
        TEXT barangay
        TEXT status
        TEXT created_at
    }
    DONATIONS {
        TEXT id PK
        TEXT donor_id FK
        TEXT request_id FK_nullable
        TEXT barangay
        TEXT status
        TEXT created_at
    }
    DONATION_MESSAGES {
        TEXT id PK
        TEXT donation_id FK
        TEXT sender_id FK
        TEXT message
        TEXT created_at
    }
    REQUEST_MESSAGES {
        TEXT id PK
        TEXT request_id FK
        TEXT sender_id FK
        TEXT message
        TEXT created_at
    }
    NOTIFICATIONS {
        TEXT id PK
        TEXT user_id FK
        TEXT target_type
        TEXT target_id
        TEXT read_at_nullable
    }
```

`PASSWORD_RESETS` and `RATE_LIMITS` are security/operational tables and have no entity relationship to the transaction tables.

## Tables

### `users`

Stores login identity and the user profile.

| Column | Definition | Notes |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | Account identifier. |
| `email` | `TEXT NOT NULL UNIQUE COLLATE NOCASE` | Case-insensitive unique login. |
| `password_hash` | `TEXT NOT NULL` | Password hash; never the raw password. |
| `profile` | `TEXT NOT NULL` | JSON profile containing role, status, name, and role-specific fields such as barangay/contact. |

Roles in the profile are `HOUSEHOLD`, `BARANGAY_OFFICIAL`, `DONOR`, and `DSWS_ADMIN`. Household and official accounts include a barangay; account status is stored in the profile JSON.

### `sessions`

Stores server-side sessions. The browser receives the secret session token in an HttpOnly cookie; SQLite stores only its hash.

| Column | Definition | Notes |
| --- | --- | --- |
| `token_hash` | `TEXT PRIMARY KEY` | Digest of the session token. |
| `user_id` | `TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Session owner. |
| `expires_at` | `INTEGER NOT NULL` | Unix timestamp in milliseconds. |

Index: `sessions_user(user_id)`.

### `password_resets`

Stores the currently active recovery challenge for an email address.

| Column | Definition | Notes |
| --- | --- | --- |
| `email` | `TEXT PRIMARY KEY COLLATE NOCASE` | Case-insensitive account lookup. |
| `challenge_id` | `TEXT NOT NULL` | Identifies the active challenge. |
| `code_hash` | `TEXT NOT NULL` | Hash of the recovery code, not the code itself. |
| `expires_at` | `INTEGER NOT NULL` | Unix timestamp in milliseconds. |
| `attempts` | `INTEGER NOT NULL DEFAULT 0` | Failed/used verification attempts. |
| `created_at` | `INTEGER NOT NULL` | Unix timestamp in milliseconds. |

### `rate_limits`

Stores temporary request-limit buckets. The key is a digest of the relevant IP, account, or operation identifier.

| Column | Definition | Notes |
| --- | --- | --- |
| `key` | `TEXT PRIMARY KEY` | Hashed bucket key. |
| `count` | `INTEGER NOT NULL` | Requests in the active window. |
| `expires_at` | `INTEGER NOT NULL` | Unix timestamp in milliseconds. |

### `requests`

Stores household relief requests and their review/fulfilment history.

| Column | Definition | Notes |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | Request reference, generated with a `REQ-` prefix. |
| `household_id` | `TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Submitting household. |
| `household` | `TEXT NOT NULL` | Name snapshot for display/history. |
| `barangay` | `TEXT NOT NULL` | Assigned barangay. |
| `contact` | `TEXT` | Contact snapshot. |
| `category` | `TEXT NOT NULL` | Assistance category. |
| `disaster` | `TEXT NOT NULL` | Incident type. |
| `urgency` | `TEXT NOT NULL` | Request urgency. |
| `description` | `TEXT NOT NULL` | Household explanation. |
| `status` | `TEXT NOT NULL` | Application-managed request lifecycle. |
| `location` | `TEXT DEFAULT ''` | Address/landmark. |
| `gps` | `TEXT DEFAULT ''` | Coordinate string, if available. |
| `gps_accuracy` | `REAL` | Reported coordinate accuracy in metres. |
| `gps_captured_at` | `TEXT` | ISO 8601 capture time. |
| `photos` | `TEXT NOT NULL DEFAULT '[]'` | JSON array of bounded image data URLs. |
| `rejection_reason` | `TEXT` | Review explanation when rejected. |
| `approved_at` | `TEXT` | ISO 8601 approval time. |
| `approved_by` | `TEXT` | Approver name snapshot. |
| `reviewed_by` | `TEXT` | Reviewer name snapshot. |
| `pledged_at` | `TEXT` | First active pledge time. |
| `pledged_by` | `TEXT` | First active donor name snapshot. |
| `fulfilled_at` | `TEXT` | ISO 8601 fulfilment time. |
| `fulfilled_by_id` | `TEXT` | Official account that fulfilled it. |
| `created_at` | `TEXT NOT NULL` | ISO 8601 submission time. |
| `updated_at` | `TEXT NOT NULL` | ISO 8601 last update time. |

Indexes: `requests_household(household_id)`, `requests_barangay(barangay)`, and `requests_status(status)`.

Current request statuses are `Under Verification`, `Approved`, `Pledged`, `Fulfilled`, and `Rejected`. The application validates transitions; the database column itself does not have a `CHECK` constraint.

### `donations`

Stores both general donations and request-specific pledges. A `NULL request_id` identifies a general donation; otherwise the donation is linked to one household request.

| Column | Definition | Notes |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | Donation reference, generated with a `DON-` prefix. |
| `donor_id` | `TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Donor account. |
| `request_id` | `TEXT REFERENCES requests(id) ON DELETE CASCADE` | Nullable; request-specific pledge when set. |
| `donor` | `TEXT NOT NULL` | Donor name snapshot. |
| `barangay` | `TEXT NOT NULL` | Barangay receiving/reviewing the contribution. |
| `type` | `TEXT NOT NULL` | `Items`, `Water`, `Food`, `Medical`, `Shelter`, or `Other`. |
| `amount` | `TEXT NOT NULL` | Description/quantity supplied by donor. |
| `status` | `TEXT NOT NULL` | Application-managed donation lifecycle. |
| `created_at` | `TEXT NOT NULL` | ISO 8601 submission time. |
| `expires_at` | `TEXT` | Reservation deadline for a request pledge. |
| `reviewed_by` | `TEXT` | Official name snapshot. |
| `reviewed_by_id` | `TEXT` | Reviewing official account ID. |
| `approved_at` | `TEXT` | General donation approval time. |
| `rejected_at` | `TEXT` | General donation rejection time. |
| `rejection_reason` | `TEXT` | Reason for rejection. |
| `completed_at` | `TEXT` | Pledge completion time. |
| `cancelled_at` | `TEXT` | Pledge cancellation time. |
| `expired_at` | `TEXT` | Pledge expiry time. |

Indexes: `donations_donor(donor_id)`, `donations_request(request_id)`, and `donations_barangay_status(barangay, status)`.

General donation statuses are `Pending Approval`, `Approved`, and `Rejected`. Request pledge statuses include `Reserved`, `Completed`, `Cancelled`, and `Expired`. Status transitions are enforced by server handlers, not SQL `CHECK` constraints.

### `donation_messages`

Stores the private conversation associated with a general donation.

| Column | Definition | Notes |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | Message reference. |
| `donation_id` | `TEXT NOT NULL REFERENCES donations(id) ON DELETE CASCADE` | Conversation thread. |
| `sender_id` | `TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Sender account. |
| `sender_name` | `TEXT NOT NULL` | Name snapshot for display. |
| `sender_role` | `TEXT NOT NULL` | Sender role snapshot. |
| `message` | `TEXT NOT NULL` | Message text, limited by the API to 2,000 characters. |
| `created_at` | `TEXT NOT NULL` | ISO 8601 send time. |

Index: `donation_messages_thread(donation_id, created_at, id)`. Messages are visible only to the donation's donor and approved officials assigned to that donation's barangay.

### `request_messages`

Stores each household request's conversation after approval.

| Column | Definition | Notes |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | Message reference. |
| `request_id` | `TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE` | Conversation thread. |
| `sender_id` | `TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Authenticated sender account. |
| `sender_name` | `TEXT NOT NULL` | Name snapshot for display. |
| `sender_role` | `TEXT NOT NULL` | Sender role snapshot. |
| `message` | `TEXT NOT NULL` | Trimmed message text, limited by the API to 2,000 characters. |
| `created_at` | `TEXT NOT NULL` | ISO 8601 send time. |

Index: `request_messages_thread(request_id, created_at, id)`. The API permits only the approved household owner and approved officials assigned to the request's barangay, while the request is Approved, Pledged, or Fulfilled. Sender identity and timestamps come from the server. Messages and opposite-party notifications are written in one transaction.

### `notifications`

Stores per-user transaction and chat notifications.

| Column | Definition | Notes |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | Notification reference. |
| `user_id` | `TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Recipient account. |
| `type` | `TEXT NOT NULL` | Application event type, such as request status, donation status, or chat message. |
| `title` | `TEXT NOT NULL` | Short inbox heading. |
| `body` | `TEXT NOT NULL` | Notification summary. |
| `target_type` | `TEXT NOT NULL` | Application link type: `request`, `donation`, `chat` (donation conversation), or `request_chat` (household conversation). |
| `target_id` | `TEXT NOT NULL` | Linked transaction ID. This is polymorphic and intentionally has no SQL foreign key. |
| `created_at` | `TEXT NOT NULL` | ISO 8601 event time. |
| `read_at` | `TEXT` | `NULL` means unread; otherwise ISO 8601 read time. |

Index: `notifications_user_unread(user_id, read_at, created_at)`. Inbox APIs only return or update notifications for the authenticated recipient.

## Relationships and Deletion Behavior

- Deleting a user cascades to their sessions, requests, donations, messages they sent, and notifications they received.
- Deleting a request cascades to its household conversation and request-specific donations; deleting those donations cascades to their messages.
- General donations have `request_id = NULL` and remain independent of household requests.
- `approved_by`, `reviewed_by`, and notification `target_id` are application-level references/snapshots rather than foreign keys.

## Role-Scoped Data Access

- A household reads its own requests and donations attached to those requests.
- A donor reads their own donations and requests eligible for community support, plus requests they have pledged to.
- A barangay official reads requests and donations for their assigned barangay. Donation chat is limited to the donor and approved officials for that barangay.
- A DSWS admin reads citywide requests and donations. Notifications are still stored per recipient account.

## Runtime and Migration Notes

- Default database path: `./data/ayuda.sqlite`; `DATABASE_PATH` can override it.
- SQLite is configured with foreign keys enabled, WAL journal mode, and a 5-second busy timeout.
- Tables and indexes are created with `IF NOT EXISTS`. Older `requests` tables are upgraded additively for `pledged_at`, `pledged_by`, and `fulfilled_by_id` after inspecting `PRAGMA table_info`.
- Session, recovery, and rate-limit expirations are integer milliseconds. Transaction, chat, and notification timestamps are ISO 8601 text.
- The application periodically removes expired sessions, password resets, and rate-limit buckets. Expired request pledges are updated during relevant server reads/writes.
- SQLite status and role fields are not SQL enums/check constraints; valid values and authorization are enforced in the application layer.
