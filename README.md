# DAA Pay

Payment queue for DAA Montenegro d.o.o.: incoming invoices (read from the fiscal QR code and the
invoice text), refund requests and payments by contract, with approvals by role, emails, PDF export,
beneficiary archive, activity log and backups.

Runs on Cloudflare: one **Worker** serves the app and its API, **D1** is the database, **R2** stores
uploaded files and daily backups. Deploys from GitHub Actions on every push to `main`.

## What is where

| Path | What it is |
|---|---|
| `public/index.html` | The app (screens and logic), served as a static file |
| `public/api-shim.js` | Connects the app to the server: live data sync, uploads, downloads, email |
| `public/vendor/` | Libraries served from our own domain (Preact/htm, pdf-lib, PDF.js, jsQR, QR generator) |
| `src/worker.js` | Server: sign-in, two-step codes, role rules, files, email, weekly report, backups |
| `migrations/` | Database schema |
| `.github/workflows/deploy.yml` | Creates the database and bucket on first run, applies migrations, deploys |
| `scripts/port-from-alpha.py` | Record of how the claude.ai alpha page was turned into `public/index.html` |

## First deployment

1. **Cloudflare plan.** Use **Workers Paid** ($5/month). Password checks need more CPU time than the
   free plan allows, so sign-in would fail on the free plan.
2. **API token.** Cloudflare dashboard → My Profile → API Tokens → Create Token → template
   *Edit Cloudflare Workers*, then add **Account · D1 · Edit** and **Account · Workers R2 Storage · Edit**.
3. **GitHub secrets.** In this repository: Settings → Secrets and variables → Actions → New repository secret:
   - `CLOUDFLARE_API_TOKEN` — the token from step 2
   - `CLOUDFLARE_ACCOUNT_ID` — shown on the Cloudflare dashboard home page
   - `RESEND_API_KEY` — optional; emails stay off until it is added (see *Email* below)
4. **Run the deploy.** Actions → *Deploy DAA Pay* → Run workflow (or push to `main`). The first run
   creates the `daa-pay` D1 database and the `daa-pay-files` R2 bucket in Western Europe.
5. **Open the address** shown at the end of the deploy log (`https://daa-pay.<account>.workers.dev`).
   Because the database is empty, DAA Pay shows **Set up DAA Pay**:
   - **Bring over the alpha:** in the alpha, Users & roles → Data & backups → *Download backup*, then
     choose that file. Everyone keeps their alpha password and two-step sign-in. Uploaded invoice files
     are not in the backup and need to be uploaded again where needed.
   - **Start empty:** create the first Super-admin account.

   This screen only works while there are no accounts, so do it right after the first deploy.
6. Set `APP_URL` in `wrangler.toml` to the final address (used in email links) and push.

## Own domain (pay.daa.co.me)

If `daa.co.me` is managed in Cloudflare: Workers & Pages → `daa-pay` → Settings → Domains & Routes →
Add → Custom domain → `pay.daa.co.me`. Then set `APP_URL = "https://pay.daa.co.me"` in `wrangler.toml`.

## Email

Emails are sent through [Resend](https://resend.com): new requests (to the CEO, Super-admin and the
assistant's account manager), payment orders to the office manager, paid and denied notices, welcome
and invitation emails for new accounts, access-request confirmations and approvals, password reset
links, bug reports (to the Super-admin) and the Monday report.

1. Create a Resend account, add the domain `daa.co.me`, and add the DNS records it shows (SPF/DKIM).
2. Create an API key and add it as the `RESEND_API_KEY` repository secret; run the deploy again.
3. The sender is `MAIL_FROM` in `wrangler.toml` (default `DAA Pay <pay@daa.co.me>`).

Emails only go to people with an active DAA Pay account. Until email is set up, invitation and reset
links are shown in Users & roles so they can be sent by hand.

## Security model

- Passwords: PBKDF2-SHA256 (100 000 rounds, random salt). Alpha accounts (120 000 rounds) are
  re-hashed on their first sign-in.
- Two-step sign-in (authenticator app codes) is required for the CEO and Super-admin; optional for others.
- Sessions: random token in an HttpOnly, Secure, SameSite=Lax cookie; 7 days.
- Every read and write is checked on the server: who sees which requests, who may approve, send or pay,
  who may create accounts or change roles. Password hashes and two-step secrets never leave the server.
- Uploaded files are private: only signed-in users can open them.
- Sign-in, two-step and registration attempts are rate-limited.
- Daily backup to R2 (`backups/YYYY-MM-DD.json`, kept 30 days); CEO and Super-admin can also download one.

## Running locally

```sh
npm install
npm run dev          # http://127.0.0.1:8787 with a local database and file store
```

Local email is off (no `RESEND_API_KEY`); the app says so when it tries to send.

## Third-party code

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
