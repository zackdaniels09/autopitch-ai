import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import { OpenAI } from 'openai';
import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';

/* --------- resolve dirname (ESM) --------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* --------- env validation (fail fast) --------- */
const Env = z.object({
  PORT: z.string().default('3000'),
  OPENAI_API_KEY: z.string(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  STRIPE_SECRET_KEY: z.string(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(), // not used server-side
  STANDARD_PRICE_ID: z.string(),
  PREMIUM_PRICE_ID: z.string(),
  APP_BASE_URL: z.string().url(),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be >=32 chars'),
  FREE_DAILY_LIMIT: z.string().default('5'),
  RATE_LIMIT_MAX: z.string().default('10'),
  RATE_LIMIT_WINDOW_MS: z.string().default('60000'),
  // optional:
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PROMOTION_CODE_ID: z.string().optional(), // pre-apply to Checkout (promo_...)
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(),     // CSV; defaults to APP_BASE_URL
  SENTRY_DSN: z.string().optional()
});
let env;
try { env = Env.parse(process.env); }
catch (e) { console.error('ENV ERROR:', e?.issues ?? e); process.exit(1); }

/* --------- clients --------- */
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

/* --------- app --------- */
const app = express();
app.set('trust proxy', true);

/* --------- Stripe webhook (raw body) --------- */
// Why: Stripe requires the exact raw payload for signature verification.
// Safe to keep even if STRIPE_WEBHOOK_SECRET is unset.
if (env.STRIPE_WEBHOOK_SECRET) {
  app.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    try {
      const sig = req.headers['stripe-signature'];
      stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
      return res.json({ received: true });
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  });
}

/* --------- body parser, cookies --------- */
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(env.APP_SECRET));

/* --------- CORS + Helmet CSP (no inline scripts) --------- */
const allowList = (env.ALLOWED_ORIGINS
  ? env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : [env.APP_BASE_URL]);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    cb(allowList.includes(origin) ? null : new Error('CORS blocked'), true);
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
      "style-src": ["'self'", "'unsafe-inline'"], // inline styles OK for simple CSS only
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'", env.APP_BASE_URL, "https://api.stripe.com", "https://r.stripe.com"],
      "frame-src": ["'self'", "https://js.stripe.com", "https://buy.stripe.com", "https://challenges.cloudflare.com"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' }
}));

/* --------- static --------- */
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res, file) => {
    if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

/* --------- abuse/usage controls --------- */
const dayKey = () => new Date().toISOString().slice(0, 10);
const usage = new Map(); // key: `${ip}|${day}` -> { calls, costCents, limitHits }
const counters = { totalCalls: 0, limit402: 0 };
const FREE_DAILY_LIMIT = Number(env.FREE_DAILY_LIMIT || '5');
const FREE_CAPTCHA_AFTER = 3;

const limiter = rateLimit({
  windowMs: Number(env.RATE_LIMIT_WINDOW_MS),
  max: Number(env.RATE_LIMIT_MAX),
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

function isPremium(req) { return req.signedCookies.ap_premium === '1'; }
function incUsage(req, calls = 1, costCents = 0) {
  const k = `${req.ip}|${dayKey()}`;
  const entry = usage.get(k) || { calls: 0, costCents: 0, limitHits: 0 };
  entry.calls += calls; entry.costCents += costCents; usage.set(k, entry);
}
function needCaptcha(req) {
  if (isPremium(req)) return false;
  const entry = usage.get(`${req.ip}|${dayKey()}`); 
  return (entry?.calls || 0) >= FREE_CAPTCHA_AFTER;
}
async function verifyTurnstile(token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return true; // disabled
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token || '', remoteip: ip || '' })
    });
    const j = await r.json();
    return !!j.success;
  } catch {
    return false;
  }
}

/* --------- routes --------- */
app.get('/health', (req, res) => {
  const live = env.STRIPE_SECRET_KEY.startsWith('sk_live_');
  res.json({
    ok: true,
    model: env.OPENAI_MODEL,
    checkout_enabled: Boolean(env.STANDARD_PRICE_ID && env.PREMIUM_PRICE_ID),
    stripe_mode: live ? 'live' : 'test',
    free_daily_limit: FREE_DAILY_LIMIT,
    captcha_after: FREE_CAPTCHA_AFTER,
    has_turnstile: Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY),
    turnstile_site_key: env.TURNSTILE_SITE_KEY || null
  });
});

app.get('/me', (req, res) => res.json({ premium: isPremium(req) }));

app.post('/checkout', async (req, res) => {
  try {
    const plan = req.body?.plan === 'premium' ? 'premium' : 'standard';
    const price = plan === 'premium' ? env.PREMIUM_PRICE_ID : env.STANDARD_PRICE_ID;
    const params = {
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      customer_creation: 'if_required',
      success_url: `${env.APP_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.APP_BASE_URL}/cancel.html`
    };
    if (env.PROMOTION_CODE_ID) params.discounts = [{ promotion_code: env.PROMOTION_CODE_ID }];
    const session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url });
  } catch {
    res.status(500).json({ error: 'checkout_failed' });
  }
});

app.post('/portal', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const list = await stripe.customers.list({ email, limit: 1 });
    const customer = list.data[0];
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
    const session_id = String(req.body?.session_id || '');
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

app.post('/generate', async (req, res) => {
  counters.totalCalls++;
  const k = `${req.ip}|${dayKey()}`;
  const entry = usage.get(k) || { calls: 0, costCents: 0, limitHits: 0 };
  const premium = isPremium(req);

  if (!premium && entry.calls >= FREE_DAILY_LIMIT) {
    counters.limit402++;
    entry.limitHits++; usage.set(k, entry);
    return res.status(402).json({ message: `Daily free limit (${FREE_DAILY_LIMIT}) reached.` });
  }

  if (!premium && needCaptcha(req)) {
    const token = req.headers['x-turnstile-token'] || req.body?.turnstileToken;
    const ok = await verifyTurnstile(String(token || ''), req.ip);
    if (!ok) return res.status(401).json({ error: 'captcha_failed' });
  }

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

  // very rough cost estimation (for metrics only)
  const inTok = Math.ceil((data.jobPost.length + data.skills.length + 300) / 4);
  const outTok = 350 * variants;
  const totalTok = inTok + outTok;
  const estCost = +(totalTok * 0.0000006).toFixed(6);

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content:
        `Job post:\n${data.jobPost}\n\nMy skills:\n${data.skills}\n\nTone: ${data.tone}\nCTA: ${data.cta}\nReturn ${variants} variant(s).`
      }
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
    res.json({ emails });
  } catch (e) {
    if (e?.status === 429) return res.status(429).json({ error: 'openai_rate_limited' });
    res.status(500).json({ error: 'ai_failed' });
  }
});

app.get('/metrics', (req, res) => {
  const today = dayKey();
  let uniqueIPs = 0, costCents = 0;
  for (const [k, v] of usage.entries()) {
    if (k.endsWith(today)) { uniqueIPs++; costCents += v.costCents || 0; }
  }
  res.json({ today, uniqueIPs, totalCalls: counters.totalCalls, limit402: counters.limit402, estCostUSD: +(costCents/100).toFixed(4) });
});

/* --------- root --------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* --------- start --------- */
app.listen(Number(env.PORT), () => {
  console.log(`AutoPitch AI listening on :${env.PORT}`);
});