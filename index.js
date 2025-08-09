// index.js (full: tone + CTA + variants + rate limit + robust parsing + static UI)
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();

// --- Config ---
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'; // cheap + widely available
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '10', 10);       // requests
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10); // per ms window

// --- Utils ---
function cleanStr(v, fallback = '') {
  return (typeof v === 'string' ? v : fallback).toString().trim();
}

// Extract JSON if model wraps in ```json fences; otherwise try to parse raw.
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

// --- Basic in-memory rate limiter per IP ---
const buckets = new Map(); // ip -> array of timestamps
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

// --- Middleware ---
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Routes ---
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, model: OPENAI_MODEL, rate_limit: { max: RATE_LIMIT_MAX, window_ms: RATE_LIMIT_WINDOW_MS } });
});

app.post('/generate', rateLimit, async (req, res) => {
  const { job, skills, tone, ctaStyle, variants } = req.body || {};

  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });
  if (!job || !skills)   return res.status(400).json({ error: 'Missing job or skills in request body.' });

  const selectedTone = cleanStr(tone, 'Friendly');
  const selectedCTA  = cleanStr(ctaStyle, 'Book a quick call');
  const count        = Math.max(1, Math.min(5, parseInt(variants, 10) || 1));

  const prompt = `Create ${count} cold outreach emails in a ${selectedTone} tone based on the following. Each email must be concise, skimmable, and include ONE clear call to action in the style: "${selectedCTA}" (rephrase to match the tone).

Job description: ${job}
Freelancer skills: ${skills}

Return ONLY JSON in this exact shape:
{ "emails": [ { "subject": string, "body": string }, ... ] }
The length of "emails" MUST be exactly ${count}. No markdown, no code fences, no backticks, no extra prose.`;

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

    if (!emails.length) {
      return res.json({ emails: [{ subject: 'Draft', body: content }] });
    }

    emails = emails.slice(0, count);
    return res.json({ emails });
  } catch (error) {
    return res.status(500).json({ error: 'Error generating email', details: error.message });
  }
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
