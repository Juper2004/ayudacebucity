# AYUDA CEBU

A mobile-first relief coordination prototype for Cebu City's 80 barangays, with a Node.js backend for accounts, login, account approval, and email password recovery.

## Stack

- HTML5
- CSS3
- Vanilla JavaScript
- Node.js and Express for authentication and account management
- SQLite for accounts, password hashes, sessions, and recovery records
- Gmail SMTP with an App Password, or Resend, for recovery email
- `localStorage` for the remaining relief-request and donation prototype records

## Included workflows

- Household registration and barangay account verification
- Household relief requests
- Barangay request approval/rejection
- Donor request-specific pledges
- General donations routed to a selected barangay
- DSWS approval of barangay official accounts
- 72-hour request escalation indicators
- 48-hour pledge reservations
- DSWS citywide reporting and PDF summary export

## PDF summary format

In **DSWS > Reports**, select **Export summary (PDF)** to download an A4 portrait report named `ayuda-cebu-dsws-summary-YYYY-MM-DD.pdf`. The date and generation time use Asia/Manila. No print dialog is required.

The report includes request totals, fulfilment rate, pending and escalated requests, active contributions, request and donation status counts, unmet needs by assistance category, and a paginated breakdown of barangays with requests. Empty reports show zero counts. Fulfilment rate uses all requests (including rejected requests); escalated requests have been under verification for at least 72 hours. Active contributions are reserved donations, and donation figures are counts rather than cash totals.

The report covers all available relief records saved in the current browser. It contains aggregate figures, without household details, donor details, photos, or contact information. PDF libraries are installed with `npm install` and served locally by the Node server when exporting; no external CDN is used. Restart the server after updating to enable the PDF asset routes.

## Design system

The interface is mobile-first and uses the AYUDA CEBU palette:

- `#F5F5F7` — page background
- `#1D1D1F` — primary text / dark surface
- `#AAAAAA` — neutral gray
- `#007AFF` — primary action / accent

The September 2026 polish pass adds improved responsive navigation, dashboard icons, refined cards, stronger focus states, accessible dialogs/toasts, and a more cohesive civic-service visual hierarchy.

## Run locally

Install **Node.js 24.15 or newer**. Run these commands in the project folder using PowerShell:

```powershell
npm install
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
```

Copy the environment template once. If `.env` already exists, edit it instead of replacing it.

