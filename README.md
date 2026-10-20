# Shubham Birajdar — Portfolio

Personal portfolio site (single page) with a real backend: a Cloudflare Worker that serves
the static site and exposes a contact API backed by a D1 (SQLite) database.

**Live (production):** https://site-88c28c19caac4fb2ba62486a951cea55.freebuff.page
**Preview:** https://site-9bfbff5b8c9f40a5ab5a686bc287488b.freebuff.page

## What's inside

| Path              | Purpose                                                        |
| ----------------- | -------------------------------------------------------------- |
| `public/index.html` | The portfolio page (theme toggle, filters, scroll animations) |
| `worker.js`       | Worker: static assets + contact API (validation, rate limiting, honeypot, origin check) |
| `manifest.json`   | Deployment manifest (worker module + assets)                   |
| `wrangler.jsonc`  | Local dev config (assets dir + local D1 binding)               |
| `schema.sql`      | Local dev database schema                                      |

## API

| Route            | Method | Description                                             |
| ---------------- | ------ | ------------------------------------------------------- |
| `/api/contact`   | POST   | Submit `{ name, email, message, website? }` → stored in D1 |
| `/api/health`    | GET    | Liveness probe                                          |
| `/api/messages`  | GET    | Read stored messages — requires `X-Admin-Key` header matching the `ADMIN_KEY` secret |

Protections on `/api/contact`:

- field validation (lengths, email format)
- honeypot field (`website`) silently drops bots
- cross-origin (`Origin` ≠ host) submissions rejected with 403
- per-IP rate limit: 5 messages per 10 minutes → 429
- 32 KB body cap

## Local development

```bash
npm install
npm run db:init:local     # create the local D1 table
npm run dev               # http://127.0.0.1:8787
```

Messages submitted locally are stored in the local D1 (`.wrangler/` state).

## Reading messages on the deployed site

Set an `ADMIN_KEY` secret for the site environment, then:

```bash
curl -H "X-Admin-Key: <your key>" https://site-88c28c19caac4fb2ba62486a951cea55.freebuff.page/api/messages
```

## Deployment

Deployed with Freebuff Sites (Cloudflare Worker + D1):

- Site ID: `7f2a9c41-3e5b-4d18-9a6f-2c8b1d4e7f90`
- Environments: `preview` and `production` — both live, each with its own D1 database
- D1 binding: `DB` (auto-migrated by `worker.js` on first request)
- `ADMIN_KEY` secret is set per environment (message inbox protection)
