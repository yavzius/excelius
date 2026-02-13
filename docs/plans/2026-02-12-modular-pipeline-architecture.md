# Modular Pipeline Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract the duplicated browser/eval pipeline into shared server-side modules, wrap them in an HTTP server, and reduce the frontend to a thin client.

**Architecture:** The pipeline (explore → codegen → execute → verify) lives in `src/pipeline/` as pure functions. A Hono HTTP server wraps the pipeline and streams SSE events. The frontend POSTs files and reads the event stream. Evals import the same pipeline modules directly. No duplication.

**Tech Stack:** Bun runtime, Hono web framework, SheetJS (xlsx), JSZip, Anthropic Messages API

---

## Current State

- `app.js` (1184 lines): monolith containing tools, API client, agents, sandbox, UI
- `evals/lib/`: parallel implementation of tools, agents, execution, verification
- Both call the Anthropic API directly with identical logic
- Tool definitions duplicated (inline in app.js + evals/lib/tool-definitions.json)
- Prompts duplicated (inline strings in app.js + files in evals/lib/)

## Target State

```
src/
  pipeline/
    constants.js        ← shared config (models, limits, timeouts)
    api-client.js       ← Anthropic API wrapper with retry
    tools.js            ← tool executor (from evals/lib/tools.js)
    tool-defs.json      ← tool schemas (from evals/lib/tool-definitions.json)
    explore.js          ← exploration agent (Haiku)
    codegen.js          ← code generation agent (Opus)
    execute.js          ← headless code executor (from evals/lib/execute.js)
    verify.js           ← output verifier (from evals/lib/verify.js)
    prompts/
      exploration.txt   ← Haiku system prompt
      codegen.txt       ← Opus system prompt template
    index.js            ← pipeline orchestrator with event callbacks
  server.js             ← Bun + Hono HTTP server (SSE streaming)
app.js                  ← thin frontend client (~300 lines: UI + SSE reader)
index.html              ← unchanged
evals/
  run.js                ← updated to import from src/pipeline/
  generate-fixtures.js  ← unchanged
  fixtures/             ← unchanged
```

---

### Task 1: Project Setup

**Files:**
- Create: `package.json`

**Step 1: Create root package.json**

```json
{
  "name": "excelius",
  "private": true,
  "scripts": {
    "dev": "bun run src/server.js",
    "evals": "bun evals/run.js"
  },
  "dependencies": {
    "hono": "^4",
    "jszip": "^3.10.1",
    "xlsx": "^0.18.5"
  }
}
```

**Step 2: Install dependencies**

Run: `cd /Users/work/Documents/build/lab/excel && bun install`
Expected: `node_modules/` created with hono, xlsx, jszip

**Step 3: Verify**

Run: `bun -e "require('hono'); require('xlsx'); require('jszip'); console.log('OK')"`
Expected: `OK`

**Step 4: Commit**

```bash
git add package.json bun.lockb
git commit -m "feat: add root package.json with hono, xlsx, jszip"
```

---

### Task 2: Shared Constants

**Files:**
- Create: `src/pipeline/constants.js`

**Step 1: Create constants module**

```javascript
// Shared configuration for the pipeline.
// All model names, limits, and timeouts in one place.

module.exports = {
  MODEL_EXPLORE: 'claude-haiku-4-5-20251001',
  MODEL_CODEGEN: 'claude-opus-4-6',

  MAX_API_RETRIES: 3,
  RETRY_STATUS_CODES: [429, 529, 502, 503],

  MAX_EXPLORATION_TURNS: 15,
  MAX_CODE_RETRIES: 3,

  MAX_TOKENS_DEFAULT: 16384,
  MAX_TOKENS_EXTENDED: 32768,

  EXECUTION_TIMEOUT_MS: 30_000,

  MAX_READ_ROWS: 50,
  MAX_UNIQUE_VALUES: 30,
  TOOL_RESULT_MAX_CHARS: 4000,
};
```

**Step 2: Verify**

Run: `bun -e "const c = require('./src/pipeline/constants'); console.log(c.MODEL_EXPLORE, c.MODEL_CODEGEN)"`
Expected: `claude-haiku-4-5-20251001 claude-opus-4-6`

**Step 3: Commit**

```bash
git add src/pipeline/constants.js
git commit -m "feat: extract shared pipeline constants"
```

---

### Task 3: API Client

**Files:**
- Create: `src/pipeline/api-client.js`

This is extracted from `evals/lib/agent.js:17-45` (callClaude function) with the retry logic from `app.js:811-867`.

**Step 1: Create API client module**

```javascript
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
```

**Step 2: Verify**

Run: `bun -e "const { callClaude } = require('./src/pipeline/api-client'); console.log(typeof callClaude)"`
Expected: `function`

**Step 3: Commit**

```bash
git add src/pipeline/api-client.js
git commit -m "feat: extract Anthropic API client with retry"
```

---

### Task 4: Tool System

**Files:**
- Create: `src/pipeline/tool-defs.json` (copy from `evals/lib/tool-definitions.json`)
- Create: `src/pipeline/tools.js` (adapted from `evals/lib/tools.js`)

**Step 1: Copy tool definitions**

Copy `evals/lib/tool-definitions.json` to `src/pipeline/tool-defs.json` (identical content).

**Step 2: Create tools module**

Adapted from `evals/lib/tools.js`. Uses constants from shared module. Same logic, cleaner imports.

