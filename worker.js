// Cloudflare Worker — Airtable API Proxy for Show Operations Dashboard
// Keeps the Airtable PAT server-side. Dashboard never sees the token.
//
// Environment variables / secrets:
//   AIRTABLE_PAT — Airtable personal access token (existing)
//   DASH_PIN     — shared PIN; every request must include ?key=<PIN>.
//                  If DASH_PIN is not set, requests are allowed (pre-migration mode).
// KV Namespaces: TEMP_FILES (for temporary file upload storage)
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
