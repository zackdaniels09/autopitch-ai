// index.js — extended, portable (Render + Windows)
require('dotenv').config();

const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');

// node-fetch ESM loader for CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// ---- Config ----
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STANDARD_PRICE_ID = process.env.STANDARD_PRICE_ID || '';
const PREMIUM_PRICE_ID  = process.env.PREMIUM_PRICE_ID  || '';
const PUBLIC_URL        = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '10', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

// ---- Stripe (optional) ----
let stripe = null;
if (STRIPE_SECRET_KEY) {
  try { stripe = require('stripe')(STRIPE_SECRET_KEY); }
  catch (e) { console.warn('Stripe init failed:', e.message); }
}

// ---- Utils ----
function mask(v, keep = 6) {
  if (!v || typeof v !== 'string') return '';
  return v.length > keep + 4 ? v.slice(0, keep) + '…' + v.slice(-4) : v;
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

// ---- Express ----
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'))); // serve index.html, success.html, cancel.html

// Success & cancel pages (explicit routes)
app.get('/success', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});
app.get('/cancel', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cancel.html'));
});

// ---- Simple in-memory rate limiter ----
const buckets = new Map();
function rateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'ip';
  const now = Date.now();
  const rec = buckets.get(ip) || { start: now, hits: 0 };
  if (now - rec.start > RATE_LIMIT_WINDOW_MS) { rec.start = now; rec.hits = 0; }
  rec.hits += 1; buckets.set(ip, rec);
  if (rec.hits > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests', rate_limit: { max: RATE_LIMIT_MAX, window_ms: RATE_LIMIT_WINDOW_MS } });
  }
  next();
}

// ---- Health + Stripe debug ----
app.get('/health', (_req, res) => {
  const haveStripe = Boolean(stripe);
  const checkoutEnabled = haveStripe && Boolean(STANDARD_PRICE_ID || PREMIUM_PRICE_ID);
  res.json({
    ok: true,
    model: OPENAI_MODEL,
    rate_limit: { max: RATE_LIMIT_MAX, window_ms: RATE_LIMIT_WINDOW_MS },
    checkout_enabled: checkoutEnabled,
    debug: {
      stripe_secret_present: Boolean(STRIPE_SECRET_KEY),
      public_url_present: Boolean(PUBLIC_URL),
      standard_price_present: Boolean(STANDARD_PRICE_ID),
      premium_price_present: Boolean(PREMIUM_PRICE_ID),
    },
    samples: {
      STRIPE_SECRET_KEY: mask(STRIPE_SECRET_KEY),
      STANDARD_PRICE_ID: mask(STANDARD_PRICE_ID,7),
      PREMIUM_PRICE_ID: mask(PREMIUM_PRICE_ID,7),
      PUBLIC_URL: PUBLIC_URL
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

// ---- Generate (OpenAI) ----
app.post('/generate', rateLimit, async (req, res) => {
  try {
    const { job, skills, tone = 'Friendly', ctaStyle = 'Book a quick call', variants = 1 } = req.body || {};
    if (!job || !skills) return res.status(400).json({ error: 'Missing job or skills' });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY on server' });

    const n = Math.max(1, Math.min(3, parseInt(variants, 10) || 1));
    const prompt = `You are a cold-email assistant. Write ${n} distinct outreach email(s) as JSON.\n\nContext:\n- Job description: ${job}\n- Freelancer skills/services: ${skills}\n- Desired tone: ${tone}\n- CTA style: ${ctaStyle}\n\nReturn ONLY valid JSON exactly like: { "emails": [ { "subject": string, "body": string } ] } with ${n} items.`;

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: 'You write professional, high-converting but non-spammy cold emails.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      })
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: 'OpenAI request failed', details: data });

    const text = data.choices?.[0]?.message?.content || '';
    let parsed = extractJson(text) || { emails: [{ subject: '(no subject)', body: text }] };
    const emails = Array.isArray(parsed.emails) ? parsed.emails : [];
    return res.json({ emails });
  } catch (e) {
    console.error('Generate error:', e);
    res.status(500).json({ error: 'Server error generating emails' });
  }
});

// ---- Checkout (Stripe hosted) ----
app.post('/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Stripe is not configured on the server' });
    const plan = String(req.body?.plan || 'standard').toLowerCase();
    const priceId = plan === 'premium' ? PREMIUM_PRICE_ID : STANDARD_PRICE_ID;
    if (!priceId) return res.status(400).json({ error: `Price ID not configured for plan: ${plan}` });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${PUBLIC_URL}/success`,
      cancel_url: `${PUBLIC_URL}/cancel`
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Root (served by static, but explicit is fine)
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Listen ----
app.listen(PORT, () => {
  console.log(`AutoPitch server listening on http://localhost:${PORT}`);
});