```javascript
// Tool executor for the exploration agent.
// Creates a closure over parsed files and returns an executor function.

const XLSX = require('xlsx');
const { MAX_READ_ROWS, MAX_UNIQUE_VALUES } = require('./constants');

const sheetJsonCache = new WeakMap();
function getSheetRows(ws) {
  if (sheetJsonCache.has(ws)) return sheetJsonCache.get(ws);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  sheetJsonCache.set(ws, rows);
  return rows;
}

function parseWorkbook(buffer) {
  return XLSX.read(buffer, { type: 'buffer' });
}

function createToolExecutor(files) {
  const parsed = files.map(f => {
    const wb = parseWorkbook(f.buffer);
    return { name: f.name, buffer: f.buffer, wb };
  });

  function findFile(nameQuery) {
    const q = nameQuery.toLowerCase();
    return parsed.find(f => f.name.toLowerCase() === q)
        || parsed.find(f => f.name.toLowerCase().includes(q));
  }

  function getSheet(file, sheetName) {
    const name = sheetName || file.wb.SheetNames[0];
    const ws = file.wb.Sheets[name];
    if (!ws) return { ws: null, error: `Sheet "${name}" not found. Available: ${file.wb.SheetNames.join(', ')}` };
    return { ws };
  }

  function fileNotFound(nameQuery) {
    return { error: `File not found: "${nameQuery}". Available: ${parsed.map(f => f.name).join(', ')}` };
  }

  return function executeTool(name, input) {
    switch (name) {
      case 'list_files':
        return parsed.map(f => {
          const sheets = f.wb.SheetNames.map(n => {
            const ws = f.wb.Sheets[n];
            const ref = ws['!ref'];
            if (!ref) return { name: n, rows: 0, cols: 0 };
            const range = XLSX.utils.decode_range(ref);
            return { name: n, rows: range.e.r + 1, cols: range.e.c + 1 };
          });
          return { file: f.name, sheets };
        });

      case 'read_rows': {
        const file = findFile(input.file);
        if (!file) return fileNotFound(input.file);
        const { ws, error } = getSheet(file, input.sheet);
        if (error) return { error };
        const rows = getSheetRows(ws);
        const start = Math.max(0, input.start_row);
        const end = Math.min(rows.length, input.end_row, start + MAX_READ_ROWS);
        const result = [];
        for (let r = start; r < end; r++) {
          result.push({ row: r, cells: rows[r] || [] });
        }
        return { total_rows: rows.length, returned: result.length, rows: result };
      }

      case 'get_column_stats': {
        const file = findFile(input.file);
        if (!file) return fileNotFound(input.file);
        const { ws, error } = getSheet(file, input.sheet);
        if (error) return { error };
        const rows = getSheetRows(ws);
        const startRow = input.start_row ?? 0;
        const col = input.column;
        const types = {};
        const uniques = new Set();
        let count = 0, emptyCount = 0;
        for (let r = startRow; r < rows.length; r++) {
          const v = (rows[r] || [])[col];
          if (v === null || v === undefined || v === '') { emptyCount++; continue; }
          count++;
          types[typeof v] = (types[typeof v] || 0) + 1;
          if (uniques.size < MAX_UNIQUE_VALUES) uniques.add(String(v));
        }
        return {
          column: col, from_row: startRow, non_empty: count, empty: emptyCount, types,
          unique_count: uniques.size >= MAX_UNIQUE_VALUES ? `${MAX_UNIQUE_VALUES}+` : uniques.size,
          unique_values: uniques.size <= MAX_UNIQUE_VALUES ? [...uniques] : [...uniques].slice(0, MAX_UNIQUE_VALUES).concat(['...']),
        };
      }

      case 'find_rows': {
        const file = findFile(input.file);
        if (!file) return fileNotFound(input.file);
        const { ws, error } = getSheet(file, input.sheet);
        if (error) return { error };
        const rows = getSheetRows(ws);
        const col = input.column;
        const target = input.value;
        const max = input.max_results ?? 10;
        const results = [];
        for (let r = 0; r < rows.length && results.length < max; r++) {
          const v = (rows[r] || [])[col];
          if (v !== null && String(v) === target) results.push({ row: r, cells: rows[r] || [] });
        }
        return { matches: results.length, rows: results };
      }

      case 'compare_keys': {
        const f1 = findFile(input.file1);
        const f2 = findFile(input.file2);
        if (!f1) return fileNotFound(input.file1);
        if (!f2) return fileNotFound(input.file2);
        const { ws: ws1, error: e1 } = getSheet(f1, input.sheet1);
        if (e1) return { error: e1 };
        const { ws: ws2, error: e2 } = getSheet(f2, input.sheet2);
        if (e2) return { error: e2 };
        const rows1 = getSheetRows(ws1);
        const rows2 = getSheetRows(ws2);
        const keys1 = new Set();
        for (let r = input.start1; r < rows1.length; r++) {
          const v = (rows1[r] || [])[input.col1];
          if (v !== null && v !== undefined && String(v).trim()) keys1.add(String(v).trim());
        }
        const keys2 = new Set();
        for (let r = input.start2; r < rows2.length; r++) {
          const v = (rows2[r] || [])[input.col2];
          if (v !== null && v !== undefined && String(v).trim()) keys2.add(String(v).trim());
        }
        let shared = 0;
        const only1 = [];
        for (const k of keys1) { if (keys2.has(k)) shared++; else only1.push(k); }
        const only2 = [];
        for (const k of keys2) { if (!keys1.has(k)) only2.push(k); }
        return {
          file1_keys: keys1.size, file2_keys: keys2.size, shared,
          only_in_file1: only1.length, only_in_file2: only2.length,
          sample_only_file1: only1.slice(0, 5), sample_only_file2: only2.slice(0, 5),
        };
      }

      case 'submit_report':
        return { error: 'submit_report is handled by the agent loop' };

      case 'generate_code':
        return { error: 'generate_code is handled by the agent loop' };

      default:
        return { error: `Unknown tool: ${name}` };
    }
  };
}

module.exports = { createToolExecutor, parseWorkbook, getSheetRows };
```

