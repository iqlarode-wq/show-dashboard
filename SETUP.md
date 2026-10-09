# Show Ops Dashboard — SETUP (updated 2026-10-09, build r11)

**Live:** https://fuse-dashboard-proxy.iqlarodework.workers.dev/ — served by Cloudflare, PIN-gated (enforced; enter once per device).
Data is fetched live from Airtable on every open. No daily regeneration. No push needed for data changes.

**Full documentation** (architecture, Radar rules, Airtable queries, runbook, testing, changelog, handoff): `~/Documents/Work Shortcut/Work Shortcut/docs/show-ops-dashboard/`. Start with `HANDOFF.md`. All documentation is saved there; update its `CHANGELOG.md` and `HANDOFF.md` with every change.

## Rules for Claude — read before touching anything

- Edit `index.html` / `worker.js` in this folder, in place. Never write the dashboard anywhere else — the push script only deploys what's here.
- No baked-in data. The push script blocks any `index.html` over 300 KB or containing a hardcoded `Updated: <date>`. Data must come from Airtable via the worker at runtime.
- Airtable and Calendar are read-only for Claude. Show planned changes and get Iq's explicit approval before creating, editing, or deleting anything.
- Travel vs Remote is computed at runtime from EventPositions: Iqral in the crew list → TRAVEL, else REMOTE. Never hardcode it.
- Must work on phone and laptop. Check both viewports after layout changes.
- Before telling Iq to push, run the same checks the push script runs (size 15–300 KB, required tokens present, `node --check` on the inline script) so the deploy doesn't block on him. Fix failures first.
- After any generation or update, open the live URL in Chrome via the Control Chrome MCP (`open_url`) and check visually. Iq hard-refreshes (Cmd+Shift+R) after a deploy.

## Files

| File | Status |
|---|---|
| `index.html` | **Live page** (~133 KB). Fetches Airtable through the worker; PIN gate; all UI, including Radar. |
| `worker.js` | **Live worker** (`fuse-dashboard-proxy`). Holds `AIRTABLE_PAT` + `DASH_PIN` server-side. Routes: `/v0/appcbc1CDJKyKb8db/*` proxy, `/upload` + `/delete-file` (Files table only), `/notes` (KV), `/radar` (KV), `/tmp/*`. |
| `wrangler.toml` | Worker config. Serves `./public` as static assets. KV: `TEMP_FILES`, `DASH_NOTES`. |
| `push-dashboard.sh` | Deploy script — see below. |
| `public/index.html` | Copy the push script makes. Don't edit. |
| `.github/workflows/deploy-pages.yml` | Legacy GitHub Pages deploy. Backup only, unreliable. |
| `show-dashboard.html`, `sync-notes.py`, `exported-notes.json`, `*.bak-*` | Legacy / backups from the old baked-data era. Ignore. |

## Data — all read live via the worker

- Base `appcbc1CDJKyKb8db`. Events `tblno1XUMyyVeA2z6` (view `viwT3CcaSHtTVAZBi` = Iqral), EventPositions `tblloB4sAREi8YqrC`, Zapier Emails `tblu9DkXv7Z8e7vNq`, Files `tblivTW2lEP56DiuQ`.
- Per show: key dates (Booth Ship → Travel Out) + countdown, `URGENT_DAYS = 5` flag, crew (tap-to-call/email), AM contact, emails (new-mail count, latest senders/subjects, Gmail + reply-all links), Files (upload/delete via worker), Dropbox / AV Binder / InfoDoc / Airtable links, weather (open-meteo), .ics export.
- Meeting Notes: Granola notes land in worker KV via `POST /notes` from the 7 AM sync. Never touches Airtable.
- Shows auto-archive 7 days after Timeline End.

## Layout: the Brief (r10, 2026-10-08)

The home view (`selectedId === "radar"`) is the Brief: a headline ("N things need you."), one line of context, and only the red (sev 3) items. Everything else is a closed row with a one-line summary, built with `acc(id, label, summary, body)`; open state is remembered per device in `localStorage ui_open`. Show pages follow the same pattern (status sentence, red items, dates, links, then rows). On a phone the sidebar is hidden and the show list sits inside the Brief. Rule for changes: new information gets a row and a summary, not a spot on the first screen. Details: `ARCHITECTURE.md` in the docs folder.

## Remote oversight override (r10.1, 2026-10-08)

Travel vs Remote comes from the crew list (Iq in EventPositions = Travel). `REMOTE_OVERRIDE` in `index.html` lists event IDs where Iq is remote even though Airtable still lists him. Currently: `recaVfmNbH94gsnYE` (JM Vertex @ ASN 2026). Dashboard only; Airtable is not changed. Remove the ID once his position is deleted in Airtable.

