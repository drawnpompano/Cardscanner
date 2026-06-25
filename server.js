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
              text: `You are a sports card expert and pricing specialist. Analyze this sports card image and provide:

1. Card identification: player name, year, brand/set, card number (if visible), and any special attributes (rookie card, autograph, parallel, etc.)
2. Card condition assessment based on what you can see (corners, edges, surface, centering)
3. Approximate current market value range in USD based on recent sales

Format your response as JSON with this structure:
{
  "player": "Player Name",
  "year": "Year",
  "brand": "Brand/Set Name",
  "cardNumber": "Card # or null",
  "attributes": ["list", "of", "special", "attributes"],
  "condition": "Condition grade and notes",
  "valueRange": {
    "low": 0,
    "high": 0,
    "currency": "USD"
  },
  "valueSummary": "Brief explanation of value and factors affecting it",
  "confidence": "high/medium/low"
}

If you cannot identify this as a sports card, set all fields to null and explain in valueSummary.`,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CardScanner running on http://localhost:${PORT}`);
});
