# FILE: C:\Users\zacka\autopitch-ai\index.js
// index.js — add premium model support + plan-aware variants
require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// ---- Config ----
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_MODEL_PREMIUM = process.env.OPENAI_MODEL_PREMIUM || '';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STANDARD_PRICE_ID = process.env.STANDARD_PRICE_ID || '';
const PREMIUM_PRICE_ID  = process.env.PREMIUM_PRICE_ID  || '';
const PUBLIC_URL        = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '10', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

// ---- Stripe ----
let stripe = null;
if (STRIPE_SECRET_KEY) {
  try { stripe = require('stripe')(STRIPE_SECRET_KEY); }
  catch (e) { console.warn('Stripe init failed:', e.message); }
}

// ---- Utils ----
function mask(v, keep = 6) { if (!v || typeof v !== 'string') return ''; return v.length > keep + 4 ? v.slice(0, keep) + '…' + v.slice(-4) : v; }
function stripTags(s = '') { return String(s).replace(/<[^>]*>/g, ''); }
function clampLen(s = '', max = 4000) { s = String(s); return s.length > max ? s.slice(0, max) : s; }
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence ? fence[1] : text;
  const s = candidate.indexOf('{');
  const e = candidate.lastIndexOf('}');
  if (s !== -1 && e !== -1 && e > s) { try { return JSON.parse(candidate.slice(s, e + 1)); } catch {} }
  try { return JSON.parse(candidate); } catch {}
  return null;
}

// ---- App ----
const app = express();
app.use(bodyParser.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Pages
app.get('/success', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));
app.get('/cancel',  (_req, res) => res.sendFile(path.join(__dirname, 'public', 'cancel.html')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/',        (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Rate limiter (simple per-IP)
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

// Health
app.get('/health', (_req, res) => {
  const haveStripe = Boolean(stripe);
  const checkoutEnabled = haveStripe && Boolean(STANDARD_PRICE_ID || PREMIUM_PRICE_ID);
  res.json({
    ok: true,
    model: OPENAI_MODEL,
    premium_model_enabled: Boolean(OPENAI_MODEL_PREMIUM),
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

// Generate (OpenAI) — plan aware
app.post('/generate', rateLimit, async (req, res) => {
  try {
    let { job, skills, tone = 'Friendly', ctaStyle = 'Book a quick call', variants = 1, plan = 'standard' } = req.body || {};
    plan = String(plan || 'standard').toLowerCase();

    job = clampLen(stripTags(String(job||'').trim()), 4000);
    skills = clampLen(stripTags(String(skills||'').trim()), 4000);

    if (!job || job.length < 40) return res.status(400).json({ error: 'Job description too short (min 40 chars)' });
    if (!skills || skills.length < 20) return res.status(400).json({ error: 'Skills too short (min 20 chars)' });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY on server' });

    const maxVariants = plan === 'premium' ? 5 : 3;
    const n = Math.max(1, Math.min(maxVariants, parseInt(variants, 10) || 1));
    const modelToUse = plan === 'premium' && OPENAI_MODEL_PREMIUM ? OPENAI_MODEL_PREMIUM : OPENAI_MODEL;

    const prompt = `You are a cold-email assistant. Write ${n} distinct outreach email(s) as JSON.\n\nContext:\n- Job description: ${job}\n- Freelancer skills/services: ${skills}\n- Desired tone: ${tone}\n- CTA style: ${ctaStyle}\n\nReturn ONLY valid JSON exactly like: { "emails": [ { "subject": string, "body": string } ] } with ${n} items.`;

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelToUse, messages: [
        { role: 'system', content: 'You write professional, high-converting but non-spammy cold emails.' },
        { role: 'user', content: prompt }
      ], temperature: 0.7 })
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: 'OpenAI request failed', details: data });

    const text = data.choices?.[0]?.message?.content || '';
    let parsed = extractJson(text) || { emails: [{ subject: '(no subject)', body: text }] };
    const emails = Array.isArray(parsed.emails) ? parsed.emails : [];
    return res.json({ emails, model: modelToUse, plan });
  } catch (e) {
    console.error('Generate error:', e);
    res.status(500).json({ error: 'Server error generating emails' });
  }
});

// Checkout + Portal (unchanged)
app.post('/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Stripe is not configured on the server' });
    const plan = String(req.body?.plan || 'standard').toLowerCase();
    const priceId = plan === 'premium' ? PREMIUM_PRICE_ID : STANDARD_PRICE_ID;
    if (!priceId) return res.status(400).json({ error: `Price ID not configured for plan: ${plan}` });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${PUBLIC_URL}/success?plan=${encodeURIComponent(plan)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/cancel`
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.post('/portal', async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Stripe is not configured on the server' });
    const sessionId = String(req.body?.session_id || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'Missing session_id in request' });

    const checkout = await stripe.checkout.sessions.retrieve(sessionId);
    const customerId = checkout?.customer;
    if (!customerId) return res.status(400).json({ error: 'No customer found on that checkout session' });

    const portal = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${PUBLIC_URL}/` });
    res.json({ url: portal.url });
  } catch (e) {
    console.error('Portal error:', e);
    res.status(500).json({ error: 'Portal error', details: e.message });
  }
});

// 404 + 500 fallbacks
app.use((req, res, next) => {
  if (req.path.startsWith('/generate') || req.path.startsWith('/checkout') || req.path.startsWith('/portal')) return next();
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  if (req.path.startsWith('/generate') || req.path.startsWith('/checkout') || req.path.startsWith('/portal')) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});

app.listen(PORT, () => console.log(`AutoPitch server on http://localhost:${PORT}`));