**Step 3: Verify**

Run: `bun -e "const { createToolExecutor } = require('./src/pipeline/tools'); console.log(typeof createToolExecutor)"`
Expected: `function`

**Step 4: Commit**

```bash
git add src/pipeline/tool-defs.json src/pipeline/tools.js
git commit -m "feat: extract tool system into shared module"
```

---

### Task 5: Prompts

**Files:**
- Create: `src/pipeline/prompts/exploration.txt` (copy from `evals/lib/exploration-prompt.txt`)
- Create: `src/pipeline/prompts/codegen.txt` (copy from `evals/lib/codegen-prompt-template.txt`)

**Step 1: Copy prompt files**

Copy `evals/lib/exploration-prompt.txt` → `src/pipeline/prompts/exploration.txt`
Copy `evals/lib/codegen-prompt-template.txt` → `src/pipeline/prompts/codegen.txt`

Content is identical. These are the system prompts for Haiku (exploration) and Opus (code gen).

**Step 2: Verify**

Run: `bun -e "const fs = require('fs'); console.log(fs.readFileSync('./src/pipeline/prompts/exploration.txt', 'utf-8').slice(0, 50))"`
Expected: `You are a data exploration agent. Your job is to t`

**Step 3: Commit**

```bash
git add src/pipeline/prompts/
git commit -m "feat: move system prompts to shared location"
```

---

### Task 6: Explore Module

**Files:**
- Create: `src/pipeline/explore.js`

Extracted from `evals/lib/agent.js:47-100` (runExploration). Uses shared API client and tool executor. Accepts an `onTurn` callback for progress reporting instead of `process.stdout.write`.

**Step 1: Create explore module**

```javascript
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
```

**Step 2: Verify**

Run: `bun -e "const { explore } = require('./src/pipeline/explore'); console.log(typeof explore)"`
Expected: `function`

**Step 3: Commit**

```bash
git add src/pipeline/explore.js
git commit -m "feat: extract exploration agent into shared module"
```

---

### Task 7: Codegen Module

**Files:**
- Create: `src/pipeline/codegen.js`

Extracted from `evals/lib/agent.js:102-131` (runCodeGen). Uses shared API client. Accepts the exploration report and builds the system prompt from the template.

**Step 1: Create codegen module**

```javascript
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
```

**Step 2: Verify**

Run: `bun -e "const { codegen } = require('./src/pipeline/codegen'); console.log(typeof codegen)"`
Expected: `function`

**Step 3: Commit**

```bash
git add src/pipeline/codegen.js
git commit -m "feat: extract code generation agent into shared module"
```

---

### Task 8: Execute Module

**Files:**
- Create: `src/pipeline/execute.js`

Moved from `evals/lib/execute.js` with constants from shared module.

**Step 1: Create execute module**

```javascript
// Headless code execution.
// Runs LLM-generated code in a Function sandbox with XLSX + JSZip.

const XLSX = require('xlsx');
const JSZip = require('jszip');
const { EXECUTION_TIMEOUT_MS } = require('./constants');

async function execute(code, files) {
  const logs = [];
  const log = (msg) => logs.push(String(msg));

  const fn = new Function('files', 'XLSX', 'JSZip', 'log',
    '"use strict"; return (async () => {\n' + code + '\n})();'
  );

  const result = await Promise.race([
    fn(files, XLSX, JSZip, log),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Execution timed out (30s)')), EXECUTION_TIMEOUT_MS)
    ),
  ]);

  if (!result || !result.buffer) {
    throw new Error('Code must return { buffer, filename }');
  }

  const buffer = result.buffer instanceof ArrayBuffer
    ? Buffer.from(result.buffer)
    : Buffer.isBuffer(result.buffer) ? result.buffer : Buffer.from(result.buffer);

  return { buffer, filename: result.filename || 'output.xlsx', logs };
}

module.exports = { execute };
```

**Step 2: Verify**

Run: `bun -e "const { execute } = require('./src/pipeline/execute'); console.log(typeof execute)"`
Expected: `function`

**Step 3: Commit**

```bash
git add src/pipeline/execute.js
git commit -m "feat: extract code executor into shared module"
```

---

### Task 9: Verify Module

**Files:**
- Create: `src/pipeline/verify.js`

Moved from `evals/lib/verify.js` unchanged. This is the three-layer verifier (structure, values, styling).

**Step 1: Copy verify module**

Copy `evals/lib/verify.js` to `src/pipeline/verify.js`. Content is identical — it already uses require('xlsx') and require('jszip').

**Step 2: Verify**

Run: `bun -e "const { verifyOutput } = require('./src/pipeline/verify'); console.log(typeof verifyOutput)"`
Expected: `function`

**Step 3: Commit**

```bash
git add src/pipeline/verify.js
git commit -m "feat: move verifier into shared pipeline module"
```

---

### Task 10: Pipeline Orchestrator

**Files:**
- Create: `src/pipeline/index.js`

Composes explore → codegen → execute into a single function. Accepts an `onEvent` callback that consumers (server, evals) use for progress reporting.

**Step 1: Create orchestrator**

