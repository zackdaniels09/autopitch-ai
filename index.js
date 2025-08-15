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
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const Env = z.object({
  PORT: z.string().default('3000'),
  OPENAI_API_KEY: z.string(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  STRIPE_SECRET_KEY: z.string(),
  STANDARD_PRICE_ID: z.string(),
  PREMIUM_PRICE_ID: z.string(),
  APP_BASE_URL: z.string().url(),
  APP_SECRET: z.string().min(32).optional(),
  FREE_DAILY_LIMIT: z.string().default('5'),
  RATE_LIMIT_MAX: z.string().default('10'),
  RATE_LIMIT_WINDOW_MS: z.string().default('60000'),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional()
});
let env; try { env = Env.parse(process.env); } catch (e) { console.error('ENV ERROR:', e?.issues ?? e); process.exit(1); }

const RUNTIME_SECRET = env.APP_SECRET || crypto.randomBytes(48).toString('hex');
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const app = express();
app.set('trust proxy', true);

const allowList = (env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map(s=>s.trim()).filter(Boolean) : [env.APP_BASE_URL]);
app.use(cors({
  origin: (origin, cb)=>{ if(!origin) return cb(null,true); cb(allowList.includes(origin)?null:new Error('CORS blocked'), true); },
  credentials: true
}));
app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'", "https://js.stripe.com", "https://challenges.cloudflare.com"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'", env.APP_BASE_URL, "https://api.stripe.com", "https://r.stripe.com"],
      "frame-src": ["'self'", "https://js.stripe.com", "https://buy.stripe.com", "https://challenges.cloudflare.com"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(express.json({ limit:'1mb' }));
app.use(cookieParser(RUNTIME_SECRET));
app.use(express.static(path.join(__dirname,'public'),{
  etag:true,
  setHeaders:(res,file)=>{ res.setHeader('Cache-Control', file.endsWith('.html')?'no-cache':'public, max-age=31536000, immutable'); }
}));

const FREE_DAILY_LIMIT = Number(env.FREE_DAILY_LIMIT);
const CAPTCHA_AFTER = 3;
app.use(rateLimit({ windowMs:Number(env.RATE_LIMIT_WINDOW_MS), max:Number(env.RATE_LIMIT_MAX), standardHeaders:true, legacyHeaders:false }));

const usage = new Map();
const dayKey = ()=> new Date().toISOString().slice(0,10);
const isBotUA = (ua='')=> (ua.toLowerCase().match(/(bot|spider|crawl|curl|wget|httpclient|python-requests|scrapy)/));
const planOf = (req)=> req.signedCookies.ap_plan || 'free';

app.use((req,res,next)=>{
  const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
  req.realIp = ip;
  req.ipKey = `${ip}|${dayKey()}`;
  if (req.path === '/generate' && planOf(req)==='free') {
    const ua = String(req.headers['user-agent']||''); const al = String(req.headers['accept-language']||'');
    if (isBotUA(ua)) return res.status(400).json({ error:'browser required' });
    if (!al) return res.status(400).json({ error:'locale required' });
  }
  next();
});

app.get('/health', (req,res)=>{
  res.json({
    ok:true,
    model: env.OPENAI_MODEL,
    checkout_enabled: Boolean(env.STANDARD_PRICE_ID && env.PREMIUM_PRICE_ID),
    stripe_mode: env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test',
    free_daily_limit: FREE_DAILY_LIMIT,
    turnstile_site_key: env.TURNSTILE_SITE_KEY || null
  });
});
app.get('/me', (req,res)=> res.json({ plan: planOf(req), premium: planOf(req)==='premium' }));

app.post('/checkout', async (req,res)=>{
  try{
    const { plan } = req.body || {};
    const price = plan === 'premium' ? env.PREMIUM_PRICE_ID : env.STANDARD_PRICE_ID;
    if (!price) return res.status(400).json({ error:'bad_plan' });
    const session = await stripe.checkout.sessions.create({
      mode:'subscription',
      line_items:[{ price, quantity:1 }],
      success_url: `${env.APP_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.APP_BASE_URL}/cancel.html`,
      allow_promotion_codes:true
    });
    res.json({ url: session.url });
  }catch(e){ console.error('[checkout]', e?.message); res.status(500).json({ error:'checkout_failed', message:e?.message }); }
});

app.post('/portal', async (req,res)=>{
  try{
    const { email } = req.body || {};
    const customers = await stripe.customers.list({ email, limit:1 });
    const customer = customers.data[0];
    if (!customer) return res.status(404).json({ error:'no_customer' });
    const portal = await stripe.billingPortal.sessions.create({ customer: customer.id, return_url: env.APP_BASE_URL });
    res.json({ url: portal.url });
  }catch(e){ console.error('[portal]', e?.message); res.status(500).json({ error:'portal_failed' }); }
});

app.post('/claim', async (req,res)=>{
  try{
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ error:'session_id_required' });
    const session = await stripe.checkout.sessions.retrieve(session_id, { expand: ['subscription.items.data.price'] });
    const sub = session?.subscription;
    const active = sub && ['trialing','active','past_due'].includes(sub.status);
    if (!active) return res.status(402).json({ error:'no_active_subscription' });

    // identify plan by price id
    let plan = 'standard';
    try {
      const priceId = sub.items?.data?.[0]?.price?.id || '';
      if (priceId === env.PREMIUM_PRICE_ID) plan = 'premium';
    } catch {}
    res.cookie('ap_plan', plan, { httpOnly:true, secure:true, sameSite:'lax', maxAge: 30*24*3600*1000, signed:true });
    if (plan === 'premium') res.cookie('ap_premium','1',{ httpOnly:true, secure:true, sameSite:'lax', maxAge:30*24*3600*1000, signed:true });
    res.json({ plan });
  }catch(e){ console.error('[claim]', e?.message); res.status(500).json({ error:'claim_failed' }); }
});

