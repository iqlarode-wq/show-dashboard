// Cloudflare Worker — Airtable API Proxy for Show Operations Dashboard
// Keeps the Airtable PAT server-side. Dashboard never sees the token.
//
// Environment variables / secrets:
//   AIRTABLE_PAT — Airtable personal access token (existing)
//   DASH_PIN     — shared PIN; every request must include ?key=<PIN>.
//                  If DASH_PIN is not set, requests are allowed (pre-migration mode).
// KV Namespaces: TEMP_FILES (temporary file upload storage), DASH_NOTES (Granola notes, Radar analyst catches, flag state)
// Secrets: AIRTABLE_PAT, DASH_PIN, INFODOC_FLOW_URL (r14, the Power Automate URL the InfoDoc button posts to), optional INFODOC_FROM
//
// Deploy: npx wrangler deploy   (then: npx wrangler secret put DASH_PIN)
// Or paste this file into the Cloudflare dashboard editor and add the
// DASH_PIN secret under Settings → Variables and Secrets.

const ALLOWED_ORIGINS = [
  'https://iqlarode-wq.github.io',
  'http://localhost',
  'null',      // file:// pages send Origin: null — allows local testing
  'file://'
];

const ALLOWED_BASE = 'appcbc1CDJKyKb8db';
const FILES_TABLE = 'tblivTW2lEP56DiuQ';

function corsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.find(o => origin && origin.startsWith(o));
  return {
    'Access-Control-Allow-Origin': allowedOrigin || ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ═══ PIN check ═══
// Every route except /tmp/* (Airtable's own servers download from there,
// protected by unguessable random UUIDs + 5-min expiry) requires ?key=PIN.
function pinOk(url, env) {
  if (!env.DASH_PIN) return true; // secret not configured yet — allow
  return url.searchParams.get('key') === env.DASH_PIN;
}

function unauthorized(cors) {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401, headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

// ═══ File upload handler ═══
async function handleUpload(request, env, cors) {
  const url = new URL(request.url);
  const eventId = url.searchParams.get('eventId');
  if (!eventId) {
    return new Response(JSON.stringify({ error: 'Missing eventId' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  const formData = await request.formData();
  const file = formData.get('file');
  if (!file) {
    return new Response(JSON.stringify({ error: 'No file provided' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  const fileName = file.name || 'uploaded-file';
  const fileType = file.type || 'application/octet-stream';

  const fileKey = crypto.randomUUID();
  const fileBytes = await file.arrayBuffer();
  await env.TEMP_FILES.put(fileKey, fileBytes, {
    expirationTtl: 300,
    metadata: { fileName, fileType }
  });

  const workerUrl = new URL(request.url).origin;
  const fileUrl = workerUrl + '/tmp/' + fileKey;

  const createRes = await fetch('https://api.airtable.com/v0/' + ALLOWED_BASE + '/' + FILES_TABLE, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.AIRTABLE_PAT,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      records: [{
        fields: {
          'Name': fileName,
          'Events': [eventId],
          'File': [{ url: fileUrl, filename: fileName }]
        }
      }]
    })
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    await env.TEMP_FILES.delete(fileKey);
    return new Response(JSON.stringify({ error: 'Failed to create record', detail: err }), {
      status: createRes.status, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  const createData = await createRes.json();

  return new Response(JSON.stringify({
    success: true,
    recordId: createData.records[0].id,
    fileName: fileName
  }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

// ═══ Serve temporary files (for Airtable to download) ═══
async function handleTmpFile(fileKey, env, cors) {
  const { value, metadata } = await env.TEMP_FILES.getWithMetadata(fileKey, { type: 'arrayBuffer' });
  if (!value) {
    return new Response('File not found or expired', { status: 404, headers: cors });
  }

  return new Response(value, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': metadata?.fileType || 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="' + (metadata?.fileName || 'file') + '"',
    }
  });
}

// ═══ InfoDoc helpers (r14) ═══
const EVENTS_TABLE = 'tblno1XUMyyVeA2z6';
const POSITIONS_TABLE = 'tblloB4sAREi8YqrC';
const INFODOC_TABLE = 'tbl67bphejzbs8STq';
const INFODOC_FROM_DEFAULT = 'ilarode@fuse-tg.com';
const COMPOSE_WAIT_MS = 25000;   // how long to wait for Airtable's automation to fill Subject/Body/To

const first = v => Array.isArray(v) ? v[0] : v;
const qs = o => Object.entries(o).map(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => encodeURIComponent(k) + '=' + encodeURIComponent(x)).join('&')).join('&');
function fail(msg, status, blocks) { const e = new Error(msg); e.status = status || 400; if (blocks) e.blocks = blocks; return e; }

// Airtable REST, same token the proxy uses. Throws with Airtable's own message.
async function at(env, path, init) {
  const r = await fetch('https://api.airtable.com/v0/' + ALLOWED_BASE + path, Object.assign({ headers: { 'Authorization': 'Bearer ' + env.AIRTABLE_PAT, 'Content-Type': 'application/json' } }, init || {}));
  let j = null; try { j = await r.json(); } catch (e) { j = {}; }
  if (!r.ok || (j && j.error)) throw fail((j && j.error && (j.error.message || j.error.type)) || ('Airtable ' + r.status), 502);
  return j;
}

// What has to be true before an InfoDoc goes out. Computed here, from Airtable, regardless of what the page showed.
async function infodocPreflight(env, eventId) {
  const ev = await at(env, '/' + EVENTS_TABLE + '/' + eventId);
  const f = ev.fields || {};
  const pos = (await at(env, '/' + POSITIONS_TABLE + '?' + qs({ filterByFormula: `FIND('${eventId}',ARRAYJOIN({id (from Event)}))`, 'fields[]': ['Name (from Crew)', 'Email (from Crew)', 'Status', 'Short Name (from Roles)'] }))).records || [];
  const files = (await at(env, '/' + FILES_TABLE + '?' + qs({ filterByFormula: `FIND('${eventId}',ARRAYJOIN({id (from Events)}))`, 'fields[]': ['Name', 'File', 'Link'], maxRecords: 100 }))).records || [];
  const crew = pos.map(p => {
    const pf = p.fields || {}, role = first(pf['Short Name (from Roles)']) || '';
    return { name: String(first(pf['Name (from Crew)']) || '').replace(/^\*/, '').trim(), email: String(first(pf['Email (from Crew)']) || '').trim(), status: String(pf['Status'] || '').trim(), role, staff: role === 'Staff' };
  });
  const real = crew.filter(c => !c.staff && !/^away$/i.test(c.status));
  const empty = real.filter(c => !c.name || /^empty$/i.test(c.status));
  const pencilled = real.filter(c => c.name && /pencil/i.test(c.status));
  const noEmail = real.filter(c => c.name && !/^empty$/i.test(c.status) && !c.email);
  const nFiles = files.filter(r => (r.fields.File || []).length).length;
  const checks = [
    { id: 'binder', ok: !!f['AV Binder Live Link'], label: 'AV Binder link', detail: f['AV Binder Live Link'] ? 'linked' : 'missing — add it on the show page', hard: true },
    { id: 'files', ok: nFiles > 0, label: 'Files for the crew', detail: nFiles ? `${nFiles} file${nFiles === 1 ? '' : 's'}` : 'none uploaded — gear list, drawings', hard: true },
    { id: 'link', ok: !!f['infoDocs link'], label: 'InfoDoc link', detail: f['infoDocs link'] ? 'present' : 'missing on the Events record', hard: true },
    { id: 'crew', ok: real.length - empty.length > 0, label: 'Crew assigned', detail: real.length - empty.length ? `${real.length - empty.length} on the email` : 'no crew on this show', hard: true },
    { id: 'email', ok: !noEmail.length, label: 'Crew emails', detail: noEmail.length ? `${noEmail.length} without an email: ${noEmail.map(c => c.name).join(', ')}` : 'all present', hard: true },
    { id: 'empty', ok: !empty.length, label: 'Open positions', detail: empty.length ? `${empty.length} still Empty` : 'none', hard: true },
    { id: 'pencilled', ok: !pencilled.length, label: 'Pencilled crew', detail: pencilled.length ? pencilled.map(c => c.name).join(', ') + ' not confirmed' : 'all confirmed', hard: true },
    { id: 'sent', ok: !f['Infodoc Email Sent'], label: 'Not sent yet', detail: f['Infodoc Email Sent'] ? 'already sent — sending again goes to everyone again' : 'not sent', hard: false },
    { id: 'drawing', ok: !f['Drawing Needed'] || /^done$/i.test(String(f['Drawing Status'] || '')), label: 'Drawing', detail: f['Drawing Needed'] ? String(f['Drawing Status'] || 'not started').toLowerCase() : 'not needed', hard: false },
    { id: 'booth', ok: !!f['Booth Number'] && !/tbd/i.test(String(f['Booth Number'])), label: 'Booth number', detail: f['Booth Number'] || 'TBD', hard: false }
  ];
  return { name: f['Name'] || '', checks, blocks: checks.filter(c => c.hard && !c.ok).map(c => c.label), alreadySent: !!f['Infodoc Email Sent'], existing: f['Send Infodoc Email'] || [], recipients: real.filter(c => c.email && c.name && !/^empty$/i.test(c.status)).map(c => c.email) };
}

// Read-only: the checklist plus what has been sent before. Creates nothing.
async function infodocStatus(env, eventId) {
  const pre = await infodocPreflight(env, eventId);
  let history = [];
  if (pre.existing.length) {
    const got = (await at(env, '/' + INFODOC_TABLE + '?' + qs({ filterByFormula: 'OR(' + pre.existing.map(id => `RECORD_ID()='${id}'`).join(',') + ')', 'fields[]': ['Subject', 'Email Sent', 'Email To', 'Created date', 'Created By'] }))).records || [];
    history = got.map(r => ({ id: r.id, sent: !!r.fields['Email Sent'], to: r.fields['Email To'] || '', at: r.fields['Created date'] || r.createdTime || '', by: (r.fields['Created By'] && r.fields['Created By'].name) || '' })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  return { name: pre.name, checks: pre.checks, blocks: pre.blocks, alreadySent: pre.alreadySent, recipients: pre.recipients, history, configured: !!env.INFODOC_FLOW_URL };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const composed = r => !!(r && r.fields && r.fields['Subject'] && r.fields['Message Body'] && r.fields['Email To']);
const draftOf = (r, pre) => ({ recordId: r.id, to: r.fields['Email To'] || '', cc: r.fields['Email CC'] || '', from: r.fields['Email From'] || '', subject: r.fields['Subject'] || '', body: r.fields['Message Body'] || '', sent: !!r.fields['Email Sent'], preflight: pre });

// Reuse an unsent record for this show if there is one; otherwise create one and let Airtable compose it.
async function infodocPrepare(env, eventId, force) {
  const pre = await infodocPreflight(env, eventId);
  if (pre.blocks.length) throw fail('Not ready to send: ' + pre.blocks.join(', '), 409, pre.checks);
  if (pre.alreadySent && !force) throw fail('InfoDoc already sent for this show. Send again only on purpose.', 409, pre.checks);
  let rec = null;
  if (pre.existing.length) {
    const got = (await at(env, '/' + INFODOC_TABLE + '?' + qs({ filterByFormula: 'OR(' + pre.existing.map(id => `RECORD_ID()='${id}'`).join(',') + ')', 'fields[]': ['Subject', 'Message Body', 'Email To', 'Email CC', 'Email From', 'Email Sent', 'Event'] }))).records || [];
    rec = got.find(r => !r.fields['Email Sent']) || null;
  }
  let created = false;
  if (!rec) {
    rec = await at(env, '/' + INFODOC_TABLE, { method: 'POST', body: JSON.stringify({ fields: { 'Event': [eventId] } }) });
    created = true;
  }
  // Airtable's "InfoDoc Create Email" automation fills Subject / Body / To / CC within a few seconds.
  const t0 = Date.now();
  while (!composed(rec) && Date.now() - t0 < COMPOSE_WAIT_MS) {
    await sleep(1500);
    rec = await at(env, '/' + INFODOC_TABLE + '/' + rec.id);
  }
  if (!composed(rec)) throw fail('Airtable did not compose the email in time (record ' + rec.id + ' is there, nothing was sent). Try Prepare again in a minute.', 504);
  return Object.assign(draftOf(rec, pre.checks), { created, recipients: pre.recipients });
}

// Send exactly what the record holds, the way the Airtable button does. Marks sent only after the flow said yes.
async function infodocSend(env, eventId, recordId, test) {
  if (!env.INFODOC_FLOW_URL) throw fail('The send flow is not configured on the worker (INFODOC_FLOW_URL secret).', 503);
  const from = env.INFODOC_FROM || INFODOC_FROM_DEFAULT;
  const rec = await at(env, '/' + INFODOC_TABLE + '/' + recordId);
  const f = rec.fields || {};
  if (!(f['Event'] || []).includes(eventId)) throw fail('That email record belongs to a different show.', 409);
  if (!composed(rec)) throw fail('The email record is not composed yet.', 409);
  if (f['Email Sent'] && !test) throw fail('This email record was already sent. Prepare again to send a new one.', 409);
  const clean = v => { const seen = new Set(); return String(v || '').split(',').map(x => x.trim()).filter(x => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).join(', '); };
  const to = test ? from : clean(f['Email To']);
  const cc = test ? '' : clean(f['Email CC']);
  if (!to) throw fail('No recipients on the email record.', 409);
  const subject = (test ? 'TEST — ' : '') + String(f['Subject'] || '');
  const payload = { To: to, cc: cc, From: from, Subject: subject, Body: String(f['Message Body'] || ''), Attachments: [[]], AttachmentName: [] };
  const r = await fetch(env.INFODOC_FLOW_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await r.text().catch(() => '');
  if (!r.ok) throw fail('The send flow refused the email (HTTP ' + r.status + (text ? ': ' + text.slice(0, 200) : '') + '). Nothing was marked sent.', 502);
  if (test) return { ok: true, test: true, to, subject, flowStatus: r.status };
  await at(env, '/' + INFODOC_TABLE + '/' + recordId, { method: 'PATCH', body: JSON.stringify({ fields: { 'Email Sent': true } }) });
  await at(env, '/' + EVENTS_TABLE + '/' + eventId, { method: 'PATCH', body: JSON.stringify({ fields: { 'Infodoc Email Sent': true } }) });
  return { ok: true, test: false, to, cc, subject, flowStatus: r.status, sentAt: new Date().toISOString() };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);

      // ═══ Temporary file serving (Airtable downloads from here — no PIN) ═══
      if (url.pathname.startsWith('/tmp/') && request.method === 'GET') {
        const fileKey = url.pathname.replace('/tmp/', '');
        return await handleTmpFile(fileKey, env, cors);
      }

      // ═══ Everything else requires the PIN ═══
      if (!pinOk(url, env)) {
        return unauthorized(cors);
      }

      // ═══ Upload route ═══
      if (url.pathname === '/upload' && request.method === 'POST') {
        return await handleUpload(request, env, cors);
      }

      // ═══ Granola notes: GET reads the synced blob, POST stores it ═══
      // The daily sync (Claude session) POSTs matched notes here; the
      // dashboard GETs them. Personal to Iq — nothing touches Airtable.
      if (url.pathname === '/notes') {
        if (request.method === 'GET') {
          const blob = await env.DASH_NOTES.get('notes_index');
          return new Response(blob || '{"generatedAt":null,"shows":{},"unmatched":[]}', {
            status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
        if (request.method === 'POST') {
          const body = await request.text();
          try { JSON.parse(body); } catch (e) {
            return new Response(JSON.stringify({ error: 'invalid JSON' }), {
              status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
            });
          }
          await env.DASH_NOTES.put('notes_index', body);
          return new Response(JSON.stringify({ success: true, bytes: body.length }), {
            status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      // ═══ Radar analyst catches: GET reads the blob, POST stores it ═══
      // Judgement-call catches written by a Claude run (things only reading the email
      // trail / calendar reveals). The page merges them with its own live checks.
      // Personal to Iq — nothing touches Airtable.
      if (url.pathname === '/radar') {
        if (request.method === 'GET') {
          const blob = await env.DASH_NOTES.get('radar_index');
          return new Response(blob || '{"generatedAt":null,"items":[]}', {
            status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
        if (request.method === 'POST') {
          const body = await request.text();
          let parsed;
          try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
          if (!parsed || !Array.isArray(parsed.items)) {
            return new Response(JSON.stringify({ error: 'expected JSON with an items array' }), {
              status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
            });
          }
          await env.DASH_NOTES.put('radar_index', body);
          return new Response(JSON.stringify({ success: true, items: parsed.items.length }), {
            status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      // ═══ Flag state: what Iq did about each dashboard flag (resolved / snoozed / in progress + notes) ═══
      // GET returns the whole map. POST {items:{key:entry}} merges per key, newest `t` wins, so
      // phone and laptop can both write without clobbering each other. Nothing touches Airtable.
      if (url.pathname === '/flags') {
        const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { ...cors, 'Content-Type': 'application/json' } });
        let cur;
        try { cur = JSON.parse((await env.DASH_NOTES.get('flags_index')) || '{}'); } catch (e) { cur = {}; }
        if (!cur || typeof cur.items !== 'object' || !cur.items) cur = { items: {} };
        if (request.method === 'GET') return json(cur);
        if (request.method === 'POST') {
          const body = await request.text();
          if (body.length > 200000) return json({ error: 'too large' }, 413);
          let parsed;
          try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
          if (!parsed || typeof parsed.items !== 'object' || !parsed.items || Array.isArray(parsed.items)) {
            return json({ error: 'expected JSON with an items object' }, 400);
          }
          const ok = ['resolved', 'snoozed', 'progress', 'open'];
          for (const [k, v] of Object.entries(parsed.items)) {
            if (k.length > 400 || !v || typeof v !== 'object' || typeof v.t !== 'number' || !ok.includes(v.st)) continue;
            if (!cur.items[k] || v.t > (cur.items[k].t || 0)) cur.items[k] = v;
          }
          const cutoff = Date.now() - 180 * 86400000;   // forget choices untouched for six months
          for (const k of Object.keys(cur.items)) if ((cur.items[k].t || 0) < cutoff) delete cur.items[k];
          cur.updatedAt = new Date().toISOString();
          await env.DASH_NOTES.put('flags_index', JSON.stringify(cur));
          return json(cur);
        }
        return json({ error: 'Method not allowed' }, 405);
      }

      // ═══ InfoDoc (r14): prepare and send the PM InfoDoc email from the dashboard ═══
      // Mirrors the Airtable interface flow step for step: a record in "Send Infodoc Email" (Airtable's
      // own "InfoDoc Create Email" automation composes To/CC/Subject/Body), then the same POST to the
      // Power Automate flow that the "InfoDoc Send Email" button makes, then Email Sent on the record
      // and Infodoc Email Sent on the Event — only after the flow accepted the message.
      // The flow URL lives only in the INFODOC_FLOW_URL secret. From is always INFODOC_FROM (Iq).
      // test=1 sends To/CC = Iq only with a TEST subject and marks nothing in Airtable.
      if (url.pathname === '/infodoc/status' || url.pathname === '/infodoc/prepare' || url.pathname === '/infodoc/send') {
        const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { ...cors, 'Content-Type': 'application/json' } });
        const wantGet = url.pathname === '/infodoc/status';
        if (request.method !== (wantGet ? 'GET' : 'POST')) return json({ error: 'Method not allowed' }, 405);
        const eventId = url.searchParams.get('eventId') || '';
        if (!/^rec[A-Za-z0-9]{14}$/.test(eventId)) return json({ error: 'missing or invalid eventId' }, 400);
        try {
          if (wantGet) return json(await infodocStatus(env, eventId));
          if (url.pathname === '/infodoc/prepare') return json(await infodocPrepare(env, eventId, url.searchParams.get('force') === '1'));
          const recordId = url.searchParams.get('recordId') || '';
          if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) return json({ error: 'missing or invalid recordId' }, 400);
          return json(await infodocSend(env, eventId, recordId, url.searchParams.get('test') === '1'));
        } catch (e) {
          return json({ error: e.message, blocks: e.blocks || undefined }, e.status || 500);
        }
      }

      // ═══ Delete a file record (Files table ONLY — cannot touch any other table) ═══
      if (url.pathname === '/delete-file' && request.method === 'POST') {
        const id = url.searchParams.get('id');
        if (!id || !/^rec[A-Za-z0-9]{14}$/.test(id)) {
          return new Response(JSON.stringify({ error: 'missing or invalid record id' }), {
            status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
        const delRes = await fetch('https://api.airtable.com/v0/' + ALLOWED_BASE + '/' + FILES_TABLE + '/' + id, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + env.AIRTABLE_PAT }
        });
        const delBody = await delRes.text();
        return new Response(delBody, {
          status: delRes.status, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      // ═══ Standard Airtable proxy ═══
      const airtablePath = url.pathname;

      if (!airtablePath.startsWith('/v0/' + ALLOWED_BASE)) {
        return new Response(JSON.stringify({ error: 'Forbidden: invalid base' }), {
          status: 403, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      if (!['GET', 'POST', 'PATCH'].includes(request.method)) {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      // Strip the PIN before forwarding to Airtable
      url.searchParams.delete('key');
      const airtableUrl = 'https://api.airtable.com' + airtablePath + url.search;
      const headers = {
        'Authorization': 'Bearer ' + env.AIRTABLE_PAT,
        'Content-Type': 'application/json',
      };

      const fetchOptions = { method: request.method, headers };
      if (request.method === 'POST' || request.method === 'PATCH') {
        fetchOptions.body = await request.text();
      }

      const response = await fetch(airtableUrl, fetchOptions);
      const body = await response.text();

      return new Response(body, {
        status: response.status,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }
};
