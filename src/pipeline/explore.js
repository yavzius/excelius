// Exploration agent: uses Haiku to explore Excel files via tools.
// Returns a structured ExplorationReport for the code gen agent.

const fs = require('fs');
const path = require('path');
const { callClaude } = require('./api-client');
const { createToolExecutor } = require('./tools');
const TOOLS = require('./tool-defs.json');
const {
  MODEL_EXPLORE, MAX_EXPLORATION_TURNS, TOOL_RESULT_MAX_CHARS,
} = require('./constants');

const EXPLORATION_PROMPT = fs.readFileSync(
  path.join(__dirname, 'prompts', 'exploration.txt'), 'utf-8'
);

async function explore({ apiKey, files, prompt, onTurn, signal }) {
  const executeTool = createToolExecutor(files);
  const fileList = files.map(f => f.name).join(', ');
  const messages = [
    { role: 'user', content: `Files available: ${fileList}\n\nUser's task: ${prompt}\n\nPlease explore these files thoroughly, then submit_report with your findings.` },
  ];
  const explorationTools = TOOLS.filter(t => t.name !== 'generate_code');
  const trace = [];
  const meta = { turns: 0, inputTokens: 0, outputTokens: 0 };

  for (let turn = 0; turn < MAX_EXPLORATION_TURNS; turn++) {
    if (signal?.aborted) throw new Error('Aborted');
    meta.turns = turn + 1;

    const response = await callClaude({
      apiKey, model: MODEL_EXPLORE, system: EXPLORATION_PROMPT,
      messages, tools: explorationTools, signal,
    });

    if (response.usage) {
      meta.inputTokens += response.usage.input_tokens || 0;
      meta.outputTokens += response.usage.output_tokens || 0;
    }
    messages.push({ role: 'assistant', content: response.content });

    // Check for submit_report
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'submit_report') {
        trace.push({ tool: 'submit_report', turn });
        onTurn?.({ turn: turn + 1, tools: ['submit_report'], done: true });
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
    onTurn?.({ turn: turn + 1, tools: toolNames, done: false });
  }

  throw new Error('Exploration hit turn limit');
}

module.exports = { explore, EXPLORATION_PROMPT };
