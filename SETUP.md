# Show Ops Dashboard — How it works (since 2026-06-10)

**Live URL:** https://fuse-dashboard-proxy.iqlarodework.workers.dev/
(Served by Cloudflare. The old GitHub Pages URL is unreliable — GitHub's
deploy API kept failing with 401s on 2026-06-10 — and is now backup only.)

**Deploys:** `bash ~/show-dashboard-test/push-dashboard.sh` — validates,
publishes to Cloudflare via wrangler, then best-effort backs up to GitHub.
Only needed when page/worker code changes; data is always live.

## Architecture

- `index.html` — lightweight app (~25 KB). On every open it fetches **live**
  data from Airtable through the Cloudflare Worker proxy. No baked-in data,
  no daily regeneration, no pushes needed for data updates.
- `worker.js` — Cloudflare Worker (`fuse-dashboard-proxy`). Holds the
  Airtable token server-side and requires a PIN (`?key=`) on every request.
- Pushing to GitHub is only needed when the **page itself** changes.

Data shown per show (Iqral view, ends ≥ 7 days ago): key dates + countdown,
crew with tap-to-call/email, AM contact, email awareness (count, latest
senders/subjects from Zapier Emails — no bodies) + Gmail deep link,
Dropbox / AV Binder / InfoDoc / Airtable links. Travel vs Remote is computed
live from EventPositions (Iqral in crew = TRAVEL).

## One-time: enable the PIN (~5 min)

The worker currently answers without a PIN. To lock it down:

1. Go to https://dash.cloudflare.com → **Workers & Pages** → **fuse-dashboard-proxy**
2. **Edit code** → replace everything with the contents of `worker.js` from
   this folder → **Deploy**
3. **Settings → Variables and Secrets** → **Add** → type **Secret**,
   name `DASH_PIN`, value = the PIN you want (e.g. a 4–6 digit number) → Save
4. Open the dashboard, enter the PIN once per device. Done.

CLI alternative from this folder: `npx wrangler deploy` then
`npx wrangler secret put DASH_PIN`

Until step 3 is done, the dashboard works but accepts any PIN.

## Day-to-day

Nothing. Open the URL on phone or laptop — it's always current.
The ↻ button re-pulls; it also auto-refreshes when you return to the tab
after 10+ minutes.
