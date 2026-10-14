# AYUDA CEBU

A mobile-first relief coordination prototype for Cebu City's 80 barangays, with a Node.js backend for accounts, login, account approval, and email password recovery.

## Stack

- HTML5
- CSS3
- Vanilla JavaScript
- Node.js and Express for authentication, account management, and relief operations
- SQLite for accounts, password hashes, sessions, recovery records, requests, and donations
- Gmail SMTP with an App Password, or Resend, for recovery email

## Included workflows

- Household registration and barangay account verification
- Household relief requests
- Barangay request approval/rejection
- Donor request-specific pledges
- General donations routed to a selected barangay
- Private, donation-specific chat between donors and approved officials for household pledges and general donations
- Request-specific chat between households and their barangay after relief request approval
- Role-scoped dashboard notifications for request, donation, and chat updates
- DSWS approval of barangay official accounts
- 72-hour request escalation indicators
- 48-hour pledge reservations
- DSWS citywide reporting and PDF summary export

## Household relief conversations

After a barangay official approves a relief request, the household can select **Chat with barangay** on Home, My Requests, or Request details. Officials can select **Chat with household** from Home, Requests, or Request details. Each request has a separate conversation, available only to its approved household account and approved officials assigned to that request's barangay.

Use the conversation to share relief updates and arrange pickup or delivery. Messages include the sender and time, are saved in SQLite, and refresh every five seconds while the conversation is open. The relief progress display follows the request's current Approved, Pledged, or Fulfilled status. Chat stays available after fulfilment for follow-up; pending and rejected requests do not have chat access. Sending a message does not change the relief status.

New messages notify the other party through the dashboard bell; selecting the notification opens the relevant conversation. Household messages notify the approved barangay team, and official replies notify the request's household. Messages support up to 2,000 characters. Restart the Node server after updating so the request chat API and its database table are available; the table is created automatically without replacing existing records.

## Donor pledge conversations

After pledging support for a household request, donors can select **Chat with barangay** beside the pledge in **Donor > Donations**. Barangay officials can select **Chat · donor name** beside the matching request on Home or Requests. Each pledge has its own private conversation between that donor and approved officials assigned to the request's barangay; it is separate from the household's conversation with the barangay. Messages are saved with the pledge, refresh every five seconds, and notify the other party. Selecting a chat notification opens the matching pledge conversation. The thread remains available for follow-up after the pledge status changes.

Run `node --test tests/request-chat.test.cjs` for request chat API checks. On Windows with Chrome installed, `node output/request-chat-browser-check.cjs` checks both dashboards using synthetic accounts and an in-memory database.

## Consolidated donor requests

**Donor > Browse** and the donor Home page group available requests by **barangay + assistance category**. For example, 20 households in Apas requesting Food appear as one Food assistance card with **20 households** and **20 requests**. Barangay and category filters apply to these groups, and the Community needs count shows groups rather than individual requests.

Each card shows the highest urgency, approved and under-verification request counts, incident types, and oldest request date. Groups appear by highest urgency, then oldest request. Household totals count distinct account IDs; repeated requests from one account count as one household, and older requests without an account ID are identified separately without guessing household identity from names.

Select **View requests** to review the individual households, descriptions, and statuses, then use **Details** or **Pledge support**. Pledges remain attached to the selected household request, with the existing 48-hour reservation and barangay verification workflow. Only Approved and Under Verification requests are included; pledged, fulfilled, and rejected requests are excluded. Consolidation does not merge or delete the original household records.

## Household location

In **Household > New Request**, tap **Use precise location** once while at the household and allow the browser's location request. AYUDA requests fresh, high-accuracy readings, reacquires location automatically, and waits up to one minute for a device-reported accuracy of **10 metres or better**. Only a qualifying reading is added to the form and used for address lookup. A rough reading such as 271 metres is never saved as an automatic pin, including when the attempt times out or is cancelled. Old or invalid readings are ignored.

The 10-metre threshold filters the device's estimated accuracy; it does not guarantee an exact household entrance. [Browser high-accuracy mode](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/getCurrentPosition) is a request to the device, and [reported accuracy is an estimate](https://developer.mozilla.org/en-US/docs/Web/API/GeolocationCoordinates/accuracy). A Windows laptop or desktop may be unable to reach this threshold. In that case, use a phone with precise location enabled or enter the household address manually. Changing a website cannot give a computer GPS hardware or override location permissions.

An accepted pin is ready to submit immediately, even if address lookup fails. Its coordinates, accuracy, and capture time are retained in the saved request, and its details include a map link. Starting another capture removes the previous automatic pin and address; editing the address also removes the previous pin to avoid mismatched coordinates. Manually entered text is preserved while a new capture is pending. You can enter an address, landmark, or `latitude, longitude` manually, or leave location blank. Manual coordinates are not labelled as device-verified. Cancel stops detection; an already accepted pin is kept. Temporary location errors retry automatically within the same minute, while denied permission stops immediately.