```javascript
// Pipeline orchestrator: explore → codegen → execute.
// Each phase is a standalone module; this composes them with event callbacks.

const { explore } = require('./explore');
const { codegen } = require('./codegen');
const { execute } = require('./execute');
const { verifyOutput } = require('./verify');

async function runPipeline({ apiKey, files, prompt, expected, onEvent, signal }) {
  const result = {
    report: null,
    code: null,
    output: null,
    verification: null,
    meta: { explore: null, codegen: null },
  };

  // Phase 1: Explore
  onEvent?.({ phase: 'exploring', status: 'started' });
  const exploration = await explore({
    apiKey, files, prompt, signal,
    onTurn: (turn) => onEvent?.({ phase: 'exploring', ...turn }),
  });
  result.report = exploration.report;
  result.meta.explore = exploration.meta;
  onEvent?.({ phase: 'exploring', status: 'complete', turns: exploration.meta.turns });

  // Phase 2: Generate code
  onEvent?.({ phase: 'codegen', status: 'started' });
  const codeResult = await codegen({
    apiKey, prompt, report: exploration.report, signal,
    onAttempt: (info) => onEvent?.({ phase: 'codegen', ...info }),
  });
  result.code = codeResult;
  result.meta.codegen = codeResult.meta;
  onEvent?.({ phase: 'codegen', status: 'complete', attempts: codeResult.meta.attempts });

  // Phase 3: Execute
  onEvent?.({ phase: 'executing', status: 'started' });
  const output = await execute(codeResult.code, files);
  result.output = output;
  onEvent?.({ phase: 'executing', status: 'complete', size: output.buffer.length });

  // Phase 4: Verify (optional — only if expected is provided)
  if (expected) {
    onEvent?.({ phase: 'verifying', status: 'started' });
    result.verification = await verifyOutput(output.buffer, expected);
    onEvent?.({ phase: 'verifying', status: 'complete', pass: result.verification.pass });
  }

  return result;
}

// Re-export individual modules for direct use
module.exports = {
  runPipeline,
  explore,
  codegen,
  execute,
  verifyOutput,
};
```

**Step 2: Verify**

Run: `bun -e "const p = require('./src/pipeline'); console.log(Object.keys(p).join(', '))"`
Expected: `runPipeline, explore, codegen, execute, verifyOutput`

**Step 3: Commit**

```bash
git add src/pipeline/index.js
git commit -m "feat: create pipeline orchestrator composing all modules"
```

---

### Task 11: Migrate Evals

**Files:**
- Modify: `evals/run.js`
- Modify: `evals/package.json` (remove duplicated deps)

Update evals to import from `src/pipeline/` instead of `evals/lib/`. The eval-specific lib files (`agent.js`, `tools.js`, `execute.js`, `verify.js`) are no longer needed — the pipeline modules replace them. Keep the prompt files in `evals/lib/` as dead code for now (they're still referenced by old results).

**Step 1: Rewrite evals/run.js**

```javascript
#!/usr/bin/env bun
// Eval runner: runs the full pipeline against fixtures — explore, generate, execute, verify.
// Usage: ANTHROPIC_API_KEY=sk-ant-... bun evals/run.js [fixture-name]

const fs = require('fs');
const path = require('path');
const { runPipeline } = require('../src/pipeline');
const { verifyOutput } = require('../src/pipeline/verify');

function scoreReport(report, expected) {
  const scores = { files_found: false, relationships_correct: false };
  if (report.files && report.files.length > 0) scores.files_found = true;
  if (expected.checks?.join_key && report.relationships) {
    scores.relationships_correct = report.relationships.some(
      r => r.join_key.toLowerCase().includes(expected.checks.join_key.toLowerCase())
    );
  } else {
    scores.relationships_correct = true;
  }
  return scores;
}

async function runFixture(apiKey, fixturePath) {
  const fixtureName = path.basename(fixturePath);
  const expected = JSON.parse(fs.readFileSync(path.join(fixturePath, 'expected.json'), 'utf-8'));

  const xlsxFiles = fs.readdirSync(fixturePath).filter(f => f.endsWith('.xlsx'));
  const files = xlsxFiles.map(f => ({
    name: f,
    buffer: fs.readFileSync(path.join(fixturePath, f)),
  }));

  console.log(`\n── ${fixtureName} ──`);
  console.log(`  Files: ${files.map(f => f.name).join(', ')}`);
  console.log(`  Prompt: ${expected.prompt.slice(0, 80)}...`);

  const t0 = Date.now();

  const result = await runPipeline({
    apiKey, files, prompt: expected.prompt, expected,
    onEvent: (e) => {
      if (e.status === 'started') process.stdout.write(`  Phase: ${e.phase}...`);
      else if (e.status === 'complete') process.stdout.write(` done\n`);
      else if (e.turn) process.stdout.write(` t${e.turn}`);
    },
  });

  const reportScore = scoreReport(result.report, expected);
  const verification = result.verification;

  // Print verification detail
  const tag = (pass) => pass === 'pass' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  Structure: ${tag(verification.structure)} | Values: ${tag(verification.values)} | Styling: ${tag(verification.styling)}`);
  console.log(`  Output: ${verification.row_count} rows, sheets: ${verification.sheet_names.join(', ')}`);
  if (verification.errors.length > 0) {
    for (const err of verification.errors) {
      console.log(`    \x1b[31m✗\x1b[0m ${err}`);
    }
  }

  return {
    fixture: fixtureName,
    reportScore,
    codeGenerated: true,
    executed: true,
    verification,
    explorationTurns: result.meta.explore.turns,
    codeGenAttempts: result.meta.codegen.attempts,
    tokens: {
      exploration: result.meta.explore.inputTokens + result.meta.explore.outputTokens,
      codegen: result.meta.codegen.inputTokens + result.meta.codegen.outputTokens,
    },
    latencyMs: Date.now() - t0,
  };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Set ANTHROPIC_API_KEY environment variable');
    process.exit(1);
  }

  const fixtureFilter = process.argv[2];
  const fixturesDir = path.join(__dirname, 'fixtures');
  let fixtures = fs.readdirSync(fixturesDir).filter(f =>
    fs.statSync(path.join(fixturesDir, f)).isDirectory()
  );

  if (fixtureFilter) {
    fixtures = fixtures.filter(f => f.includes(fixtureFilter));
  }

  console.log(`Running ${fixtures.length} fixture(s)...\n`);

  const results = [];
  for (const fixture of fixtures) {
    try {
      const result = await runFixture(apiKey, path.join(fixturesDir, fixture));
      results.push(result);

      const passed = result.verification?.pass;
      const styled = result.verification?.styling_pass;
      const label = !result.executed ? '\x1b[31mEXEC_FAIL\x1b[0m'
        : passed && styled ? '\x1b[32mPASS\x1b[0m'
        : passed ? '\x1b[33mPASS (no styling)\x1b[0m'
        : '\x1b[31mFAIL\x1b[0m';
      console.log(`  Result: ${label}`);
    } catch (err) {
      console.log(`  Result: \x1b[31mERROR\x1b[0m — ${err.message}`);
      results.push({ fixture, error: err.message });
    }
  }

  // Save results
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const resultFile = path.join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  const passed = results.filter(r => r.verification?.pass);
  const styled = results.filter(r => r.verification?.styling_pass);
  const errored = results.filter(r => r.error);

  fs.writeFileSync(resultFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    model_explore: 'claude-haiku-4-5-20251001',
    model_codegen: 'claude-opus-4-6',
    fixtures: results,
    summary: {
      total: results.length,
      passed: passed.length,
      styling_passed: styled.length,
      errors: errored.length,
      total_tokens: results.reduce((sum, r) => sum + (r.tokens?.exploration || 0) + (r.tokens?.codegen || 0), 0),
    },
  }, null, 2));

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results saved to: ${path.relative(process.cwd(), resultFile)}`);
  console.log(`Summary: ${passed.length}/${results.length} passed, ${styled.length}/${results.length} styled`);
  if (errored.length) console.log(`  Errors: ${errored.length}`);
  const totalTokens = results.reduce((sum, r) => sum + (r.tokens?.exploration || 0) + (r.tokens?.codegen || 0), 0);
  console.log(`  Total tokens: ${(totalTokens / 1000).toFixed(1)}k`);
}

main().catch(err => { console.error(err); process.exit(1); });
```

