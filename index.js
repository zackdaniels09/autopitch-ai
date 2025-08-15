// file: index.js
/**
 * AutoPitch AI — hardened Express server (single-file).
 * - FREE_DAILY_LIMIT=5/IP/day (server-enforced), free variants=1, premium up to 3
 * - Premium claim via /claim -> signed cookie (30d)
 * - Turnstile required for free users after 3 calls/day
 * - Helmet CSP (Stripe + Turnstile), strict CORS, basic bot/ban protections
 * - /metrics shows today's counts and estimated OpenAI cost
 * - Optional Stripe webhook stub (no DB)
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import { ZodError, z } from 'zod';
import * as Sentry from '@sentry/node';
import { OpenAI } from 'openai';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

// ---- resolve dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- env validation
const Env = z.object({
  PORT: z.string().default('3000'),
  OPENAI_API_KEY: z.string(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  STRIPE_SECRET_KEY: z.string(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STANDARD_PRICE_ID: z.string(),
  PREMIUM_PRICE_ID: z.string(),
  APP_BASE_URL: z.string().url(),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be >=32 chars'),
  // optional
  FREE_DAILY_LIMIT: z.string().default('5'),
  RATE_LIMIT_MAX: z.string().default('10'),
  RATE_LIMIT_WINDOW_MS: z.string().default('60000'),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PROMOTION_CODE_ID: z.string().optional(), // promo_...
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(), // comma list; defaults to APP_BASE_URL
  SENTRY_DSN: z.string().optional()
});
let env;
try { env = Env.parse(process.env); }
catch (e) {
  console.error('ENV ERROR:', e?.issues ?? e);
  process.exit(1);
}

// ---- clients
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ---- sentry (optional)
if (env.SENTRY_DSN) {
  Sentry.init({ dsn: env.SENTRY_DSN, tracesSampleRate: 0.1 });
}

// ---- app
const app = express();
app.set('trust proxy', true);

// ---- security: CORS + Helmet (CSP)
const allowList = (env.ALLOWED_ORIGINS
  ? env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : [env.APP_BASE_URL]
);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin
    const ok = allowList.includes(origin);
    cb(ok ? null : new Error('CORS blocked'), ok);
  },
  credentials: true
}));

app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://js.stripe.com", "https://challenges.cloudflare.com"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'", "https://api.stripe.com", "https://r.stripe.com", env.APP_BASE_URL],
      "frame-src": ["'self'", "https://js.stripe.com", "https://buy.stripe.com", "https://challenges.cloudflare.com"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' }
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(env.APP_SECRET));

// ---- static
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res, file) => {
    if (file.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// ---- primitive memory stores (no DB)
const dayKey = () => new Date().toISOString().slice(0, 10);
const usage = new Map(); // key: `${ip}|${day}` -> { calls, captchaCalls, costCents, limitHits }
const counters = { totalCalls: 0, limit402: 0 };
const BAN = new Set((process.env.IP_BAN_LIST || '').split(',').map(s => s.trim()).filter(Boolean));

function isBotUA(ua = '') {
  ua = ua.toLowerCase();
  return !ua || /(bot|spider|crawl|curl|wget|httpclient|python-requests|scrapy)/.test(ua);
}

// ---- per-minute burst limiter
const limiter = rateLimit({
  windowMs: Number(env.RATE_LIMIT_WINDOW_MS),
  max: Number(env.RATE_LIMIT_MAX),
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// ---- pre-handler protections
app.use((req, res, next) => {
  const ip = (req.headers['cf-connecting-ip'] || req.ip || '').toString();
  if (BAN.has(ip)) return res.status(403).json({ error: 'blocked' });
  // block obvious scripts from hitting /generate anonymously
  if (req.path === '/generate') {
    const ua = String(req.headers['user-agent'] || '');
    const al = String(req.headers['accept-language'] || '');
    if (isBotUA(ua) && !req.signedCookies.ap_premium) {
      return res.status(400).json({ error: 'browser required' });
    }
    if (!al && !req.signedCookies.ap_premium) {
      return res.status(400).json({ error: 'locale required' });
    }
  }
  req.realIp = ip;
  req.ipKey = `${ip}|${dayKey()}`;
  next();
});

// ---- helpers
const FREE_DAILY_LIMIT = Number(env.FREE_DAILY_LIMIT || '5');
const FREE_CAPTCHA_AFTER = 3;
const isPremium = (req) => Boolean(req.signedCookies.ap_premium === '1');

function incUsage(req, deltaCalls = 1, deltaCostCents = 0) {
  const k = req.ipKey;
  const entry = usage.get(k) || { calls: 0, captchaCalls: 0, costCents: 0, limitHits: 0, ips: req.realIp };
  entry.calls += deltaCalls;
  entry.costCents += deltaCostCents;
  usage.set(k, entry);
}

function needCaptcha(req) {
  if (isPremium(req)) return false;
  const k = req.ipKey; const entry = usage.get(k);
  return (entry?.calls || 0) >= FREE_CAPTCHA_AFTER;
}

async function verifyTurnstile(token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return true; // disabled
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token || '',
        remoteip: ip || ''
      })
    });
    const j = await r.json();
    return Boolean(j.success);
  } catch {
    return false;
  }
}

// ---- routes
app.get('/health', (req, res) => {
  const live = env.STRIPE_SECRET_KEY.startsWith('sk_live_');
  res.json({
    ok: true,
    model: env.OPENAI_MODEL,
    checkout_enabled: Boolean(env.STANDARD_PRICE_ID && env.PREMIUM_PRICE_ID),
    stripe_mode: live ? 'live' : 'test',
    free_daily_limit: FREE_DAILY_LIMIT,
    captcha_after: FREE_CAPTCHA_AFTER,
    has_turnstile: Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY)
  });
});

app.get('/me', (req, res) => {
  res.json({ premium: isPremium(req) });
});

app.post('/checkout', async (req, res) => {
  try {
    const { plan } = req.body || {};
    const price = plan === 'premium' ? env.PREMIUM_PRICE_ID : env.STANDARD_PRICE_ID;
    const params = {
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      success_url: `${env.APP_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.APP_BASE_URL}/cancel.html`,
      allow_promotion_codes: true,
      customer_creation: 'if_required'
    };
    if (env.PROMOTION_CODE_ID) {
      // Helps zero-cost smoke tests without typing codes.
      params.discounts = [{ promotion_code: env.PROMOTION_CODE_ID }];
    }
    const session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: 'checkout_failed' });
  }
});

app.post('/portal', async (req, res) => {
  try {
    const { email } = req.body || {};
    const customers = await stripe.customers.list({ email, limit: 1 });
    const customer = customers.data[0];
    if (!customer) return res.status(404).json({ error: 'no_customer' });
    const portal = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: env.APP_BASE_URL
    });
    res.json({ url: portal.url });
  } catch {
    res.status(500).json({ error: 'portal_failed' });
  }
});

app.post('/claim', async (req, res) => {
  try {
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ error: 'session_id_required' });
    const session = await stripe.checkout.sessions.retrieve(session_id, { expand: ['subscription'] });
    const active = session?.subscription && ['trialing', 'active', 'past_due'].includes(session.subscription.status);
    if (!active) return res.status(402).json({ error: 'no_active_subscription' });

    res.cookie('ap_premium', '1', {
      httpOnly: true, secure: true, sameSite: 'lax',
      maxAge: 30 * 24 * 3600 * 1000, signed: true
    });
    res.json({ premium: true });
  } catch {
    res.status(500).json({ error: 'claim_failed' });
  }
});

// ---- generate (core)
app.post('/generate', async (req, res) => {
  counters.totalCalls++;
  const k = req.ipKey;
  const entry = usage.get(k) || { calls: 0, captchaCalls: 0, costCents: 0, limitHits: 0 };
  const premium = isPremium(req);

  // server daily cap
  if (!premium && entry.calls >= FREE_DAILY_LIMIT) {
    counters.limit402++;
    entry.limitHits = (entry.limitHits || 0) + 1;
    usage.set(k, entry);
    return res.status(402).json({ message: `Daily free limit (${FREE_DAILY_LIMIT}) reached.` });
  }

  // Turnstile required after N calls (free only)
  if (!premium && needCaptcha(req)) {
    const token = req.headers['x-turnstile-token'] || req.body?.turnstileToken;
    const ok = await verifyTurnstile(String(token || ''), req.realIp);
    if (!ok) return res.status(401).json({ error: 'captcha_failed' });
  }

  // Input validation (light)
  const bodySchema = z.object({
    jobPost: z.string().min(20).max(6000),
    skills: z.string().min(2).max(2000),
    tone: z.string().min(2).max(60),
    cta: z.string().min(2).max(120),
    variants: z.number().int().min(1).max(3).default(1)
  });
  let data;
  try { data = bodySchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ error: 'bad_input', details: e.errors }); }

  const variants = premium ? data.variants : 1;
  const systemPrompt = `You are AutoPitch AI. Generate concise, personalized cold outreach emails from a job post and skills. Keep it under 180 words.`;

  // rough token estimate (why: log cost; not exact)
  const inTok = Math.ceil((data.jobPost.length + data.skills.length + 300) / 4);
  const outTok = 350 * variants;
  const totalTok = inTok + outTok;
  const perTokCost = 0.0000006; // ~$0.0006 per 1K tokens => 6e-7 per token (gpt-4o-mini-like)
  const estCost = +(totalTok * perTokCost).toFixed(6);

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Job post:\n${data.jobPost}\n\nMy skills:\n${data.skills}\n\nTone: ${data.tone}\nCTA: ${data.cta}\nReturn ${variants} variant(s).` }
    ];
    const resp = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      messages,
      max_tokens: 400,
      temperature: 0.6,
      n: variants
    });

    const emails = (resp.choices || []).map(c => (c.message?.content || '').trim()).filter(Boolean);
    incUsage(req, 1, Math.round(estCost * 100));
    res.set('X-Estimated-Cost-USD', String(estCost));
    return res.json({ emails });
  } catch (e) {
    // why: avoid leaking internals; map common vendor errors
    if (e?.status === 429) return res.status(429).json({ error: 'openai_rate_limited' });
    return res.status(500).json({ error: 'ai_failed' });
  }
});

// ---- metrics
app.get('/metrics', (req, res) => {
  const today = dayKey();
  const totals = { today, uniqueIPs: 0, totalCalls: counters.totalCalls, limit402: counters.limit402, estCostUSD: 0 };
  for (const [k, v] of usage.entries()) {
    if (k.endsWith(today)) {
      totals.uniqueIPs++;
      totals.estCostUSD += (v.costCents || 0) / 100;
    }
  }
  res.json(totals);
});

// ---- Stripe webhook (optional; logs only)
if (env.STRIPE_WEBHOOK_SECRET) {
  app.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    let event;
    try {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    // why: later persist to DB. For now, just log useful lifecycle.
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed':
        console.log('[webhook]', event.type, event.data?.object?.id);
        break;
      default:
        break;
    }
    res.json({ received: true });
  });
}

// ---- fallback to index.html (optional SPA-ish)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- start
app.listen(Number(env.PORT), () => {
  console.log(`AutoPitch AI up on :${env.PORT}`);
});
