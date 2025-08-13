// index.js — portable, Render-friendly
require('dotenv').config();

const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');

// node-fetch (ESM) loader pattern for CJS
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

// ---- Config from env ----
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STANDARD_PRICE_ID = process.env.STANDARD_PRICE_ID || '';
const PREMIUM_PRICE_ID = process.env.PREMIUM_PRICE_ID || '';
const PUBLIC_URL =
  process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '10', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || '60000',
  10
);

// ---- Stripe (optional) ----
let stripe = null;
if (STRIPE_SECRET_KEY) {
  try {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
  } catch (e) {
    console.warn('Stripe init failed:', e.message);
  }
}

// ---- Express ----
const app = express();
app.use(bodyParser.json());

// Serve static files from /public (index.html, CSS, client JS, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Explicit routes for success & cancel pages (Stripe redirect targets)
app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

app.get('/cancel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cancel.html'));
});

// ---- Simple in-memory rate limiting (per IP) ----
const buckets = new Map();
function hitBucket(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { count: 0, ts: now };
  if (now - b.ts > RATE_LIMIT_WINDOW_MS) {
    b.count = 0;
    b.ts = now;
  }
  b.count += 1;
  buckets.set(ip, b);
  return b;
}

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'ip';
  const b = hitBucket(ip);
  if (b.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: 'Too many requests',
      rate_limit: { max: RATE_LIMIT_MAX, window_ms: RATE_LIMIT_WINDOW_MS },
    });
  }
  next();
}

// ---- /health (diagnostics) ----
app.get('/health', (req, res) => {
  const mask = (v) => (v ? v.slice(0, 6) + '…' : '');
  const checkoutEnabled =
    Boolean(stripe) && Boolean(STANDARD_PRICE_ID && PREMIUM_PRICE_ID);

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
      STANDARD_PRICE_ID: mask(STANDARD_PRICE_ID),
      PREMIUM_PRICE_ID: mask(PREMIUM_PRICE_ID),
      PUBLIC_URL,
    },
  });
});

// ---- /generate (OpenAI) ----
app.post('/generate', rateLimit, async (req, res) => {
  try {
    const { job, skills, tone = 'Friendly', ctaStyle = 'Book a quick call', variants = 1 } =
      req.body || {};

    if (!job || !skills) {
      return res.status(400).json({ error: 'Missing job or skills' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY on server' });
    }

    const n = Math.max(1, Math.min(3, parseInt(variants, 10) || 1));
    const prompt = `
You are a cold-email writing assistant. Write ${n} distinct outreach email(s) as JSON.

Context:
- Job description: ${job}
- Freelancer skills/services: ${skills}
- Desired tone: ${tone}
- CTA style: ${ctaStyle}

Return ONLY valid JSON in this exact shape:
{
  "emails": [
    { "subject": "string", "body": "string" }
  ]
}
No extra text. No code fencing. Keep each email concise, friendly, and persuasive.
`;

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: 'You write professional, high-converting but non-spammy cold emails.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('OpenAI error:', data);
      return res.status(resp.status).json({ error: 'OpenAI request failed', details: data });
    }

    const text = data.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Fallback best-effort parse if model returned prose
      parsed = {
        emails: [{ subject: '(no subject)', body: text }]
      };
    }
    const emails = Array.isArray(parsed.emails) ? parsed.emails : [];
    return res.json({ emails });
  } catch (e) {
    console.error('Generate error:', e);
    res.status(500).json({ error: 'Server error generating emails' });
  }
});

// ---- /checkout (Stripe hosted Checkout) ----
app.post('/checkout', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe is not configured on the server' });
    }
    const plan = String(req.body?.plan || 'standard').toLowerCase();
    const priceId = plan === 'premium' ? PREMIUM_PRICE_ID : STANDARD_PRICE_ID;
    if (!priceId) {
      return res.status(400).json({ error: 'Price ID not configured for that plan' });
    }

    const successURL = `${PUBLIC_URL.replace(/\/+$/,'')}/success`;
    const cancelURL = `${PUBLIC_URL.replace(/\/+$/,'')}/cancel`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successURL,
      cancel_url: cancelURL,
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// (Optional) explicit root — static middleware already serves index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`AutoPitch server listening on http://localhost:${PORT}`);
  console.log('Serving static from:', path.join(__dirname, 'public'));
});