Generate a private recovery secret:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Paste the generated value into `OTP_SECRET` in your local `.env`. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` to the credentials you want for the first DSWS administrator; `ADMIN_NAME` controls its display name. The bootstrap credentials create the initial administrator and do not reset an existing administrator's password. There is no default demo administrator password.

Configure Gmail below, then start the app:

```powershell
npm start
```

Open **http://localhost:3000**. Keep using this address so cookies and browser prototype records stay on the same origin. Authentication requires the Node server; opening `index.html` directly or using a static-only server cannot run the account APIs.

In VS Code, select **Launch AYUDA backend and Chrome** in **Run and Debug**, then press **F5**. It starts the backend and opens Chrome when the server is ready. **Launch AYUDA in Chrome** opens the browser when you have already started the backend with `npm start`.

## Send recovery codes with Gmail

Use the Gmail account that will send AYUDA recovery messages. Enable **2-Step Verification**, then create an **App Password** named `AYUDA local`. Google requires 2-Step Verification for App Passwords; some organization accounts, security-key-only setups, or Advanced Protection accounts may not offer this option. See [Google's App Password instructions](https://support.google.com/accounts/answer/185833?hl=en).

Update these values in `.env`:

```dotenv
MAIL_PROVIDER=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-sender@gmail.com
SMTP_PASS=your-google-app-password
MAIL_FROM=your-sender@gmail.com
```

Use the generated App Password for `SMTP_PASS`, with any display spaces removed. `SMTP_USER` and `MAIL_FROM` should be the same sender Gmail address. Google's [SMTP setup instructions](https://support.google.com/a/answer/176600?hl=en) specify `smtp.gmail.com` and port `465` for SSL. Enter the credentials only in your local `.env`; do not paste them into chat or commit them to Git.

Restart `npm start` after changing `.env`. Register an account using an inbox you can access, open **Forgot password?**, and request a code for that registered email. Enter the code from the received email and choose a new password. If needed, check the inbox's Spam folder. An old browser-only account must be registered again before email recovery can work.

Codes are generated and checked on the server. The interface does not display a recovery code. Missing or incomplete mail configuration returns an explicit service-unavailable error instead of pretending an email was sent. Actual Gmail delivery requires valid credentials and a working network connection.

## Environment settings

The complete template is [.env.example](.env.example).

| Setting | Local value or purpose |
| --- | --- |
| `HOST` | `127.0.0.1` to listen on this computer |
| `PORT` | `3000` |
| `APP_ORIGIN` | `http://localhost:3000`; must match the URL used in the browser |
| `COOKIE_SECURE` | `false` for local HTTP; use `true` when serving over HTTPS |
| `DATABASE_PATH` | `./data/ayuda.sqlite` |
| `OTP_SECRET` | Private value generated from at least 32 random bytes |
| `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Initial DSWS administrator setup |
| `MAIL_PROVIDER` | `smtp` for Gmail, or `resend` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP connection settings |
| `SMTP_USER`, `SMTP_PASS` | Sender email and App Password for Gmail |
| `MAIL_FROM` | Sender address |
| `RESEND_API_KEY` | Required only when `MAIL_PROVIDER=resend` |

For Resend, set `MAIL_PROVIDER=resend`, `RESEND_API_KEY`, and a `MAIL_FROM` address authorized by your Resend account. No console-based mail provider is offered for live recovery.

## Checks

```powershell
npm test
```

Automated tests do not require your Gmail App Password. Delivery to a real inbox is a separate manual check after configuring your sender.

## Data and current scope

Account credentials and authentication now live on the server. Existing browser-only accounts are not imported automatically; register them again or create the initial DSWS administrator through `.env`.

Relief requests, pledges, and donations still use the browser prototype storage. They are not shared across browsers or devices, and changing the local site address gives them a different storage origin. This is an authentication backend, not a complete production backend for relief operations. A full deployment also needs server-side request and donation APIs, authorization, data migration, backups, and deployment configuration.

`.env`, `data/`, and `node_modules/` are ignored by Git. Keep the SQLite database if you want to preserve accounts between server restarts.

## How to run step by step

1. Open PowerShell in the project folder:

```powershell
cd "C:\Users\Juper\OneDrive\Desktop\AYUDA 2.0"
```

2. Install project dependencies:

```powershell
npm install
```

3. Create the local environment file if it does not exist yet:

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
```

4. Open `.env` and update the required values. At minimum, make sure these are set:

```dotenv
HOST=127.0.0.1
PORT=3000
APP_ORIGIN=http://localhost:3000
COOKIE_SECURE=false
DATABASE_PATH=./data/ayuda.sqlite
OTP_SECRET=replace-with-a-random-64-character-secret
ADMIN_NAME="DSWS Administrator"
ADMIN_EMAIL=your-admin@example.com
ADMIN_PASSWORD=YourStrongPassword123!
MAIL_PROVIDER=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-sender@gmail.com
SMTP_PASS=your-google-app-password-without-spaces
MAIL_FROM=your-sender@gmail.com
```

5. Generate a valid recovery secret:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy the printed value into `OTP_SECRET` in `.env`.

6. For Gmail, use a Google App Password and remove any spaces from `SMTP_PASS`.

7. Start the app:

```powershell
npm start
```

8. Open the browser at:

```text
http://localhost:3000
```

9. If you see a startup error like `Set OTP_SECRET ...` or `The bootstrap admin email already belongs to another account`, fix the relevant `.env` value and run `npm start` again.

10. To run the automated checks:

```powershell
npm test
```

If you want a clean reset, delete the database file at `data/ayuda.sqlite` and restart the server. This removes existing user accounts and sessions, so use it only when you intentionally want a fresh local setup.