## Radar (added 2026-10-08, r9)

Radar is the home view (first row of the list; `selectedId === "radar"`). It is computed in the browser on every load by `computeRadar()`. Nothing is baked in and nothing is written by it.

- **Second-pass reads** (`loadRadar()`, runs after the page has painted; each one fails on its own without breaking the page):
  - Events by `RECORD_ID()`: `Event Type`, `LoadIn Check` / `LoadOut Check` / `ShipDate Check`, `RWSynced LoadInDate` / `LoadOutDate` / `ShipDate` / `Status`, `Drawing Needed`, `Drawing Status`, `loadCalcsNeeded`, `Rigging Needed`, `Infodoc Email Sent`.
  - Tasks `tbl5RQ4eWcGKrwNDR`: open tasks with a Due Status, assigned to Iq (`FIND('Iqral',{Assignee}&'')`).
  - EventPositions for every non-Staff crew member on a still-running show, `Timeline End` from yesterday on. This is how cross-show double-bookings, Away blocks and Iq's own whereabouts are found. Cancelled event types and Empty positions are ignored.
  - `GET /radar` on the worker (analyst catches, see below).
- **Rules** (sev 3 = needs action, 2 = watch, 1 = FYI): booth ship within `URGENT_DAYS`; Airtable vs RentalWorks date mismatch; crew pencilled / not confirmed / Empty; crew double-booked, away, or on a same-day turnaround; ship / prep / load-in landing while Iq is Away; no flight-hotel note within 14 days of travel; "NO prep booked" notes; show not Confirmed with crew confirmed; no booth number; Show Start equal to Load-in; drawing not Done; InfoDoc email not sent within 10 days of travel; email gap after a real thread; tasks past due or due this week; Granola `dateFlags`; analyst catches.
- **Resolve / Snooze / In progress** (r11): every flag has these three actions. State is kept per flag key in `localStorage flag_state` and mirrored to the worker (`GET/POST /flags`, KV `DASH_NOTES` key `flags_index`, merge per key, newest wins) so phone and laptop agree. Keys include the underlying values, so a resolved flag comes back if its facts change. A note typed under In progress is appended to the show's `PM Notes` in Airtable (Iq's own tap; the field is re-read first). Details: `RADAR.md` in the docs folder.
- **Run of show** and **Next 14 days** are drawn from the same data. Iq's lane comes from his EventPositions, including Away.
- **Analyst catches**: `POST /radar?key=<PIN>` with `{"generatedAt":"<ISO>","items":[{"id","showId","sev":1-3,"title","detail","src","when":"YYYY-MM-DD","expires":"YYYY-MM-DD"}]}` stores judgement-call catches in KV (`DASH_NOTES` key `radar_index`). Write it the same way the Granola sync writes `/notes` (from the open dashboard tab, using the PIN in localStorage). Always set `expires`. Never touches Airtable.
- Cache: `localStorage dash_radar` gives an instant paint on reopen, same as `dash_cache`.

## My tasks (added 2026-10-08, r9)

Each show has a "My tasks" panel (lazy-loaded). Tapping a circle sets Task Status to one of `Not Started | In Process | Done | Not Needed`; "Mark all done" on a group takes two taps. These are Iq's own taps and PATCH the Tasks table through the worker, same path as PM Notes. Claude never calls these writes.

## Deploy — only when page or worker code changes

Iq runs `bash ~/show-dashboard-test/push-dashboard.sh` in Terminal, then Cmd+Shift+R in the browser.

In order: (1) validates `index.html` — size 15–300 KB; required tokens `fuse-dashboard-proxy`, `async function loadAll`, `function renderDetail`, `function renderList`, `function buildModel`, `function computeRadar`, `async function toggleMail`, `function tryPin`, `pinGate`, `dash_pin`, `viwT3CcaSHtTVAZBi`; no hardcoded `Updated:` date; `node --check` on the inline script — exits on any failure; (2) copies to `public/`; (3) `npx wrangler deploy` (if it asks to log in: `npx wrangler login`); (4) best-effort `git push origin main` as backup — failures there are non-critical.

Repo backup: `iqlarode-wq/show-dashboard`. The GitHub Pages URL (`iqlarode-wq.github.io/show-dashboard/`) is **not** the live site.

## PIN

Enforced via the `DASH_PIN` secret on the worker. To rotate: `npx wrangler secret put DASH_PIN` from this folder (or Cloudflare dash → Workers & Pages → fuse-dashboard-proxy → Settings → Variables and Secrets). Users re-enter once per device.

## Day-to-day

Nothing. Open the URL — it's always current. ↻ re-pulls; the page also auto-refreshes when you return after 10+ minutes away.
