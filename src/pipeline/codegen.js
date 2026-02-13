// Code generation agent: uses Opus to generate SheetJS/JSZip code.
// Receives the exploration report and produces executable code.

const fs = require('fs');
const path = require('path');
const { callClaude } = require('./api-client');
const TOOLS = require('./tool-defs.json');
const {
  MODEL_CODEGEN, MAX_CODE_RETRIES, MAX_TOKENS_EXTENDED,
} = require('./constants');

const CODEGEN_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'prompts', 'codegen.txt'), 'utf-8'
);

function buildCodeGenPrompt(report) {
  return CODEGEN_TEMPLATE.replace('{{REPORT}}', JSON.stringify(report, null, 2));
}

async function codegen({ apiKey, prompt, report, onAttempt, signal }) {
  const systemPrompt = buildCodeGenPrompt(report);
  const messages = [
    { role: 'user', content: `Task: ${prompt}\n\nThe exploration report is in the system prompt. Generate the processing code.` },
  ];
  const codeTools = TOOLS.filter(t => t.name === 'generate_code');
  const meta = { attempts: 0, inputTokens: 0, outputTokens: 0 };

  for (let attempt = 0; attempt < MAX_CODE_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');
    meta.attempts = attempt + 1;
    onAttempt?.({ attempt: attempt + 1 });

    let response = await callClaude({
      apiKey, model: MODEL_CODEGEN, system: systemPrompt,
      messages, tools: codeTools, signal,
    });

    // Handle max_tokens truncation
    if (response.stop_reason === 'max_tokens') {
      const last = response.content[response.content.length - 1];
      if (last?.type === 'tool_use') {
        response = await callClaude({
          apiKey, model: MODEL_CODEGEN, system: systemPrompt,
          messages, tools: codeTools, signal, maxTokens: MAX_TOKENS_EXTENDED,
        });
      }
    }

    if (response.usage) {
      meta.inputTokens += response.usage.input_tokens || 0;
      meta.outputTokens += response.usage.output_tokens || 0;
    }
    messages.push({ role: 'assistant', content: response.content });

    const codeBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'generate_code');
    if (!codeBlock) continue;

    return {
      code: codeBlock.input.code,
      filename: codeBlock.input.filename,
      explanation: codeBlock.input.explanation,
      meta,
    };
  }

  throw new Error('Code generation failed after max retries');
}

module.exports = { codegen, buildCodeGenPrompt };
