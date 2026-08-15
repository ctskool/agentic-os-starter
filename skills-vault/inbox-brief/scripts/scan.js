// scan.js — fetches Gmail inbox for the last N hours and emits NDJSON metadata per message.
// Includes thread state: did Chase already reply in this thread, how many messages in thread.
//
// Usage: node scan.js [--hours 24] [--config ../config.json]
// Output: NDJSON to stdout, one message per line.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function parseArgs() {
  const out = { hours: null, config: path.join(__dirname, '..', 'config.json') };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--hours') out.hours = Number(process.argv[++i]);
    else if (a === '--config') out.config = process.argv[++i];
  }
  return out;
}

function loadConfig(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function getAccessToken() {
  const credsRaw = execSync('bash -c "gws auth export --unmasked 2>/dev/null"', { encoding: 'utf8' });
  const creds = JSON.parse(credsRaw.slice(credsRaw.indexOf('{')));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('token exchange: ' + res.status);
  return (await res.json()).access_token;
}

async function gApi(token, url) {
  const res = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('GET ' + url + ' -> ' + res.status + ' ' + await res.text());
  return await res.json();
}

function parseHeaders(m) {
  return (m.payload?.headers || []).reduce((a, h) => { a[h.name] = h.value; return a; }, {});
}

async function main() {
  const args = parseArgs();
  const cfg = loadConfig(args.config);
  const hours = args.hours || cfg.lookbackHours || 24;
  const myEmail = cfg.email.toLowerCase();

  const days = Math.max(1, Math.ceil(hours / 24));
  const nowMs = Date.now();
  const cutoffMs = nowMs - hours * 60 * 60 * 1000;

  const token = await getAccessToken();
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`newer_than:${days}d in:inbox`)}&maxResults=250`;
  const listRes = await gApi(token, listUrl);
  const ids = (listRes.messages || []).map(m => m.id);

  const threadCache = new Map();
  let emitted = 0;

  for (const id of ids) {
    const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID&metadataHeaders=List-Unsubscribe&metadataHeaders=To`;
    const m = await gApi(token, msgUrl);

    const internal = Number(m.internalDate || 0);
    if (internal < cutoffMs) continue;

    const h = parseHeaders(m);

    if (!threadCache.has(m.threadId)) {
      const tUrl = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${m.threadId}?format=metadata&metadataHeaders=From`;
      const t = await gApi(token, tUrl);
      const chaseReplied = (t.messages || []).some(tm => {
        const th = parseHeaders(tm);
        const fromLower = (th.From || '').toLowerCase();
        const labels = new Set(tm.labelIds || []);
        return fromLower.includes(myEmail) || labels.has('SENT');
      });
      threadCache.set(m.threadId, { length: (t.messages || []).length, chaseReplied });
    }
    const threadState = threadCache.get(m.threadId);

    const record = {
      id: m.id,
      threadId: m.threadId,
      internalDate: internal,
      dateIso: new Date(internal).toISOString(),
      from: h.From || '',
      to: h.To || '',
      subject: h.Subject || '',
      snippet: m.snippet || '',
      messageIdHeader: h['Message-ID'] || h['Message-Id'] || '',
      listUnsub: !!h['List-Unsubscribe'],
      labels: m.labelIds || [],
      threadLength: threadState.length,
      chaseReplied: threadState.chaseReplied,
    };
    process.stdout.write(JSON.stringify(record) + '\n');
    emitted++;
  }

  process.stderr.write(`scanned ${ids.length} messages, emitted ${emitted} within ${hours}h window\n`);
}

main().catch(e => {
  process.stderr.write('ERROR: ' + (e.stack || e.message) + '\n');
  process.exit(1);
});