Browser location requires **HTTPS**, or **http://localhost:3000** on the computer running AYUDA. An HTTP LAN address on another device does not provide a secure location context. Enable location services on the device and allow location for the site in browser settings if access was blocked.

Address lookup uses the authenticated `POST /api/location/reverse` endpoint, so it works with the app's same-origin security policy. The server uses the existing OpenStreetMap Nominatim provider, a seven-second timeout, a bounded in-memory cache, and a shared request limit of at most one provider request every 1.1 seconds. If busy or unavailable, the pin remains usable. Coordinates go to the provider for address lookup; household names, contact details, and request descriptions are not sent.

The public provider is intended for light, user-triggered use. Follow the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/), including its application-wide one-request-per-second limit and OpenStreetMap attribution. Set optional `GEOCODING_REVERSE_URL` to switch to a Nominatim-compatible provider and `GEOCODING_USER_AGENT` to identify your deployment. Multiple server processes or larger deployments need a shared limiter/cache or an appropriate hosted/self-hosted provider. No API key is needed for the default provider.

Run `npm test` for the backend checks. On Windows with Chrome installed, `node output/location-browser-check.cjs` runs isolated browser checks for capture, permissions, fallback, cancellation, navigation, submission, and mobile layout. It uses synthetic locations and an in-memory account database.

## PDF summary format

In **DSWS > Reports**, select **Export summary (PDF)** to download an A4 portrait report named `ayuda-cebu-dsws-summary-YYYY-MM-DD.pdf`. The date and generation time use Asia/Manila. No print dialog is required.

On phones and other touch devices, wait for **Your PDF is ready**, then tap **Download PDF**. **Open PDF** provides a preview, and **Share / Save** appears when the browser supports sharing files. On iPhone, the share menu can save the PDF to Files. Preparing the file before the final tap avoids losing the browser's user gesture during a slow load. Supported browsers generate the PDF in a background worker to keep the page responsive; desktop browsers retain the automatic download.

The report includes request totals, fulfilment rate, pending and escalated requests, active contributions, request and donation status counts, unmet needs by assistance category, and a paginated breakdown of barangays with requests. Empty reports show zero counts. Fulfilment rate uses all requests (including rejected requests); escalated requests have been under verification for at least 72 hours. Active contributions are reserved donations, and donation figures are counts rather than cash totals.

The report covers the relief records in the server database. It contains aggregate figures, without household details, donor details, photos, or contact information. PDF libraries are installed with `npm install` and served locally by the Node server when exporting; no external CDN is used. Restart the server after updating to enable the PDF asset routes.

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

Open **http://localhost:3000**. Keep using this address so cookies stay on the same origin. Authentication and relief data require the Node server; opening `index.html` directly or using a static-only server cannot run the APIs.

In VS Code, select **Launch AYUDA backend and Chrome** in **Run and Debug**, then press **F5**. It starts the backend and opens Chrome when the server is ready. **Launch AYUDA in Chrome** opens the browser when you have already started the backend with `npm start`.

### Test multiple accounts in separate tabs

You can log in as DSWS, a barangay official, and a household in three tabs of the same browser at **http://localhost:3000/#/login**. Logging in, switching accounts, or logging out in one tab affects only that tab. Refreshing a tab keeps its login until the server session expires after eight hours. A new tab starts logged out. Password recovery still revokes every session for the account whose password was reset; changing a password while signed in keeps the current session and revokes that account's other sessions.

After installing this change, restart `npm start`, hard-refresh each existing tab with **Ctrl+Shift+R**, and log in once in each tab. Old shared-cookie logins are not automatically adopted by the new tabs.

Each tab stores a random, non-secret selector in [`sessionStorage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage) and sends it in `X-Ayuda-Tab`. The server selects that tab's separate **HttpOnly** cookie; authentication tokens stay out of JavaScript storage. Chrome on localhost also uses a [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) to give duplicated tabs or windows a fresh selector when the original tab is open. In browsers without Web Locks, open new tabs from the address bar instead of duplicating an existing tab. If browser storage is blocked, the tab remains isolated but must log in again after a reload.

Run `npm test` for the backend regressions. On Windows with Chrome installed, run `node output/tab-session-browser-check.cjs` to check multiple tabs sharing one browser cookie jar. The check uses test accounts and an in-memory database.

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

Relief requests, pledges, and donations are stored in SQLite and shared according to the signed-in user's role and barangay. Older browser-only prototype records are not imported automatically, so they do not appear in dashboard totals; the original browser storage is left untouched. This local prototype still needs production deployment hardening, operational backups, and a reviewed data-migration plan before handling real relief operations.

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
