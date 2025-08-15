// path: ./index.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const bodyParser = require('body-parser');
const pino = require('pino');
const { z } = require('zod');
const crypto = require('crypto');
const fetch = require('node-fetch');

// ---- Env
const env = {
  NODE_ENV: process.env.NODE_ENV || 'production',
  PORT: Number(process.env.PORT || 3000),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || '',
  STANDARD_PRICE_ID: process.env.STANDARD_PRICE_ID || '',
  PREMIUM_PRICE_ID: process.env.PREMIUM_PRICE_ID || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  APP_BASE_URL: process.env.APP_BASE_URL || 'http://localhost:3000',
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX || 10),
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  REQUEST_TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS || 30_000),
  APP_SECRET: process.env.APP_SECRET || crypto.randomBytes(32).toString('hex'),
  FREE_DAILY_LIMIT: Number(process.env.FREE_DAILY_LIMIT || 5),
};

const required = ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STANDARD_PRICE_ID', 'PREMIUM_PRICE_ID'];
const missing = required.filter((k) => !env[k]);

const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const log = pino({ level: process.env.LOG_LEVEL || 'info', base: undefined });

const app = express();
app.set('trust proxy', true); // Render proxied IPs

// Security
app.use(helmet());
app.use(cors({ origin: true }));

// --- Stripe webhook (raw body)
app.post('/stripe/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!env.STRIPE_WEBHOOK_SECRET) return res.status(200).send('[noop]');
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
    switch (event.type) {
      case 'checkout.session.completed':
        log.info({ id: event.data.object.id, customer: event.data.object.customer }, 'Checkout completed');
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        log.info({ id: event.data.object.id, status: event.data.object.status }, `Sub ${event.type}`);
        break;
      default:
        log.debug({ type: event.type }, 'Unhandled Stripe event');
    }
    res.json({ received: true });
  } catch (err) {
    res.status(400).send('Invalid signature');
  }
});

// JSON after webhook
app.use(express.json({ limit: '1mb' }));

// Rate limit on /generate
const genLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
});

// Health
app.get('/health', (_req, res) => {
  const checkoutEnabled = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY && env.STANDARD_PRICE_ID && env.PREMIUM_PRICE_ID);
  const stripeMode = env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test';
  res.json({ ok: missing.length === 0, missing, model: env.OPENAI_MODEL, stripe_mode: stripeMode, checkout_enabled: checkoutEnabled, rate_limit: { max: env.RATE_LIMIT_MAX, window_ms: env.RATE_LIMIT_WINDOW_MS }, free_daily_limit: env.FREE_DAILY_LIMIT });
});

// Validation
const GenerateSchema = z.object({
  jobPost: z.string().min(10).max(4000),
  skills: z.string().min(2).max(1000),
  tone: z.enum(['neutral', 'friendly', 'formal', 'casual']).default('neutral'),
  cta: z.enum(['book_call', 'request_reply', 'link_click', 'custom']).default('request_reply'),
  customCta: z.string().max(200).optional(),
  variants: z.number().int().min(1).max(3).default(1),
  debugCost: z.boolean().optional(),
});

// Cost estimation (approx)
const PRICING_PER_1K = { 'gpt-4o-mini': { in: 0.00015, out: 0.0006 }, 'gpt-4o': { in: 0.0025, out: 0.01 } };
const priceFor = PRICING_PER_1K[env.OPENAI_MODEL] || PRICING_PER_1K['gpt-4o-mini'];
const approxTokens = (s) => Math.ceil((s || '').length / 4);

async function openAIChat({ jobPost, skills, tone, cta, customCta, variants }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), env.REQUEST_TIMEOUT_MS);
  const promptCta = cta === 'book_call' ? 'End with a clear ask to book a 15‑min call.' : cta === 'link_click' ? 'End with a concise link click CTA.' : cta === 'custom' && customCta ? `End with this CTA: ${customCta}` : 'End with a short reply ask.';
  const messages = [
    { role: 'system', content: 'You write concise cold outreach emails. 75–140 words. Add 1‑line personalization from the job post. No fluff. Plain text. Use the specified tone.' },
    { role: 'user', content: [`Job post:\n${jobPost}`, `My skills:\n${skills}`, `Tone: ${tone}`, promptCta].join('\n\n') },
  ];
  const promptTok = messages.reduce((n, m) => n + approxTokens(m.content), 0);
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: env.OPENAI_MODEL, messages, n: variants, temperature: 0.7, max_tokens: 400 }), signal: controller.signal });
    clearTimeout(t);
    if (!resp.ok) { const text = await resp.text(); throw new Error(`OpenAI error ${resp.status}: ${text}`); }
    const data = await resp.json();
    const emails = (data.choices || []).map((c) => c.message.content.trim());
    const completionTok = emails.reduce((n, e) => n + approxTokens(e), 0);
    const cost = (promptTok / 1000) * priceFor.in + (completionTok / 1000) * priceFor.out;
    return { emails, promptTok, completionTok, cost };
  } catch (err) {
    log.error({ err: String(err) }, 'OpenAI call failed');
    throw new Error('Generation failed');
  }
}

