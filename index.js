<!-- =========================================
File: C:\Users\zacka\autopitch-ai\public\success.html
========================================= -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Payment Successful – AutoPitch AI</title>
    <style>
      :root { --bg:#0b0f19; --card:#121725; --text:#eef1f6; --muted:#9aa4b2; --brand:#6aa6ff; }
      body { background: var(--bg); color: var(--text); font-family: system-ui, Arial, sans-serif; margin:0; display:grid; place-items:center; min-height:100vh; padding:16px; }
      .box { background: var(--card); border: 1px solid #222940; border-radius: 14px; padding: 24px; max-width: 560px; text-align:center; }
      .muted { color: var(--muted); }
      a.btn { display:inline-block; margin-top:16px; padding:12px 16px; background:var(--brand); color:#0b0f19; text-decoration:none; border-radius:10px; font-weight:700; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>✅ Payment Successful</h1>
      <p class="muted" id="plan">You're all set. Thanks for upgrading!</p>
      <a href="/" class="btn">Back to AutoPitch</a>
    </div>
    <script>
      const p = new URLSearchParams(location.search);
      const plan = p.get('plan');
      if (plan) document.getElementById('plan').textContent = `Your plan: ${plan}. You now have unlimited generations.`;
    </script>
  </body>
</html>

<!-- =========================================
File: C:\Users\zacka\autopitch-ai\public\cancel.html
========================================= -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Checkout Canceled – AutoPitch AI</title>
    <style>
      :root { --bg:#0b0f19; --card:#121725; --text:#eef1f6; --muted:#9aa4b2; --warn:#ffb86b; }
      body { background: var(--bg); color: var(--text); font-family: system-ui, Arial, sans-serif; margin:0; display:grid; place-items:center; min-height:100vh; padding:16px; }
      .box { background: var(--card); border: 1px solid #222940; border-radius: 14px; padding: 24px; max-width: 560px; text-align:center; }
      .muted { color: var(--muted); }
      a.btn { display:inline-block; margin-top:16px; padding:12px 16px; background:var(--warn); color:#1a1a1a; text-decoration:none; border-radius:10px; font-weight:700; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>⚠️ Checkout Canceled</h1>
      <p class="muted">No charge was made. You can try again any time.</p>
      <a href="/" class="btn">Back to AutoPitch</a>
    </div>
  </body>
</html>

<!-- =========================================
File: C:\Users\zacka\autopitch-ai\index.js
(Full server with success/cancel redirects already set)
========================================= -->
<script>
// This <script> tag is only to syntax-highlight in chat. Remove it when pasting.
</script>
<!-- begin JS -->
// index.js — complete server
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();

// ---- Config ----
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '10', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

// Stripe (optional)
let stripe = null;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STANDARD_PRICE_ID = process.env.STANDARD_PRICE_ID || '';
const PREMIUM_PRICE_ID  = process.env.PREMIUM_PRICE_ID  || '';
const PUBLIC_URL        = process.env.PUBLIC_URL        || '';

try {
  if (STRIPE_SECRET_KEY) {
    const Stripe = require('stripe');
    stripe = Stripe(STRIPE_SECRET_KEY);
  }
} catch (_) {
  stripe = null;
}

// ---- Utils ----
function mask(v, keep = 6) {
  if (!v || typeof v !== 'string') return null;
  if (v.length <= keep + 4) return v;
  return v.slice(0, keep) + '…' + v.slice(-4);
}
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence ? fence[1] : text;
  const s = candidate.indexOf('{');
  const e = candidate.lastIndexOf('}');
  if (s !== -1 && e !== -1 && e > s) {
    try { return JSON.parse(candidate.slice(s, e + 1)); } catch {}
  }
  try { return JSON.parse(candidate); } catch {}
  return null;
}

// Basic in-memory rate limiter
const buckets = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const arr = buckets.get(ip) || [];
  const fresh = arr.filter(t => t >= windowStart);
  if (fresh.length >= RATE_LIMIT_MAX) {
    const retryInMs = fresh[0] + RATE_LIMIT_WINDOW_MS - now;
    return res.status(429).json({ error: 'Too many requests', retry_in_ms: Math.max(retryInMs, 0) });
  }
  fresh.push(now);
  buckets.set(ip, fresh);
  next();
}

// ---- Middleware ----
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Health & Stripe debug ----
app.get('/health', (_req, res) => {
  const haveStripe = Boolean(stripe);
  const haveSecret = Boolean(STRIPE_SECRET_KEY);
  const haveUrl = Boolean(PUBLIC_URL);
  const haveStd = Boolean(STANDARD_PRICE_ID);
  const havePro = Boolean(PREMIUM_PRICE_ID);
  const checkoutEnabled = haveStripe && haveSecret && haveUrl && (haveStd || havePro);
  res.json({
    ok: true,
    model: OPENAI_MODEL,
    rate_limit: { max: RATE_LIMIT_MAX, window_ms: RATE_LIMIT_WINDOW_MS },
    checkout_enabled: checkoutEnabled,
    debug: {
      stripe_secret_present: haveSecret,
      public_url_present: haveUrl,
      standard_price_present: haveStd,
      premium_price_present: havePro,
      samples: {
        STRIPE_SECRET_KEY: mask(STRIPE_SECRET_KEY),
        STANDARD_PRICE_ID: mask(STANDARD_PRICE_ID, 7),
        PREMIUM_PRICE_ID: mask(PREMIUM_PRICE_ID, 7),
        PUBLIC_URL: PUBLIC_URL || null,
      }
    }
  });
});

app.get('/debug/stripe', async (_req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe not initialized (missing STRIPE_SECRET_KEY?)' });
    const out = {};
    if (STANDARD_PRICE_ID) {
      try { out.standard = await stripe.prices.retrieve(STANDARD_PRICE_ID); }
      catch (e) { out.standard_error = e.message; }
    }
    if (PREMIUM_PRICE_ID) {
      try { out.premium = await stripe.prices.retrieve(PREMIUM_PRICE_ID); }
      catch (e) { out.premium_error = e.message; }
    }
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Root ----
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Generate ----
app.post('/generate', rateLimit, async (req, res) => {
  const { job, skills, tone, ctaStyle, variants } = req.body || {};
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });
  if (!job || !skills)   return res.status(400).json({ error: 'Missing job or skills in request body.' });

  const t = (typeof tone === 'string' && tone.trim()) || 'Friendly';
  const cta = (typeof ctaStyle === 'string' && ctaStyle.trim()) || 'Book a quick call';
  const count = Math.max(1, Math.min(5, parseInt(variants, 10) || 1));

  const prompt = `Create ${count} cold outreach emails in a ${t} tone. Each must include a clear CTA like "${cta}" (rephrase to match tone).

Job description: ${job}
Freelancer skills: ${skills}

Return ONLY JSON like: { "emails": [ { "subject": string, "body": string } ] } with exactly ${count} items.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: 'You write professional, conversion-focused cold outreach emails.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const text = await response.text();
      let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
      return res.status(502).json({ error: 'OpenAI API error', status: response.status, body });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(content);
    let emails = [];
    if (parsed && Array.isArray(parsed.emails)) {
      emails = parsed.emails.filter(e => e && typeof e.subject === 'string' && typeof e.body === 'string');
    } else {
      try { const single = JSON.parse(content); if (single?.subject && single?.body) emails = [single]; } catch {}
    }

    if (!emails.length) return res.json({ emails: [{ subject: 'Draft', body: content }] });
    return res.json({ emails: emails.slice(0, count) });
  } catch (error) {
    return res.status(500).json({ error: 'Error generating email', details: error.message });
  }
});

// ---- Stripe Checkout (subscription) ----
app.post('/checkout', async (req, res) => {
  try {
    if (!stripe || !PUBLIC_URL) return res.status(501).json({ error: 'Checkout not configured on server.' });
    const plan = (req.body?.plan || 'standard').toString().toLowerCase();
    const priceId = plan === 'premium' ? PREMIUM_PRICE_ID : STANDARD_PRICE_ID;
    if (!priceId) return res.status(400).json({ error: `Missing price for plan: ${plan}` });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${PUBLIC_URL}/success.html?plan=${encodeURIComponent(plan)}`,
      cancel_url: `${PUBLIC_URL}/cancel.html`
    });

    return res.json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: 'Stripe error', details: e.message });
  }
});

// ---- Listen ----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
<!-- end JS -->
