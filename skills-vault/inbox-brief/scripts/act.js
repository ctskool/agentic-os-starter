// act.js — given a list of Gmail message IDs, builds reply MIME with media kit attached
// and either saves as drafts or sends immediately.
//
// Usage:
//   node act.js --action draft --ids id1,id2,id3
//   node act.js --action send  --ids id1,id2,id3
// Optional: --config ../config.json --hint-names "id1:Name1,id2:Name2"

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function parseArgs() {
  const out = { action: null, ids: [], config: path.join(__dirname, '..', 'config.json'), hintNames: {} };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--action') out.action = process.argv[++i];
    else if (a === '--ids') out.ids = process.argv[++i].split(',').filter(Boolean);
    else if (a === '--config') out.config = process.argv[++i];
    else if (a === '--hint-names') {
      const pairs = process.argv[++i].split(',').filter(Boolean);
      for (const p of pairs) {
        const [id, name] = p.split(':');
        if (id && name) out.hintNames[id] = name;
      }
    }
  }
  if (!['draft', 'send'].includes(out.action)) throw new Error('--action must be draft or send');
  if (!out.ids.length) throw new Error('--ids required');
  return out;
}

function loadConfig(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function parseHeaders(m) {
  return (m.payload?.headers || []).reduce((a, h) => { a[h.name] = h.value; return a; }, {});
}

function extractFirstName(fromHeader) {
  if (!fromHeader) return 'there';
  const nameMatch = fromHeader.match(/^"?([^"<]+?)"?\s*<([^>]+)>/);
  let display = nameMatch ? nameMatch[1].trim() : fromHeader.trim();
  if (display.includes('@')) display = display.split('@')[0];
  const generic = /^(team|admin|support|contact|sales|business|bussiness|partnerships|creators?|collaboration|info|hello|hi|no-?reply|notifications?|content|influencers?)$/i;
  const first = display.split(/\s+/)[0].replace(/[,.!].*$/, '');
  if (generic.test(first)) return 'there';
  if (/^[A-Za-z][A-Za-z'\-]{1,}$/.test(first)) {
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }
  return 'there';
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

async function getMessage(token, id) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`;
  const res = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('GET message ' + id + ' -> ' + res.status);
  return await res.json();
}

function buildMime({ cfg, to, subject, firstName, inReplyTo }) {
  const body = cfg.templateBody.replace(/\$\{firstName\}/g, firstName);
  const subjectFull = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
  const encodedSubject = /[^\x00-\x7F]/.test(subjectFull)
    ? `=?UTF-8?B?${Buffer.from(subjectFull, 'utf8').toString('base64')}?=`
    : subjectFull;

  const boundary = '===' + Math.random().toString(36).slice(2) + '===';
  const pdf = fs.readFileSync(cfg.mediaKitPath);
  const pdfB64 = pdf.toString('base64').replace(/(.{76})/g, '$1\r\n');
  const attachFilename = path.basename(cfg.mediaKitPath);
  const fromHeader = `"${cfg.fromName}" <${cfg.email}>`;

  const mime = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${inReplyTo}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${attachFilename}"`,
    `Content-Disposition: attachment; filename="${attachFilename}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    pdfB64,
    `--${boundary}--`,
  ].join('\r\n');

  return Buffer.from(mime, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function postGmail(token, endpoint, bodyObj) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${endpoint}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs();
  const cfg = loadConfig(args.config);
  const token = await getAccessToken();

  const results = [];
  for (const id of args.ids) {
    try {
      const m = await getMessage(token, id);
      const h = parseHeaders(m);
      const firstName = args.hintNames[id] || extractFirstName(h.From);
      const raw = buildMime({
        cfg,
        to: h.From,
        subject: h.Subject || '',
        firstName,
        inReplyTo: h['Message-ID'] || h['Message-Id'] || '',
      });

      let resp;
      if (args.action === 'draft') {
        resp = await postGmail(token, 'drafts', { message: { raw, threadId: m.threadId } });
        results.push({ id, action: 'draft', draftId: resp.id, to: h.From, firstName });
      } else {
        resp = await postGmail(token, 'messages/send', { raw, threadId: m.threadId });
        results.push({ id, action: 'send', messageId: resp.id, to: h.From, firstName });
      }
      process.stderr.write(`  ✓ ${args.action} [${firstName}] ${h.From.slice(0, 50)}\n`);
    } catch (e) {
      results.push({ id, action: args.action, error: e.message });
      process.stderr.write(`  ✗ ${id}: ${e.message}\n`);
    }
  }

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
}

main().catch(e => {
  process.stderr.write('ERROR: ' + (e.stack || e.message) + '\n');
  process.exit(1);
});
