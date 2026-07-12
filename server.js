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

// --- eBay price fetch ---

async function getEbayOAuthToken() {
  const credentials = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');
  const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!resp.ok) throw new Error(`eBay OAuth error: ${resp.status}`);
  const data = await resp.json();
  return data.access_token;
}

async function fetchEbayPrices(cardData, days) {
  const { player, year, brand, cardNumber } = cardData;
  const query = [year, brand, player, cardNumber ? `#${cardNumber}` : null]
    .filter(Boolean).join(' ');

  const token = await getEbayOAuthToken();

  let filter = 'soldItems:true';
  if (days && days > 0) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('.')[0] + 'Z';
    filter += `,soldDate:[${since}..]`;
  }

  const params = new URLSearchParams({
    q: query,
    filter,
    limit: '100',
  });

  const resp = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
  });

  if (!resp.ok) throw new Error(`eBay API error: ${resp.status}`);
  const data = await resp.json();
  const items = data.itemSummaries || [];

  const buckets = { raw: [], psa7: [], psa8: [], psa9: [], psa10: [] };

  for (const item of items) {
    const title = (item.title || '').toLowerCase();
    const price = parseFloat(item.price?.value || 0);
    if (!price) continue;

    if (title.includes('psa 10') || title.includes('psa10')) buckets.psa10.push(price);
    else if (title.includes('psa 9') || title.includes('psa9')) buckets.psa9.push(price);
    else if (title.includes('psa 8') || title.includes('psa8')) buckets.psa8.push(price);
    else if (title.includes('psa 7') || title.includes('psa7')) buckets.psa7.push(price);
    else if (!title.includes('psa') && !title.includes('bgs') && !title.includes('sgc')) buckets.raw.push(price);
  }

  function priceRange(arr) {
    if (!arr.length) return { low: null, high: null };
    const sorted = arr.slice().sort((a, b) => a - b);
    const low = sorted[Math.floor(sorted.length * 0.1)] ?? sorted[0];
    const high = sorted[Math.floor(sorted.length * 0.9)] ?? sorted[sorted.length - 1];
    return { low: Math.round(low), high: Math.round(high) };
  }

  return {
    raw: priceRange(buckets.raw),
    psa7: priceRange(buckets.psa7),
    psa8: priceRange(buckets.psa8),
    psa9: priceRange(buckets.psa9),
    psa10: priceRange(buckets.psa10),
  };
}

// --- Prompts ---

const IDENTIFY_ONLY_PROMPT = `Return ONLY a JSON object with this exact structure:
{
  "player": "Player Name",
  "year": "Year",
  "brand": "Brand/Set Name",
  "cardNumber": "Card # or null",
  "attributes": ["rookie card", "autograph", etc — only notable attributes],
  "confidence": "high/medium/low"
}

If you cannot identify this as a sports card, return all fields as null.`;

const IDENTIFY_AND_PRICE_PROMPT = `Return ONLY a JSON object with this exact structure:
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

Use recent eBay sold listings and PSA pop report data to estimate prices. Do not assess the condition of the card. If you cannot identify this as a sports card, return all fields as null and explain in pricingNotes.`;

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
  const { frontData, backData, mode, days } = req.body;
  if (!frontData) {
    return res.status(400).json({ error: 'At least a front image is required' });
  }

  const ebayMode = mode === 'ebay';

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

  const sideText = backData
    ? 'Using both the front and back of this card, identify it.'
    : 'Using the front of this card, identify it.';

  const promptText = ebayMode
    ? `You are a sports card expert. ${sideText}\n\n${IDENTIFY_ONLY_PROMPT}`
    : `You are a sports card expert and pricing specialist. ${sideText} Provide current market prices by PSA grade.\n\n${IDENTIFY_AND_PRICE_PROMPT}`;

  try {
    const stream = await client.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: ebayMode ? 512 : 1024,
      messages: [
        {
          role: 'user',
          content: [
            ...imageContent,
            { type: 'text', text: promptText },
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
    if (!jsonMatch) {
      return res.json({ success: true, card: null, raw: responseText, remaining });
    }

    const cardData = JSON.parse(jsonMatch[0]);

    if (ebayMode && cardData.player) {
      try {
        const prices = await fetchEbayPrices(cardData, days);
        cardData.prices = prices;
        cardData.pricingNotes = 'Prices from recent eBay sold listings.';
      } catch (ebayErr) {
        console.error('eBay API error:', ebayErr);
        cardData.pricingNotes = 'eBay price fetch failed. Try AI mode for estimated prices.';
      }
    }

    const searchQuery = [cardData.year, cardData.brand, cardData.player, cardData.cardNumber ? `#${cardData.cardNumber}` : null, 'sports card']
      .filter(Boolean).join(' ');
    res.json({ success: true, card: cardData, ebayUrl: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(searchQuery)}`, remaining });
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: err.message || 'Failed to analyze card' });
  }
});

app.post('/api/lookup', authMiddleware, async (req, res) => {
  const { description, mode, days } = req.body;
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'No description provided' });
  }

  const ebayMode = mode === 'ebay';

  consumeUse(req.password);
  const remaining = req.remaining - 1;

  const promptText = ebayMode
    ? `You are a sports card expert. The user has described a sports card: "${description.trim()}"

Identify the card based on this description.

${IDENTIFY_ONLY_PROMPT}

If the description is too vague to identify a specific card, set confidence to "low". If you cannot identify any matching card, return all fields as null.`
    : `You are a sports card expert and pricing specialist. The user has described a sports card: "${description.trim()}"

Based on this description, provide current market prices by PSA grade.

${IDENTIFY_AND_PRICE_PROMPT}

If the description is too vague to identify a specific card, set confidence to "low" and provide your best estimate. If you cannot identify any matching card, return all price fields as null and explain in pricingNotes.`;

  try {
    const stream = await client.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: ebayMode ? 512 : 1024,
      messages: [
        {
          role: 'user',
          content: promptText,
        },
      ],
    });

    const message = await stream.finalMessage();
    let responseText = '';
    for (const block of message.content) {
      if (block.type === 'text') { responseText = block.text; break; }
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.json({ success: true, card: null, raw: responseText, remaining });
    }

    const cardData = JSON.parse(jsonMatch[0]);

    if (ebayMode && cardData.player) {
      try {
        const prices = await fetchEbayPrices(cardData, days);
        cardData.prices = prices;
        cardData.pricingNotes = 'Prices from recent eBay sold listings.';
      } catch (ebayErr) {
        console.error('eBay API error:', ebayErr);
        cardData.pricingNotes = 'eBay price fetch failed. Try AI mode for estimated prices.';
      }
    }

    const searchQuery = [cardData.year, cardData.brand, cardData.player, cardData.cardNumber ? `#${cardData.cardNumber}` : null, 'sports card']
      .filter(Boolean).join(' ');
    res.json({ success: true, card: cardData, ebayUrl: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(searchQuery)}`, remaining });
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: err.message || 'Failed to look up card' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CardScanner running on http://localhost:${PORT}`);
});
