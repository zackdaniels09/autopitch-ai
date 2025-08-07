// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const PORT = 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('AutoPitch AI is live.');
});

app.post('/generate', async (req, res) => {
  const { job, skills } = req.body;

  if (!job || !skills) {
    return res.status(400).json({ error: 'Missing job or skills in request body.' });
  }

  try {
    const prompt = `Write a cold outreach email based on the following:
Job description: ${job}
Freelancer skills: ${skills}

Include:
- A subject line
- A warm but confident introduction
- A value proposition
- A call to action

Return only the email content in JSON with keys: subject, body.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that writes professional cold emails.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!data.choices || !data.choices[0]) {
      console.error('OpenAI API Error:', data);
      return res.status(500).json({ error: 'Invalid response from OpenAI', raw: data });
    }

    const emailContent = data.choices[0].message.content;

    try {
      const parsed = JSON.parse(emailContent);
      res.json(parsed);
    } catch (e) {
      res.json({ raw: emailContent });
    }

  } catch (error) {
    res.status(500).json({ error: 'Error generating email', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});