async function verifyTurnstile(token, ip){
  if (!env.TURNSTILE_SECRET_KEY) return true;
  try{
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token||'', remoteip: ip||'' })
    });
    const j = await r.json(); return !!j.success;
  }catch{ return false; }
}

app.post('/generate', async (req,res)=>{
  const plan = planOf(req);
  const key = req.ipKey;
  const entry = usage.get(key) || { calls:0, costCents:0, limitHits:0 };

  if (plan === 'free' && entry.calls >= FREE_DAILY_LIMIT) {
    entry.limitHits++; usage.set(key, entry);
    return res.status(402).json({ message:`Daily free limit (${FREE_DAILY_LIMIT}) reached.` });
  }
  if (plan === 'free' && entry.calls >= 3) {
    const token = req.headers['x-turnstile-token'] || req.body?.turnstileToken;
    const ok = await verifyTurnstile(String(token||''), req.realIp);
    if (!ok) return res.status(401).json({ error:'captcha_failed' });
  }

  const b = req.body || {};
  const jobPost = String(b.jobPost||'');
  const skills  = String(b.skills||'');
  const tone    = String(b.tone||'concise & friendly');
  const cta     = String(b.cta || 'short intro call this week?');
  const requested = Number(b.variants || 1);
  const cap = plan==='premium' ? 5 : plan==='standard' ? 3 : 1; // <- UI promise
  const n = Math.max(1, Math.min(cap, requested));

  const inTok = Math.ceil((jobPost.length + skills.length + 300)/4);
  const outTok = 350 * n;
  const estCost = +(((inTok + outTok) * 0.0000006).toFixed(6));

  try{
    const resp = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [
        { role:'system', content:'You are AutoPitch AI. Generate concise, personalized cold outreach emails from a job post and skills. Keep it under 180 words.' },
        { role:'user', content:`Job post:\n${jobPost}\n\nMy skills:\n${skills}\n\nTone: ${tone}\nCTA: ${cta}\nReturn ${n} variant(s).` }
      ],
      max_tokens: 400,
      temperature: 0.6,
      n
    });
    const emails = (resp.choices||[]).map(c => (c.message?.content||'').trim()).filter(Boolean);
    entry.calls += 1; entry.costCents += Math.round(estCost*100); usage.set(key, entry);
    res.set('X-Estimated-Cost-USD', String(estCost));
    res.json({ emails, n, plan });
  }catch(e){
    if (e?.status === 429) return res.status(429).json({ error:'openai_rate_limited' });
    console.error('[generate]', e?.message);
    res.status(500).json({ error:'ai_failed' });
  }
});

app.get('/', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(Number(env.PORT), ()=> {
  console.log(`AutoPitch AI on :${env.PORT}`);
  if (!env.APP_SECRET) console.warn('[warn] APP_SECRET missing; using runtime secret (set APP_SECRET in Render for stable cookies)');
});