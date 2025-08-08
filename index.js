// index.js (final)
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000; // Render provides PORT
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'; // safe default

// Helper: extract JSON when the model wraps it in code fences/backticks
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  // Try fenced block first: ```json ... ``` or ``` ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'))); // serve /public

// Root serves the frontend UI
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/generate', async (req, res) => {
  const { job, skills } = req.body || {};

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });
  }
  if (!job || !skills) {
    return res.status(400).json({ error: 'Missing job or skills in request body.' });
  }

  const prompt = `Write a cold outreach email based on the following:

Job description: ${job}
Freelancer skills: ${skills}

Include exactly these keys in a single JSON object:
- subject (string)
- body (string)

Return ONLY raw JSON. No code fences, no markdown, no backticks, no extra text.`;

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
          { role: 'system', content: 'You are a helpful assistant that writes professional cold emails.' },
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
    if (!data.choices || !data.choices[0]) {
      return res.status(500).json({ error: 'Invalid response from OpenAI', raw: data });
    }

    const emailContent = data.choices[0].message.content || '';
    const parsed = extractJson(emailContent);
    if (parsed && parsed.subject && parsed.body) {
      return res.json(parsed);
    }
    try {
      const p2 = JSON.parse(emailContent);
      if (p2 && p2.subject && p2.body) return res.json(p2);
    } catch {}
    return res.json({ raw: emailContent });
  } catch (error) {
    return res.status(500).json({ error: 'Error generating email', details: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