**Step 2: Update evals/package.json**

Remove the `xlsx` and `jszip` dependencies — they come from root now.

```json
{
  "name": "evals",
  "private": true,
  "devDependencies": {
    "@types/bun": "latest"
  },
  "peerDependencies": {
    "typescript": "^5"
  }
}
```

**Step 3: Verify evals load correctly**

Run: `cd /Users/work/Documents/build/lab/excel && bun -e "require('./evals/run')"`
Expected: Should print usage error about ANTHROPIC_API_KEY (not a module resolution error)

**Step 4: Commit**

```bash
git add evals/run.js evals/package.json
git commit -m "feat: migrate evals to use shared pipeline modules"
```

---

### Task 12: HTTP Server

**Files:**
- Create: `src/server.js`

Bun + Hono server that:
1. Serves static files (index.html, app.js)
2. POST /api/process — accepts multipart files + prompt + apiKey, streams SSE events
3. GET /api/health — health check

**Step 1: Create server**

```javascript
// HTTP server wrapping the pipeline.
// POST /api/process streams SSE events as the pipeline runs.

const { Hono } = require('hono');
const { serveStatic } = require('hono/bun');
const { runPipeline } = require('./pipeline');

const app = new Hono();

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Pipeline endpoint — streams SSE events
app.post('/api/process', async (c) => {
  const formData = await c.req.formData();
  const apiKey = formData.get('apiKey');
  const prompt = formData.get('prompt');

  if (!apiKey || !prompt) {
    return c.json({ error: 'Missing apiKey or prompt' }, 400);
  }

  // Extract uploaded files
  const files = [];
  for (const [key, value] of formData.entries()) {
    if (key === 'files' && value instanceof File) {
      const arrayBuffer = await value.arrayBuffer();
      files.push({ name: value.name, buffer: Buffer.from(arrayBuffer) });
    }
  }

  if (files.length === 0) {
    return c.json({ error: 'No files uploaded' }, 400);
  }

  // Stream SSE response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(event, data) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const result = await runPipeline({
          apiKey, files, prompt,
          onEvent: (e) => send('phase', e),
        });

        // Send final result with buffer as base64
        send('complete', {
          filename: result.output.filename,
          buffer: result.output.buffer.toString('base64'),
          code: result.code.code,
          explanation: result.code.explanation,
          report: result.report,
          logs: result.output.logs,
          meta: result.meta,
        });
      } catch (err) {
        send('error', { message: err.message });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// Static files — served after API routes so API takes priority
app.use('/*', serveStatic({ root: './' }));

const port = process.env.PORT || 3000;
console.log(`Excelius server running on http://localhost:${port}`);
export default { port, fetch: app.fetch };
```

**Step 2: Verify server starts**

Run: `cd /Users/work/Documents/build/lab/excel && timeout 3 bun run src/server.js || true`
Expected: `Excelius server running on http://localhost:3000` (then timeout exits)

**Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat: add Hono HTTP server with SSE pipeline streaming"
```

---

### Task 13: Rewrite Frontend as Thin Client

**Files:**
- Rewrite: `app.js`

The new `app.js` is ~300 lines. It keeps:
- State management (files, output)
- DOM manipulation (file list, preview, tabs, pipeline viz)
- File upload/download
- Keyboard shortcuts

It replaces:
- All Anthropic API code → single POST to `/api/process`
- All tool definitions and execution → deleted (lives on server)
- All system prompts → deleted (lives on server)
- Sandbox execution (iframe + worker) → deleted (server executes)
- ~800 lines of agent/API/tool/sandbox code → ~30 lines of SSE client

**Step 1: Rewrite app.js**

```javascript
// Excelius frontend — thin client that communicates with the server.
// All pipeline logic (exploration, codegen, execution) runs server-side.

/* global XLSX */

// ── State ─────────────────────────────────────────────────
const state = {
  files: [],       // { name, buffer (ArrayBuffer), wb (parsed), summary, generated? }
  outputBuffer: null,
  outputFilename: null,
  abortController: null,
  running: false,
  tokens: { explore: { input: 0, output: 0 }, codegen: { input: 0, output: 0 } },
};

// ── Workbook Helpers ──────────────────────────────────────
function parseWorkbook(buffer) {
  return XLSX.read(buffer, { type: 'array' });
}

function summarizeWorkbook(wb) {
  return wb.SheetNames.map(n => {
    const ws = wb.Sheets[n];
    const ref = ws['!ref'];
    if (!ref) return `${n}: empty`;
    const range = XLSX.utils.decode_range(ref);
    return `${n} (${range.e.r + 1} rows × ${range.e.c + 1} cols)`;
  }).join(', ');
}

const sheetJsonCache = new WeakMap();
function getSheetRows(ws) {
  if (sheetJsonCache.has(ws)) return sheetJsonCache.get(ws);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  sheetJsonCache.set(ws, rows);
  return rows;
}

const MAX_PREVIEW_ROWS = 50;

// ── DOM Refs ──────────────────────────────────────────────
const $apiKey = document.getElementById('apiKey');
const $dropZone = document.getElementById('dropZone');
const $fileInput = document.getElementById('fileInput');
const $fileList = document.getElementById('fileList');
const $prompt = document.getElementById('prompt');
const $runBtn = document.getElementById('runBtn');
const $status = document.getElementById('status');
const $codePanel = document.getElementById('codePanel');
const $logPanel = document.getElementById('logPanel');
const $previewPanel = document.getElementById('previewPanel');
const $cancelBtn = document.getElementById('cancelBtn');
const $tokenCounter = document.getElementById('tokenCounter');
const $downloadBtn = document.getElementById('downloadBtn');
const $pipeline = document.getElementById('pipelineViz');

// ── UI Helpers ────────────────────────────────────────────
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) { return String(s).replace(/[&<>"']/g, c => ESC_MAP[c]); }

function logTo(panel, text, cls = 'log-info') {
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = text;
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;
}

function clearPanel(panel) { panel.innerHTML = ''; }
function setStatus(text) { $status.textContent = text; }

function updateRunBtn() {
  $runBtn.disabled = state.running || !(state.files.length > 0 && $apiKey.value.trim() && $prompt.value.trim());
}

function switchTab(name) {
  document.querySelectorAll('.panel-tab').forEach(t => {
    const isActive = t.dataset.tab === name;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', isActive);
  });
  $codePanel.classList.toggle('hidden', name !== 'code');
  $previewPanel.classList.toggle('hidden', name !== 'preview');
}

function updateTokenCounter() {
  const ei = state.tokens.explore.input;
  const eo = state.tokens.explore.output;
  const ci = state.tokens.codegen.input;
  const co = state.tokens.codegen.output;
  const total = ei + eo + ci + co;
  if (total === 0) { $tokenCounter.textContent = ''; return; }
  const fmtK = n => (n / 1000).toFixed(1) + 'k';
  $tokenCounter.textContent = `Explore: \u2191${fmtK(ei)} \u2193${fmtK(eo)} | Code: \u2191${fmtK(ci)} \u2193${fmtK(co)}`;
}

function updatePipeline(phase) {
  if ($pipeline) $pipeline.dataset.phase = phase;
}

// ── Panel Tabs ────────────────────────────────────────────
document.querySelectorAll('.panel-tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ── API Key Persistence ───────────────────────────────────
$apiKey.value = localStorage.getItem('excel-agent-api-key') || '';
$apiKey.addEventListener('input', () => {
  localStorage.setItem('excel-agent-api-key', $apiKey.value);
  updateRunBtn();
});

// ── File Drop / Upload ────────────────────────────────────
$dropZone.addEventListener('click', () => $fileInput.click());
$dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $fileInput.click(); }
});
$fileInput.addEventListener('change', (e) => addFiles(e.target.files));

$dropZone.addEventListener('dragover', (e) => { e.preventDefault(); $dropZone.classList.add('dragover'); });
$dropZone.addEventListener('dragleave', () => $dropZone.classList.remove('dragover'));
$dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  $dropZone.classList.remove('dragover');
  addFiles(e.dataTransfer.files);
});

$prompt.addEventListener('input', updateRunBtn);
$prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $runBtn.click(); }
});

function removeGeneratedByName(name) {
  const idx = state.files.findIndex(f => f.name === name && f.generated);
  if (idx !== -1) state.files.splice(idx, 1);
}

