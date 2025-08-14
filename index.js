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
const fetch = require('node-fetch'); // Node <18 fallback; remove if Node >=18

// --- Env ---
const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
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
};

// Validate critical env; keep non‑blocking but visible.
const required = ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STANDARD_PRICE_ID', 'PREMIUM_PRICE_ID'];
const missing = required.filter((k) => !env[k]);

const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const log = pino({ level: process.env.LOG_LEVEL || 'info', base: undefined });

const app = express();

// Security & basics
app.use(helmet());
app.use(cors({ origin: true, credentials: false }));

// Webhook must use raw body BEFORE json parser.
app.post('/stripe/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!env.STRIPE_WEBHOOK_SECRET) {
    // Fail closed when not configured in live; OK in test/dev.
    log.warn({ path: '/stripe/webhook' }, 'Webhook secret not set; ignoring event');
    return res.status(200).send('[noop]');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    log.warn({ err: String(err) }, 'Invalid Stripe signature');
    return res.status(400).send('Invalid signature');
  }

  // Handle relevant events
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        log.info({ customer: session.customer, id: session.id }, 'Checkout completed');
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        log.info({ id: sub.id, customer: sub.customer, status: sub.status }, `Sub ${event.type}`);
        break;
      }
      default:
        log.debug({ type: event.type }, 'Unhandled Stripe event');
    }
    return res.json({ received: true });
  } catch (err) {
    log.error({ err: String(err) }, 'Stripe webhook handler error');
    return res.status(500).send('Webhook error');
  }
});

// JSON parser after webhook raw body
app.use(express.json({ limit: '1mb' }));

// Rate limit ONLY the LLM generation endpoint
const genLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
});

// Health check
app.get('/health', async (req, res) => {
  const checkoutEnabled = Boolean(
    env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY && env.STANDARD_PRICE_ID && env.PREMIUM_PRICE_ID
  );
  const stripeMode = env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test';
  return res.json({
    ok: missing.length === 0,
    missing,
    model: env.OPENAI_MODEL,
    stripe_mode: stripeMode,
    checkout_enabled: checkoutEnabled,
    rate_limit: { max: env.RATE_LIMIT_MAX, window_ms: env.RATE_LIMIT_WINDOW_MS },
  });
});

// Validation schemas
const GenerateSchema = z.object({
  jobPost: z.string().min(10).max(4000),
  skills: z.string().min(2).max(1000),
  tone: z.enum(['neutral', 'friendly', 'formal', 'casual']).default('neutral'),
  cta: z.enum(['book_call', 'request_reply', 'link_click', 'custom']).default('request_reply'),
  customCta: z.string().max(200).optional(),
  variants: z.number().int().min(1).max(3).default(1),
});

// OpenAI helper
async function openAIChat({ jobPost, skills, tone, cta, customCta, variants }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), env.REQUEST_TIMEOUT_MS);
  const promptCta =
    cta === 'book_call'
      ? 'End with a clear ask to book a 15‑min call.'
      : cta === 'link_click'
      ? 'End with a concise link click CTA.'
      : cta === 'custom' && customCta
      ? `End with this CTA: ${customCta}`
      : 'End with a short reply ask.';

  const messages = [
    {
      role: 'system',
      content:
        'You write concise cold outreach emails. 75–140 words. Add 1‑line personalization from the job post. No fluff. Plain text. Use the specified tone.',
    },
    {
      role: 'user',
      content: [
        `Job post:\n${jobPost}`,
        `My skills:\n${skills}`,
        `Tone: ${tone}`,
        promptCta,
      ].join('\n\n'),
    },
  ];

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        messages,
        n: variants,
        temperature: 0.7,
        max_tokens: 400,
      }),
      signal: controller.signal,
    });
    clearTimeout(t);

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI error ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    const emails = (data.choices || []).map((c) => c.message.content.trim());
    return emails;
  } catch (err) {
    // Avoid leaking internals to client
    log.error({ err: String(err) }, 'OpenAI call failed');
    throw new Error('Generation failed');
  }
}

app.post('/generate', genLimiter, async (req, res) => {
  const parsed = GenerateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  }
  try {
    const emails = await openAIChat(parsed.data);
    return res.json({ variants: emails });
  } catch (err) {
    return res.status(502).json({ error: 'LLM temporarily unavailable' });
  }
});

app.post('/checkout', async (req, res) => {
  const plan = (req.body && req.body.plan) || 'standard';
  const priceId = plan === 'premium' ? env.PREMIUM_PRICE_ID : env.STANDARD_PRICE_ID;
  if (!priceId) return res.status(400).json({ error: 'Unknown plan or missing price id' });
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${env.APP_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.APP_BASE_URL}/cancel.html`,
      allow_promotion_codes: true,
      customer_creation: 'if_required',
    });
    return res.json({ url: session.url });
  } catch (err) {
    log.error({ err: String(err) }, 'Stripe checkout error');
    return res.status(500).json({ error: 'Checkout failed' });
  }
});

app.post('/portal', async (req, res) => {
  try {
    let customerId = req.body?.customerId;

    // Preferred: pass sessionId from success page to resolve customer
    if (!customerId && req.body?.sessionId) {
      const session = await stripe.checkout.sessions.retrieve(req.body.sessionId);
      customerId = session.customer;
    }
    if (!customerId) return res.status(400).json({ error: 'customerId or sessionId required' });

    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: env.APP_BASE_URL,
    });
    return res.json({ url: portal.url });
  } catch (err) {
    log.error({ err: String(err) }, 'Portal creation error');
    return res.status(500).json({ error: 'Portal failed' });
  }
});

// Static assets
app.use(express.static(path.join(__dirname, 'public')));

// Central error handler
// (Why) keep sensitive errors off the wire
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error({ err: String(err) }, 'Unhandled error');
  res.status(500).json({ error: 'Server error' });
});

app.listen(env.PORT, () => {
  log.info({ port: env.PORT, env: env.NODE_ENV }, 'AutoPitch server ready');
});