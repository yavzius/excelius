// Anthropic Messages API client with retry logic.

const { MAX_API_RETRIES, RETRY_STATUS_CODES, MAX_TOKENS_DEFAULT } = require('./constants');

async function callClaude({ apiKey, model, system, messages, tools, maxTokens = MAX_TOKENS_DEFAULT, signal }) {
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
        tools,
      }),
    });

    if (response.ok) return await response.json();

    if (RETRY_STATUS_CODES.includes(response.status) && attempt < MAX_API_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    const errText = await response.text().catch(() => '');
    throw new Error(`Claude API error (${response.status}): ${errText}`);
  }
}

module.exports = { callClaude };
