// Full backend: model env, tone/CTA/variants, rate limit, robust parsing, static UI, optional Stripe
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();

// -------- Config --------
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '10', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

// Optional Stripe (won’t crash if not installed/configured)
let stripe = null;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const PRICE_ID = process.env.PRICE_ID || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
try {
  if (STRIPE_SECRET_KEY) {
    // eslint-disable-next-line global-require
    const Stripe = require('stripe');
    stripe = Stripe(STRIPE_SECRET_KEY);
  }
} catch {
  stripe = null; // not installed; ignore
}

// -------- Utilities --------
function cleanStr(v, fallback = '') {
  return (typeof v === 'string' ? v : fallback).toString().trim();
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  try { return JSON.parse(candidate); } catch {}
  return null;
}

// -------- Simple in-memory rate limiter --------
const buckets = new Map(); // ip -> timestamps
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

// -------- Middleware --------
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// -------- Routes --------
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    model: OPENAI_MODEL,
    rate_limit: { max: RATE_LIMIT_MAX, window_ms: RATE_LIMIT_WINDOW_MS },
    checkout_enabled: Boolean(stripe && PRICE_ID && PUBLIC_URL),
  });
});

app.post('/generate', rateLimit, async (req, res) => {
  const { job, skills, tone, ctaStyle, variants } = req.body || {};

  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });
  if (!job || !skills)   return res.status(400).json({ error: 'Missing job or skills in request body.' });

  const selectedTone = cleanStr(tone, 'Friendly');
  const selectedCTA  = cleanStr(ctaStyle, 'Book a quick call');
  const count        = Math.max(1, Math.min(5, parseInt(variants, 10) || 1));

  const prompt = `Create ${count} cold outreach emails in a ${selectedTone} tone. Each must be concise, skimmable, and include ONE clear call to action in the style: "${selectedCTA}" (rephrase to match tone).

Job description: ${job}
Freelancer skills: ${skills}

Return ONLY JSON like:
{ "emails": [ { "subject": string, "body": string }, ... ] }
The "emails" array length MUST be exactly ${count}. No markdown, code fences, or prose—JSON only.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: 'You write professional, conversion-focused cold outreach emails.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
      return res.status(502).json({ error: 'OpenAI API error', status: response.status, body });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';

    let emails = [];
    const parsed = extractJson(content);
    if (parsed && Array.isArray(parsed.emails)) {
      emails = parsed.emails.filter(e => e && typeof e.subject === 'string' && typeof e.body === 'string');
    } else {
      try {
        const single = JSON.parse(content);
        if (single && single.subject && single.body) emails = [single];
      } catch {}
    }

    if (!emails.length) return res.json({ emails: [{ subject: 'Draft', body: content }] });

    return res.json({ emails: emails.slice(0, count) });
  } catch (error) {
    return res.status(500).json({ error: 'Error generating email', details: error.message });
  }
});

// Optional Stripe checkout (safe if not configured)
app.post('/checkout', async (_req, res) => {
  try {
    if (!stripe || !PRICE_ID || !PUBLIC_URL) {
      return res.status(501).json({ error: 'Checkout not configured on server.' });
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription', // use 'payment' for one-time
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: `${PUBLIC_URL}/?success=1`,
      cancel_url: `${PUBLIC_URL}/?cancel=1`,
    });
    return res.json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: 'Stripe error', details: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});