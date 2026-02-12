// Headless agent loop for eval runner.
// Calls Claude API directly (no browser, no DOM).

const { createToolExecutor, TOOL_RESULT_MAX_CHARS } = require('./tools');
const TOOLS = require('./tool-definitions.json');

const MAX_API_RETRIES = 3;
const RETRY_STATUS_CODES = [429, 529, 502, 503];
const MAX_EXPLORATION_TURNS = 15;
const MAX_CODE_RETRIES = 3;
const MAX_TOKENS_DEFAULT = 16384;
const MAX_TOKENS_EXTENDED = 32768;

const MODEL_EXPLORE = 'claude-haiku-4-5-20251001';
const MODEL_CODEGEN = 'claude-opus-4-6';

async function callClaude(apiKey, model, system, messages, tools, maxTokens = MAX_TOKENS_DEFAULT) {
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
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
      await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 8000)));
      continue;
    }

    const errText = await response.text().catch(() => '');
    throw new Error(`Claude API error (${response.status}): ${errText}`);
  }
}

async function runExploration(apiKey, files, prompt, explorationPrompt) {
  const executeTool = createToolExecutor(files);
  const fileList = files.map(f => f.name).join(', ');
  const messages = [
    { role: 'user', content: `Files available: ${fileList}\n\nUser's task: ${prompt}\n\nPlease explore these files thoroughly, then submit_report with your findings.` },
  ];
  const explorationTools = TOOLS.filter(t => t.name !== 'generate_code');
  const trace = [];
  const meta = { turns: 0, inputTokens: 0, outputTokens: 0 };

  for (let turn = 0; turn < MAX_EXPLORATION_TURNS; turn++) {
    meta.turns = turn + 1;
    process.stdout.write(`    turn ${turn + 1}...`);

    const response = await callClaude(apiKey, MODEL_EXPLORE, explorationPrompt, messages, explorationTools);
    if (response.usage) {
      meta.inputTokens += response.usage.input_tokens || 0;
      meta.outputTokens += response.usage.output_tokens || 0;
    }
    messages.push({ role: 'assistant', content: response.content });

    // Check for submit_report
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'submit_report') {
        trace.push({ tool: 'submit_report', turn });
        process.stdout.write(' submit_report\n');
        return { report: block.input, meta, trace };
      }
    }

    if (response.stop_reason !== 'tool_use') {
      throw new Error('Exploration agent stopped without submitting a report');
    }

    // Process tool calls
    const toolNames = [];
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use' || block.name === 'submit_report') continue;
      const result = executeTool(block.name, block.input);
      const resultStr = JSON.stringify(result, null, 2);
      const truncated = resultStr.length > TOOL_RESULT_MAX_CHARS
        ? resultStr.slice(0, TOOL_RESULT_MAX_CHARS) + '\n... (truncated)'
        : resultStr;
      trace.push({ tool: block.name, turn, input: block.input });
      toolNames.push(block.name);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: truncated });
    }
    if (toolResults.length) messages.push({ role: 'user', content: toolResults });
    process.stdout.write(` ${toolNames.join(', ')}\n`);
  }

  throw new Error('Exploration hit turn limit');
}

async function runCodeGen(apiKey, prompt, report, codeGenPrompt) {
  const messages = [
    { role: 'user', content: `Task: ${prompt}\n\nThe exploration report is in the system prompt. Generate the processing code.` },
  ];
  const codeTools = TOOLS.filter(t => t.name === 'generate_code');
  const meta = { attempts: 0, inputTokens: 0, outputTokens: 0 };

  for (let attempt = 0; attempt < MAX_CODE_RETRIES; attempt++) {
    meta.attempts = attempt + 1;
    let response = await callClaude(apiKey, MODEL_CODEGEN, codeGenPrompt, messages, codeTools);
    if (response.stop_reason === 'max_tokens') {
      const last = response.content[response.content.length - 1];
      if (last?.type === 'tool_use') {
        response = await callClaude(apiKey, MODEL_CODEGEN, codeGenPrompt, messages, codeTools, MAX_TOKENS_EXTENDED);
      }
    }
    if (response.usage) {
      meta.inputTokens += response.usage.input_tokens || 0;
      meta.outputTokens += response.usage.output_tokens || 0;
    }
    messages.push({ role: 'assistant', content: response.content });

    const codeBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'generate_code');
    if (!codeBlock) continue;

    return { code: codeBlock.input.code, filename: codeBlock.input.filename, explanation: codeBlock.input.explanation, meta };
  }

  throw new Error('Code generation failed');
}

module.exports = { runExploration, runCodeGen, callClaude };