// Cookie signing helpers
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function signToken(payload) { const data = b64url(JSON.stringify(payload)); const sig = crypto.createHmac('sha256', env.APP_SECRET).update(data).digest('base64url'); return `${data}.${sig}`; }
function verifyToken(token) { if (!token || !token.includes('.')) return null; const [data, sig] = token.split('.'); const expect = crypto.createHmac('sha256', env.APP_SECRET).update(data).digest('base64url'); if (sig !== expect) return null; try { const payload = JSON.parse(Buffer.from(data, 'base64url').toString()); if (payload.exp && Date.now() / 1000 > payload.exp) return null; return payload; } catch { return null; } }
function setCookie(res, name, value, maxAgeSec) { res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}; Secure`); }
function readCookies(req){ const raw = req.headers.cookie || ''; const out = {}; raw.split(';').forEach(p=>{ const i=p.indexOf('='); if(i>0){ out[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1)); }}); return out; }

// Detect plan from cookie / optional header
function detectPlan(req, _res, next){ const cookies = readCookies(req); const tok = cookies['ap_premium']; const claim = verifyToken(tok); req.plan = claim?.plan === 'premium' ? 'premium' : 'free'; const hdr = (req.headers['x-plan']||'').toString().toLowerCase(); if (hdr === 'premium') req.plan = 'premium'; next(); }

// Free daily quota per IP
const hits = new Map();
function freeQuota(req, res, next){ if (req.plan === 'premium') return next(); const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'; const day = new Date().toISOString().slice(0,10); const key = `${day}|${ip}`; const n = hits.get(key) || 0; if (n >= env.FREE_DAILY_LIMIT) { return res.status(402).json({ error: 'free_limit', message: `You’ve hit today’s free limit (${env.FREE_DAILY_LIMIT}). Upgrade to keep generating unlimited emails.` }); } hits.set(key, n+1); next(); }

// Premium claim
app.post('/claim', async (req, res) => {
  try {
    const sessionId = req.body?.sessionId; if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
    if (session.mode !== 'subscription' || session.status !== 'complete') return res.status(400).json({ error: 'invalid_session' });
    const sub = session.subscription; const isActive = sub && ['trialing','active','past_due'].includes(sub.status);
    if (!isActive) return res.status(400).json({ error: 'sub_not_active' });
    const payload = { plan: 'premium', sub: sub.id, cust: session.customer, exp: Math.floor(Date.now()/1000) + 60*60*24*30 };
    const token = signToken(payload); setCookie(res, 'ap_premium', token, 60*60*24*30); res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'claim_failed' }); }
});

// Generate
app.post('/generate', detectPlan, freeQuota, genLimiter, async (req, res) => {
  const parsed = GenerateSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const isPremium = req.plan === 'premium'; const variants = isPremium ? Math.min(parsed.data.variants, 3) : 1;
  try {
    const { emails, promptTok, completionTok, cost } = await openAIChat({ ...parsed.data, variants });
    res.setHeader('X-Estimated-Cost-USD', cost.toFixed(6));
    const payload = { variants: emails, plan: req.plan }; if (parsed.data.debugCost) payload._cost = { promptTok, completionTok, usd: Number(cost.toFixed(6)), model: env.OPENAI_MODEL };
    res.json(payload);
  } catch { res.status(502).json({ error: 'LLM temporarily unavailable' }); }
});

// Checkout
app.post('/checkout', async (req, res) => {
  const plan = (req.body && req.body.plan) || 'standard';
  const priceId = plan === 'premium' ? env.PREMIUM_PRICE_ID : env.STANDARD_PRICE_ID;
  if (!priceId) return res.status(400).json({ error: 'Unknown plan or missing price id' });
  try {
    const session = await stripe.checkout.sessions.create({ mode: 'subscription', line_items: [{ price: priceId, quantity: 1 }], success_url: `${env.APP_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${env.APP_BASE_URL}/cancel.html`, allow_promotion_codes: true, customer_creation: 'if_required' });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: 'Checkout failed' }); }
});

// Portal
app.post('/portal', async (req, res) => {
  try {
    let customerId = req.body?.customerId; if (!customerId && req.body?.sessionId) { const session = await stripe.checkout.sessions.retrieve(req.body.sessionId); customerId = session.customer; }
    if (!customerId) return res.status(400).json({ error: 'customerId or sessionId required' });
    const portal = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: env.APP_BASE_URL });
    res.json({ url: portal.url });
  } catch { res.status(500).json({ error: 'Portal failed' }); }
});

// Static
app.use(express.static(path.join(__dirname, 'public')));

// Error handler
app.use((err, _req, res, _next) => { res.status(500).json({ error: 'Server error' }); });

app.listen(env.PORT, () => { log.info({ port: env.PORT, env: env.NODE_ENV, model: env.OPENAI_MODEL }, 'AutoPitch server ready'); });