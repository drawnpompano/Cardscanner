const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');
const { version } = require('./package.json');

// --- Password / usage management ---

const USAGE_FILE = path.join(__dirname, 'usage.json');

function loadPasswords() {
  try {
    return JSON.parse(process.env.PASSWORDS || '{}');
  } catch {
    console.error('Invalid PASSWORDS env var — must be valid JSON e.g. {"alice123":50,"bob456":20}');
    return {};
  }
}

function loadUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveUsage(usage) {
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch {}
}

function checkPassword(password) {
  const passwords = loadPasswords();
  if (!passwords.hasOwnProperty(password)) return { valid: false };
  const limit = passwords[password];
  const usage = loadUsage();
  const used = usage[password] || 0;
  const remaining = limit - used;
  return { valid: true, remaining, limit };
}

function consumeUse(password) {
  const usage = loadUsage();
  usage[password] = (usage[password] || 0) + 1;
  saveUsage(usage);
}

function authMiddleware(req, res, next) {
  const password = req.body.password;
  if (!password) return res.status(401).json({ error: 'Password required' });
  const { valid, remaining } = checkPassword(password);
  if (!valid) return res.status(403).json({ error: 'Invalid password' });
  if (remaining <= 0) return res.status(403).json({ error: 'Scan limit reached for this password' });
  req.password = password;
  req.remaining = remaining;
  next();
}

// --- Image fetch ---

async function fetchCardImage(query) {
  try {
    const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&first=1`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15' },
    });
    const html = await resp.text();
    const match = html.match(/"murl":"([^"]+)"/);
    if (!match) return null;
    const imgUrl = match[1];
    const imgResp = await fetch(imgUrl, { signal: AbortSignal.timeout(5000) });
    if (!imgResp.ok) return null;
    const buffer = await imgResp.arrayBuffer();
    const contentType = imgResp.headers.get('content-type') || 'image/jpeg';
    return { data: Buffer.from(buffer).toString('base64'), contentType };
  } catch {
    return null;
  }
}

// --- Express app ---

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic();

app.get('/api/version', (req, res) => res.json({ version }));

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  const { valid, remaining, limit } = checkPassword(password);
  if (!valid) return res.status(403).json({ error: 'Invalid password' });
  res.json({ success: true, remaining, limit });
});

app.post('/api/analyze', authMiddleware, async (req, res) => {
  const { frontData, backData } = req.body;
  if (!frontData) {
    return res.status(400).json({ error: 'At least a front image is required' });
  }

  consumeUse(req.password);
  const remaining = req.remaining - 1;

  const imageContent = backData
    ? [
        { type: 'text', text: 'Here are the front and back of a sports card:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frontData } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: backData } },
      ]
    : [
        { type: 'text', text: 'Here is the front of a sports card:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frontData } },
      ];

  const promptText = backData
    ? 'Using both the front and back of this card, identify it and provide current market prices by PSA grade.'
    : 'Using the front of this card, identify it and provide current market prices by PSA grade.';

  try {
    const stream = await client.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            ...imageContent,
            {
              type: 'text',
              text: `You are a sports card expert and pricing specialist. ${promptText}

Return ONLY a JSON object with this exact structure:
{
  "player": "Player Name",
  "year": "Year",
  "brand": "Brand/Set Name",
  "cardNumber": "Card # or null",
  "attributes": ["rookie card", "autograph", etc — only notable attributes],
  "prices": {
    "raw": { "low": 0, "high": 0 },
    "psa7": { "low": 0, "high": 0 },
    "psa8": { "low": 0, "high": 0 },
    "psa9": { "low": 0, "high": 0 },
    "psa10": { "low": 0, "high": 0 }
  },
  "pricingNotes": "Brief note on what drives value for this card",
  "confidence": "high/medium/low"
}

Use recent eBay sold listings and PSA pop report data to estimate prices. Do not assess the condition of the card. If you cannot identify this as a sports card, return all fields as null and explain in pricingNotes.`,
            },
          ],
        },
      ],
    });


    const message = await stream.finalMessage();
    let responseText = '';
    for (const block of message.content) {
      if (block.type === 'text') { responseText = block.text; break; }
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const cardData = JSON.parse(jsonMatch[0]);
      res.json({ success: true, card: cardData, remaining });
    } else {
      res.json({ success: true, card: null, raw: responseText, remaining });
    }
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: err.message || 'Failed to analyze card' });
  }
});

app.post('/api/lookup', authMiddleware, async (req, res) => {
  const { description } = req.body;
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'No description provided' });
  }

  consumeUse(req.password);
  const remaining = req.remaining - 1;

  try {
    const stream = await client.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: `You are a sports card expert and pricing specialist. The user has described a sports card: "${description.trim()}"

Based on this description, provide current market prices by PSA grade.

Return ONLY a JSON object with this exact structure:
{
  "player": "Player Name",
  "year": "Year",
  "brand": "Brand/Set Name",
  "cardNumber": "Card # or null",
  "attributes": ["rookie card", "autograph", etc — only notable attributes],
  "prices": {
    "raw": { "low": 0, "high": 0 },
    "psa7": { "low": 0, "high": 0 },
    "psa8": { "low": 0, "high": 0 },
    "psa9": { "low": 0, "high": 0 },
    "psa10": { "low": 0, "high": 0 }
  },
  "pricingNotes": "Brief note on what drives value for this card",
  "confidence": "high/medium/low"
}

Use recent eBay sold listings and PSA pop report data to estimate prices. If the description is too vague to identify a specific card, set confidence to "low" and provide your best estimate. If you cannot identify any matching card, return all price fields as null and explain in pricingNotes.`,
        },
      ],
    });

    const message = await stream.finalMessage();
    let responseText = '';
    for (const block of message.content) {
      if (block.type === 'text') { responseText = block.text; break; }
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const cardData = JSON.parse(jsonMatch[0]);
      const searchQuery = [cardData.year, cardData.brand, cardData.player, cardData.cardNumber ? `#${cardData.cardNumber}` : null, 'sports card']
        .filter(Boolean).join(' ');
      const image = await fetchCardImage(searchQuery);
      res.json({ success: true, card: cardData, image, remaining });
    } else {
      res.json({ success: true, card: null, raw: responseText, remaining });
    }
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: err.message || 'Failed to look up card' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CardScanner running on http://localhost:${PORT}`);
});