async function addFiles(fileListObj) {
  for (const file of fileListObj) {
    if (state.files.some(f => f.name === file.name && !f.generated)) continue;
    removeGeneratedByName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const wb = parseWorkbook(buffer);
      state.files.push({ name: file.name, buffer, wb, summary: summarizeWorkbook(wb) });
    } catch (err) {
      logTo($logPanel, `Failed to read "${file.name}": ${err.message}`, 'log-error');
    }
  }
  $fileInput.value = '';
  renderFileList();
  updateRunBtn();
}

function removeFile(index) {
  state.files.splice(index, 1);
  renderFileList();
  updateRunBtn();
}

$fileList.addEventListener('click', (e) => {
  const btn = e.target.closest('.remove');
  if (btn) removeFile(parseInt(btn.dataset.idx, 10));
});

function renderFileList() {
  $fileList.innerHTML = state.files.map((f, i) => `
    <div class="file-item${f.generated ? ' generated' : ''}">
      <div class="file-item-top">
        <span class="name">${esc(f.name)}${f.generated ? '<span class="badge badge-generated">generated</span>' : ''}</span>
        <button class="remove" data-idx="${i}" aria-label="Remove ${esc(f.name)}">&times;</button>
      </div>
      <div class="sheet-summary">${esc(f.summary)}</div>
    </div>
  `).join('');
}

function showPreview(wb) {
  if (!wb) { $previewPanel.innerHTML = '<div class="preview-empty">Could not preview output</div>'; return; }
  try {
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = getSheetRows(ws);
    const maxRows = Math.min(rows.length, MAX_PREVIEW_ROWS);
    if (maxRows === 0) { $previewPanel.innerHTML = '<div class="preview-empty">Output is empty</div>'; return; }
    const parts = ['<table class="preview-table"><thead><tr>'];
    const headers = rows[0] || [];
    for (const h of headers) parts.push(`<th>${esc(h ?? '')}</th>`);
    parts.push('</tr></thead><tbody>');
    for (let r = 1; r < maxRows; r++) {
      parts.push('<tr>');
      const row = rows[r] || [];
      for (let c = 0; c < headers.length; c++) parts.push(`<td>${esc(row[c] ?? '')}</td>`);
      parts.push('</tr>');
    }
    parts.push('</tbody></table>');
    if (rows.length > MAX_PREVIEW_ROWS) parts.push(`<div class="preview-empty">${rows.length - MAX_PREVIEW_ROWS} more rows...</div>`);
    $previewPanel.innerHTML = parts.join('');
  } catch (err) {
    $previewPanel.innerHTML = `<div class="preview-empty">Could not preview: ${esc(err.message)}</div>`;
  }
}

function addGeneratedFile(buffer, filename) {
  removeGeneratedByName(filename);
  let wb = null;
  try { wb = parseWorkbook(buffer); } catch {}
  state.files.push({ name: filename, buffer, wb, summary: wb ? summarizeWorkbook(wb) : '(could not parse)', generated: true });
  renderFileList();
}

