// Vercel serverless function: /api/chat
// Keeps the Groq API key secret (set as an env var in Vercel, never in code)
// and rate-limits requests per IP using a simple in-memory window.
// Note: in-memory state resets on cold start / across regions, so this is a
// basic first line of defense, not a substitute for Vercel's own abuse protection.

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 8;
const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, windowStart: now };

  if (now - entry.windowStart > WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count += 1;
  hits.set(ip, entry);

  return entry.count > MAX_REQUESTS_PER_WINDOW;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (isRateLimited(ip)) {
    return res
      .status(429)
      .json({ error: 'Too many messages from this device. Please wait a moment and try again.' });
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    console.error('GROQ_API_KEY is not set in Vercel environment variables.');
    return res.status(500).json({ error: 'Server is not configured yet.' });
  }

  try {
    const { messages } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const trimmed = messages.slice(-30).map((m) => ({
      role: m.role === 'user' || m.role === 'assistant' ? m.role : 'user',
      content: String(m.content || '').slice(0, 6000)
    }));

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        max_tokens: 1000,
        messages: [
          {
            role: 'system',
            content:
              'You are Bexus AI Pro, a helpful, direct AI assistant inside a polished chat product. Use markdown formatting (bold with **, code with backticks, bullet lists) where it aids clarity, but keep responses well organized and not overly long unless asked.'
          },
          ...trimmed
        ]
      })
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error('Groq error:', groqResponse.status, errText);
      return res.status(502).json({ error: 'Upstream model request failed. Please try again shortly.' });
    }

    const data = await groqResponse.json();
    const reply =
      data.choices?.[0]?.message?.content?.trim() || 'I could not generate a response just now.';

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
};
