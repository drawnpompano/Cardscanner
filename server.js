const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic();

app.post('/api/analyze', async (req, res) => {
  const { imageData, mediaType } = req.body;
  if (!imageData) {
    return res.status(400).json({ error: 'No image data provided' });
  }

  try {
    const stream = await client.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType || 'image/jpeg',
                data: imageData,
              },
            },
            {
              type: 'text',
              text: `You are a sports card expert and pricing specialist. Identify this sports card and provide current market prices by PSA grade.

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

Use recent eBay sold listings and PSA pop report data to estimate prices. Do not assess the condition of the card in the image. If you cannot identify this as a sports card, return all fields as null and explain in pricingNotes.`,
            },
          ],
        },
      ],
    });

    const message = await stream.finalMessage();

    let responseText = '';
    for (const block of message.content) {
      if (block.type === 'text') {
        responseText = block.text;
        break;
      }
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const cardData = JSON.parse(jsonMatch[0]);
      res.json({ success: true, card: cardData });
    } else {
      res.json({ success: true, card: null, raw: responseText });
    }
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: err.message || 'Failed to analyze card' });
  }
});

app.post('/api/lookup', async (req, res) => {
  const { description } = req.body;
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'No description provided' });
  }

  try {
    const stream = await client.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
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

Use recent eBay sold listings and PSA pop report data to estimate prices. If the description is too vague to identify a specific card, set confidence to "low" and provide your best estimate based on similar cards. If you cannot identify any matching card, return all price fields as null and explain in pricingNotes.`,
        },
      ],
    });

    const message = await stream.finalMessage();

    let responseText = '';
    for (const block of message.content) {
      if (block.type === 'text') {
        responseText = block.text;
        break;
      }
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const cardData = JSON.parse(jsonMatch[0]);
      res.json({ success: true, card: cardData });
    } else {
      res.json({ success: true, card: null, raw: responseText });
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
