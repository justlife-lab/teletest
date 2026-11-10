# Justlife Teleconsultation — booking website + Google Sheet

A simple website (plain HTML/CSS/JS — no build step) where clients book a teleconsultation, and a staff portal for admins and doctors. **All data is stored in a Google Sheet**; a Google **Apps Script** inside the sheet is the backend. The website can be hosted for free on **GitHub Pages** (or Vercel) and opened with a link.

| Page | Who | Sign-in |
|---|---|---|
| `index.html?t=<link>` | Clients — book a teleconsultation | None (secure booking link from CX) |
| `index.html?r=<token>` | Clients — reschedule / cancel | None (private link in their email) |
| `partner.html` | Admins / CX and doctors | Google, **@justlife.com only** |
| `privacy.html` | Everyone | — |

```text
Browser ──► GitHub Pages (index.html, partner.html, app.js, style.css, config.js)
                │  fetch()
                ▼
        Apps Script web app (Code.gs) ──► Google Sheet: Settings · Doctors · Leaves · Appointments · Upsells · Links · Log
                │
                ├── Gmail: confirmation / reschedule / cancel / reminder emails
                └── Google Drive: private folder for lab results
```

## Files

| File | What it is |
|---|---|
| `index.html` | Client booking, reschedule & cancel page |
| `partner.html` | Staff portal (dashboard, schedule, bookings, doctors, booking links; doctor view) |
| `privacy.html` | Privacy notice (have legal review the text) |
| `app.js` | All website logic |
| `style.css` | All styles |
| `config.js` | **You edit this**: Apps Script URL, Google client ID, Google Sheet link |
| `Code.gs` | **Paste into Apps Script**: the backend |
| `appsscript.json` | **Paste into Apps Script**: time zone, web-app access, permissions |
| `tests/` | Automated tests + a local demo (`node tests/serve-local.js`) |
| `logo.png`, `favicon.png` | Your existing images (keep them) |

---

## Setup — step by step (about 20 minutes)

### Step 1 — Google Sheet + Apps Script

1. Create a new Google Sheet with your Justlife account, e.g. *Justlife Teleconsultation — DATA*.
2. **Extensions → Apps Script**.
3. Replace everything in `Code.gs` with the contents of **`Code.gs`** from this repo.
4. Click **Project Settings (⚙)** → tick **Show "appsscript.json" manifest file** → go back to the editor → open `appsscript.json` → replace it with **`appsscript.json`** from this repo. **Save** (💾).
5. Go back to the sheet and **reload** the page. A **Justlife** menu appears → **Justlife → Setup / repair tabs** → approve the permissions (Google shows *"unverified app"* for your own scripts: *Advanced → Go to … (unsafe)* is expected).
   The tabs **Settings, Doctors, Leaves, Appointments, Upsells, Links, Log** are created, with one sample doctor.
6. **Justlife → Install reminder trigger (hourly)**.

### Step 2 — Publish the Apps Script as a web app

1. In the Apps Script editor: **Deploy → New deployment** → ⚙ **Select type → Web app**.
2. *Execute as*: **Me** · *Who has access*: **Anyone** → **Deploy**.
3. Copy the **Web app URL** (ends in `/exec`).

> "Anyone" is needed so clients (who have no Google login) can book. Staff actions are still protected: every staff request carries a Google sign-in token that the script checks.
> **Every time you change `Code.gs` later:** Deploy → **Manage deployments** → ✏️ → *Version*: **New version** → **Deploy**. The URL stays the same.

### Step 3 — Google login (@justlife.com only)