// ── Download ──────────────────────────────────────────────
function downloadFile(buffer, filename = 'output.xlsx') {
  if (!filename.endsWith('.xlsx')) filename += '.xlsx';
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

$downloadBtn.addEventListener('click', () => {
  if (state.outputBuffer) downloadFile(state.outputBuffer, state.outputFilename);
});

// ── SSE Pipeline Client ──────────────────────────────────
// Sends files + prompt to the server, reads SSE events for progress.

async function runPipeline() {
  const apiKey = $apiKey.value.trim();
  const prompt = $prompt.value.trim();
  if (!apiKey || !prompt || state.files.length === 0) return;

  clearPanel($codePanel);
  clearPanel($logPanel);
  $downloadBtn.hidden = true;
  state.outputBuffer = null;
  state.outputFilename = null;
  state.running = true;
  state.abortController = new AbortController();
  document.body.classList.add('running');
  $runBtn.disabled = true;
  $cancelBtn.hidden = false;
  state.tokens = { explore: { input: 0, output: 0 }, codegen: { input: 0, output: 0 } };
  updateTokenCounter();
  updatePipeline('idle');

  try {
    // Build multipart form data
    const formData = new FormData();
    formData.append('apiKey', apiKey);
    formData.append('prompt', prompt);
    for (const f of state.files) {
      const blob = new Blob([f.buffer], { type: 'application/octet-stream' });
      formData.append('files', blob, f.name);
    }

    const response = await fetch('/api/process', {
      method: 'POST',
      body: formData,
      signal: state.abortController.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error || `Server error: ${response.status}`);
    }

    // Read SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events
      const parts = buffer.split('\n\n');
      buffer = parts.pop(); // keep incomplete chunk

      for (const part of parts) {
        let eventType = 'message';
        let data = '';
        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (!data) continue;

        const parsed = JSON.parse(data);
        handleSSEEvent(eventType, parsed);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('Cancelled');
      logTo($logPanel, 'Run cancelled by user.', 'log-warn');
    } else {
      setStatus('Error');
      logTo($logPanel, `Error: ${err.message}`, 'log-error');
    }
    updatePipeline('error');
  } finally {
    state.running = false;
    document.body.classList.remove('running');
    state.abortController = null;
    $cancelBtn.hidden = true;
    updateRunBtn();
  }
}

function handleSSEEvent(type, data) {
  if (type === 'phase') {
    // Update pipeline visualization
    if (data.phase) updatePipeline(data.phase);

    if (data.status === 'started') {
      const labels = { exploring: 'Exploring...', codegen: 'Generating code...', executing: 'Executing...', verifying: 'Verifying...' };
      setStatus(labels[data.phase] || data.phase);
      logTo($logPanel, `── ${data.phase} ──`, 'log-success');
    }
    if (data.turn) {
      const toolStr = data.tools ? data.tools.join(', ') : '';
      logTo($logPanel, `  Turn ${data.turn}: ${toolStr}`, 'log-info');
    }
  }

  if (type === 'complete') {
    // Decode base64 buffer
    const raw = atob(data.buffer);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const outputBuffer = bytes.buffer;

    state.outputBuffer = outputBuffer;
    state.outputFilename = data.filename;
    $downloadBtn.hidden = false;

    // Show code
    $codePanel.textContent = data.code || '';
    if (data.explanation) logTo($logPanel, `Code: ${data.explanation}`, 'log-meta');

    // Update tokens
    if (data.meta?.explore) {
      state.tokens.explore.input = data.meta.explore.inputTokens || 0;
      state.tokens.explore.output = data.meta.explore.outputTokens || 0;
    }
    if (data.meta?.codegen) {
      state.tokens.codegen.input = data.meta.codegen.inputTokens || 0;
      state.tokens.codegen.output = data.meta.codegen.outputTokens || 0;
    }
    updateTokenCounter();

    // Show logs
    if (data.logs) {
      for (const log of data.logs) logTo($logPanel, log, 'log-info');
    }

    // Preview
    let wb = null;
    try { wb = parseWorkbook(outputBuffer); } catch {}
    addGeneratedFile(outputBuffer, data.filename);
    showPreview(wb);
    switchTab('preview');

    updatePipeline('done');
    setStatus('Done — ask a follow-up or download');
  }

  if (type === 'error') {
    logTo($logPanel, `Error: ${data.message}`, 'log-error');
    setStatus('Error');
    updatePipeline('error');
  }
}

// ── Event Bindings ────────────────────────────────────────
$cancelBtn.addEventListener('click', () => {
  if (state.abortController) {
    state.abortController.abort();
    logTo($logPanel, 'Cancelling...', 'log-warn');
  }
});

$runBtn.addEventListener('click', runPipeline);
```

**Step 2: Verify static serving**

Run server: `cd /Users/work/Documents/build/lab/excel && bun run src/server.js &`
Then: `curl -s http://localhost:3000/api/health`
Expected: `{"status":"ok"}`
Then: `curl -s http://localhost:3000/ | head -5`
Expected: First 5 lines of index.html
Then: `kill %1`

**Step 3: Commit**

```bash
git add app.js
git commit -m "feat: rewrite frontend as thin SSE client"
```

---

### Task 14: Clean Up Old Eval Lib Files

**Files:**
- Delete: `evals/lib/agent.js`
- Delete: `evals/lib/tools.js`
- Delete: `evals/lib/execute.js`
- Delete: `evals/lib/verify.js`
- Delete: `evals/lib/tool-definitions.json`
- Delete: `evals/lib/exploration-prompt.txt`
- Delete: `evals/lib/codegen-prompt-template.txt`

These are now replaced by `src/pipeline/` modules. `generate-fixtures.js` stays (it only uses `xlsx` directly).

**Step 1: Delete old files**

```bash
rm evals/lib/agent.js evals/lib/tools.js evals/lib/execute.js evals/lib/verify.js
rm evals/lib/tool-definitions.json evals/lib/exploration-prompt.txt evals/lib/codegen-prompt-template.txt
```

**Step 2: Verify evals still load**

Run: `bun -e "require('./evals/run')"`
Expected: Should print API key error (not module resolution error)

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove old eval lib files replaced by src/pipeline"
```

---

### Task 15: End-to-End Verification

**Files:** None (testing only)

**Step 1: Verify all pipeline modules load**

Run:
```bash
bun -e "
const p = require('./src/pipeline');
console.log('Pipeline exports:', Object.keys(p).join(', '));
console.log('OK');
"
```
Expected: `Pipeline exports: runPipeline, explore, codegen, execute, verifyOutput` then `OK`

**Step 2: Verify server starts and serves static files**

Run:
```bash
bun run src/server.js &
sleep 1
curl -s http://localhost:3000/api/health | grep ok
curl -s http://localhost:3000/ | grep -c "Excelius"
curl -s http://localhost:3000/app.js | grep -c "handleSSEEvent"
kill %1
```
Expected: `{"status":"ok"}`, `1` (or more), `1` (or more)

**Step 3: Run evals (requires API key)**

Run: `ANTHROPIC_API_KEY=<key> bun evals/run.js`
Expected: 4/4 fixtures pass (structure + values). This confirms the shared pipeline modules work correctly.

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: modular pipeline architecture complete"
```

---

## Summary of Changes

| Before | After |
|--------|-------|
| `app.js`: 1184-line monolith | `app.js`: ~300-line thin client |
| `evals/lib/`: 5 duplicated modules | `src/pipeline/`: single source of truth |
| Direct browser → Anthropic API | Browser → Server → Anthropic API |
| Browser-side sandbox execution | Server-side execution |
| No HTTP server | Hono server with SSE streaming |
| `evals/lib/agent.js` + `app.js` duplication | `src/pipeline/{explore,codegen}.js` shared |

## Future Extension Points

- **Recipes**: Save `codegen` output + file fingerprint. Skip explore+codegen on match. Plug into `runPipeline` before Phase 1.
- **Batch**: Call `runPipeline` in a loop with same recipe code, skip Phases 1-2.
- **Exceptions**: `onEvent` callback already emits structured events. Persist them to a store. Add `GET /api/jobs` endpoint.
- **Job Queue**: Wrap `runPipeline` calls in a queue. Add `POST /api/jobs` (enqueue) + `GET /api/jobs/:id/events` (SSE).
