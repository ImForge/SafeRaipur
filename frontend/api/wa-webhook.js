// ============================================================================
// SafeRaipur — WhatsApp webhook  (Vercel serverless function)
// Route: https://<your-app>.vercel.app/api/wa-webhook
// ============================================================================
// This is the ONLY piece of the WhatsApp cascade that lives outside Postgres.
// Meta calls it with delivery receipts (sent/delivered/read) and inbound
// messages (the "I'm responding" button taps). It does two jobs:
//
//   GET  → the one-time verification handshake Meta requires when you save
//          the webhook URL (echoes hub.challenge if the verify token matches).
//   POST → verifies Meta's X-Hub-Signature-256 (HMAC-SHA256 of the raw body
//          with your App Secret), then forwards the payload UNCHANGED to the
//          wa_ingest() RPC, guarded by a second shared secret.
//
// Why verify the signature: without it, anyone who learns this URL could POST
// fake "delivered" receipts or fake acks and quietly halt a real emergency
// (SECURITY_AUDIT.md, "webhook forgery"). We trust NOTHING that Meta didn't
// sign.
//
// Env vars to set in Vercel (Project → Settings → Environment Variables):
//   WA_VERIFY_TOKEN     the string you invented and pasted into Meta's form
//   WA_APP_SECRET       Meta App dashboard → Settings → Basic → App Secret
//   WA_INGEST_SECRET    must equal guardian_config.wa_ingest_secret in the DB
//   SUPABASE_URL        https://xxxx.supabase.co
//   SUPABASE_ANON_KEY   your anon key (wa_ingest is granted to anon)
//
// IMPORTANT: this function needs the RAW request body to check the signature,
// so Vercel's automatic body parsing is disabled below. Do not remove that.
// ============================================================================

import crypto from 'node:crypto';

export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// timing-safe compare of the Meta signature against our own HMAC
function signatureValid(rawBuf, header, appSecret) {
  if (!header || !appSecret) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(rawBuf)
    .digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  // ---- GET: Meta's subscription verification handshake ----
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // ---- POST: a real event from Meta ----
  const raw = await readRaw(req);

  if (!signatureValid(raw, req.headers['x-hub-signature-256'], process.env.WA_APP_SECRET)) {
    // Someone POSTed without a valid Meta signature. Refuse — and tell Meta
    // 200 anyway so a genuinely misconfigured secret doesn't make Meta retry
    // forever; the refusal is logged, not silently swallowed.
    console.warn('wa-webhook: bad or missing signature — ignoring payload');
    return res.status(200).json({ ok: false, reason: 'bad signature' });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(200).json({ ok: false, reason: 'unparseable body' });
  }

  // forward the verified payload to the database, which does all the work
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/wa_ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: process.env.SUPABASE_ANON_KEY,
        authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        p_secret: process.env.WA_INGEST_SECRET,
        p_payload: payload,
      }),
    });
    const data = await r.json().catch(() => null);
    // Always 200 to Meta on a delivered-and-processed event; Meta retries on
    // non-2xx, and we don't want retries for something we've already ingested.
    return res.status(200).json({ ok: true, ingest: data });
  } catch (e) {
    console.error('wa-webhook: ingest failed', e);
    // 200 so Meta doesn't hammer retries; our own logs carry the failure.
    return res.status(200).json({ ok: false, reason: 'ingest error' });
  }
}