1. [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials** → your OAuth client ID of type **Web application** (the one already in `config.js`, or create one).
2. **Authorised JavaScript origins** → add your website's origin, e.g. `https://justlife-lab.github.io` (no path, no trailing slash). Add `http://localhost:8080` too if you want to test locally. No redirect URI is needed.
3. **OAuth consent screen** → User type **Internal** (only Justlife Workspace accounts).
4. Copy the **Client ID** into:
   - `config.js` ▸ `GOOGLE_CLIENT_ID`, **and**
   - the sheet's **Settings** tab ▸ `GOOGLE_CLIENT_ID` (must be identical).

The script verifies every staff sign-in with Google: the token must be for this client ID, the email verified by Google, and the account must belong to the `ALLOWED_DOMAIN` Workspace (`justlife.com`). A Gmail or other account gets *"Access restricted to authorized Justlife accounts."*

*No OAuth yet?* Set **Settings ▸ AUTH_MODE = test** and **TEST_PASSWORD** (8+ characters). Staff then sign in with any @justlife.com email + that password. Switch back to `google` before real use.

### Step 4 — Edit `config.js`

```js
APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfy…/exec',   // from Step 2
GOOGLE_CLIENT_ID: '676386166698-….apps.googleusercontent.com',     // from Step 3
GOOGLE_SHEET_URL: 'https://docs.google.com/spreadsheets/d/…/edit',  // your sheet (for the "Open Google Sheet" button)
ALLOWED_DOMAIN: 'justlife.com',
```

### Step 5 — Upload to GitHub and turn on GitHub Pages

1. In your GitHub repo click **Add file → Upload files** and drag in all files from this folder (`index.html`, `partner.html`, `privacy.html`, `app.js`, `style.css`, `config.js`, `Code.gs`, `appsscript.json`, `README.md`, the `tests` folder). Keep your `logo.png` and `favicon.png`. **Commit changes**.
2. Repo **Settings → Pages** → *Source*: **Deploy from a branch** → Branch **main**, folder **/ (root)** → **Save**.
3. After ~1 minute the site is live at `https://<owner>.github.io/<repo>/`, e.g. `https://justlife-lab.github.io/teleconsult/`.
   - Client booking: `…/index.html?t=<link token>` (create links in the staff portal)
   - Staff portal: `…/partner.html`

> GitHub Pages on a **private** repo needs a paid GitHub plan. Nothing in these files is secret (no passwords or keys), so a public repo is OK. Alternatively import the repo into **Vercel** (free, works with private repos): *Add New → Project → Import → Framework: Other → Deploy*.

### Step 6 — Finish the Settings tab

In the sheet's **Settings** tab set at least:

| key | value |
|---|---|
| `SITE_URL` | your website, e.g. `https://justlife-lab.github.io/teleconsult/` (used for links in emails) |
| `GOOGLE_CLIENT_ID` | same as `config.js` |
| `SUPPORT_EMAIL`, `SUPPORT_PHONE` | shown to clients |

Other settings (booking horizon, notice, slot length, reschedule cut-off, reminders, upsell price list, public booking without a link…) are explained in the *description* column. Changes apply immediately — no redeploy needed.

### Step 7 — Test

1. Open `partner.html` → **Continue with Google** with your @justlife.com account → Dashboard.
2. **Doctors** → edit the sample doctor (name, specialty, working hours like `09:00-13:00, 16:00-20:00`). Put the doctor's **@justlife.com email** so they can sign in to see their own appointments.
3. **Booking links → Create link** → open it on your phone → book a time, attach a PDF → you get a confirmation screen and email.
4. The booking appears in **Schedule**, in the doctor's view and in the **Appointments** tab of the sheet.
5. Open the reschedule link from the email → reschedule → a new version `…-R1` appears; the old one becomes *RESCHEDULED*.

---

## How it works

**Doctors & availability.** Each doctor row has a column per weekday (`sun` … `sat`) with working periods like `09:00-17:00` or `09:00-13:00, 16:00-20:00` (empty = day off). Slots are `SLOT_MINUTES` long. Leave in the *Leaves* tab blocks whole days. Booked slots are never shown to clients.

**No double booking.** Every booking, reschedule and cancellation runs inside the script's **lock** (`LockService`), and the slot is re-checked against the sheet inside that lock. Two clients clicking the same slot are processed one after the other; the second gets *"Sorry, this time slot has just been booked by another client. Please select another available time."*

**Reschedules keep history.** The old row becomes `RESCHEDULED`, a new row `…-R1` is added; the client's link always points to the latest version.

**Consultation workflow (doctor).** Scheduled → *Start consultation* (records how many minutes after the window start the call began → on-time KPI) → notes (main issue, assessment, recommendation required) → *Complete* or *No show*. Doctors add recommended services (upsells) and mark them Booked with the amount.

**Dashboard KPIs.** Bookings, completion %, on-time calls % (≤ `ON_TIME_TOLERANCE_MINUTES`), average delay, cancellation and no-show %, upsell conversion and GMV, per doctor.

**Emails** are sent from the Google account that deployed the web app (Gmail quota: 100/day on a personal account, 1,500/day on Workspace).

**Lab results** are stored in a private Google Drive folder ("Justlife Teleconsultation — Lab results (private)") owned by that account. Only admins and the assigned doctor can open them through the portal; every view is logged.

## Editing the sheet by hand

- Changing values in cells is fine (e.g. fix a client's name, change a doctor's hours, change a setting).
- Don't rename tabs or the column names in row 1. You can add your own extra columns at the right.
- Avoid sorting the data tabs while people are booking — use **Data → Filter views** instead.
- **File → Version history** lets you restore the sheet.

## Security notes

- Anyone who can open the Google Sheet can see all client data and notes — share it only with the people who own the data.
- `config.js`, `app.js` and `Code.gs` contain no secrets. `TEST_PASSWORD` lives only in the sheet.
- All values are written to the sheet as plain text, so client input can't run as a formula. CSV export neutralises formulas too.
- Client links are long random tokens; pages send `no-referrer` and `noindex`.

## Run the tests / try it locally without Google

Requires Node.js 18+.

```bash
node tests/run-tests.js      # 19 backend tests: booking, double booking, links, auth, reschedule, consultation, reminders…
node tests/serve-local.js    # full website on http://localhost:8080 with an in-memory sheet
                             # staff login: admin@justlife.com or doctor@justlife.com / test-pass-123
```

## Troubleshooting

| Problem | Fix |
|---|---|
| *"The website is not connected yet"* | Put the `/exec` URL in `config.js` ▸ `APPS_SCRIPT_URL`. |
| *"The server sent an unexpected answer"* | Deployment access must be **Anyone** (not "Anyone with Google account"). If "Anyone" isn't offered, your Workspace admin has to allow it (Admin console → Apps Script / Drive sharing settings). |
| Changes to `Code.gs` have no effect | Deploy → Manage deployments → ✏️ → **New version** → Deploy. |
| Google button doesn't appear / *origin not allowed* | Add the site origin (e.g. `https://justlife-lab.github.io`) to *Authorised JavaScript origins* of the OAuth client. Wait 5 minutes. |
| *"GOOGLE_CLIENT_ID … must be identical"* | Same client ID in `config.js` and in the Settings tab. |
| *"Access restricted…"* for a Justlife person | They must use their @justlife.com Google account. If `ADMIN_EMAILS` is filled in, add them there (or as a doctor). |
| A doctor sees the admin portal | Put the doctor's exact @justlife.com email in the Doctors tab and keep status `ACTIVE`. |
| No emails | Check `SEND_EMAILS = TRUE` and the *Log* tab for `EMAIL_FAILED`. |
| No reminders | Justlife → Install reminder trigger (hourly). |
| Client sees *"Please use the booking link…"* | Send them a link from **Booking links**, or set `PUBLIC_BOOKING = TRUE`. |
