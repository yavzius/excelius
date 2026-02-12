// ── State ──────────────────────────────────────────────────
const state = {
  files: [],      // { name, buffer (ArrayBuffer), wb (parsed workbook) }
  outputBuffer: null,
  outputFilename: null,
};

// ── DOM refs ───────────────────────────────────────────────
const $apiKey = document.getElementById('apiKey');
const $dropZone = document.getElementById('dropZone');
const $fileInput = document.getElementById('fileInput');
const $fileList = document.getElementById('fileList');
const $prompt = document.getElementById('prompt');
const $runBtn = document.getElementById('runBtn');
const $modelSelect = document.getElementById('modelSelect');
const $status = document.getElementById('status');
const $codePanel = document.getElementById('codePanel');
const $logPanel = document.getElementById('logPanel');
const $downloadBtn = document.getElementById('downloadBtn');

// ── API Key persistence ────────────────────────────────────
$apiKey.value = localStorage.getItem('excel-agent-api-key') || '';
$apiKey.addEventListener('input', () => {
  localStorage.setItem('excel-agent-api-key', $apiKey.value);
  updateRunBtn();
});

// ── Helpers ────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
  $runBtn.disabled = !(state.files.length > 0 && $apiKey.value.trim() && $prompt.value.trim());
}

// ── File Drop / Upload ─────────────────────────────────────
$dropZone.addEventListener('click', () => $fileInput.click());
$fileInput.addEventListener('change', (e) => addFiles(e.target.files));

$dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  $dropZone.classList.add('dragover');
});
$dropZone.addEventListener('dragleave', () => $dropZone.classList.remove('dragover'));
$dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  $dropZone.classList.remove('dragover');
  addFiles(e.dataTransfer.files);
});

$prompt.addEventListener('input', updateRunBtn);

async function addFiles(fileListObj) {
  for (const file of fileListObj) {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const summary = wb.SheetNames.map(n => {
      const ws = wb.Sheets[n];
      const ref = ws['!ref'];
      if (!ref) return `${n}: empty`;
      const range = XLSX.utils.decode_range(ref);
      return `${n} (${range.e.r + 1} rows × ${range.e.c + 1} cols)`;
    }).join(', ');
    state.files.push({ name: file.name, buffer, wb, summary });
  }
  renderFileList();
  updateRunBtn();
}

function removeFile(index) {
  state.files.splice(index, 1);
  renderFileList();
  updateRunBtn();
}

function renderFileList() {
  $fileList.innerHTML = state.files.map((f, i) => `
    <div class="file-item">
      <div class="file-item-top">
        <span class="name">${esc(f.name)}</span>
        <button class="remove" data-idx="${i}">&times;</button>
      </div>
      <div class="sheet-summary">${esc(f.summary)}</div>
    </div>
  `).join('');
  $fileList.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', () => removeFile(parseInt(btn.dataset.idx)));
  });
}

// ── Tool Definitions for Claude ────────────────────────────
// Claude gets these tools to explore the files before writing code.

function findFile(nameQuery) {
  return state.files.find(f =>
    f.name.toLowerCase().includes(nameQuery.toLowerCase())
  );
}

function getSheet(file, sheetName) {
  const name = sheetName || file.wb.SheetNames[0];
  return { ws: file.wb.Sheets[name], name };
}

function excelDateToStr(serial) {
  const d = new Date((serial - 25569) * 86400000);
  return (d.getUTCMonth() + 1).toString().padStart(2, '0') + '/' +
         d.getUTCDate().toString().padStart(2, '0') + '/' +
         d.getUTCFullYear();
}

function isDateSerial(v) {
  return typeof v === 'number' && v > 365 && v < 73415 && Number.isInteger(v);
}

function formatCellValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && isDateSerial(v)) return excelDateToStr(v);
  return v;
}

const TOOLS = [
  {
    name: 'list_files',
    description: 'List all uploaded files with their sheet names, row counts, and column counts.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_rows',
    description: 'Read actual cell values from specific rows of a file. Use this to understand file structure, headers, where data starts, what values look like. Returns array of rows with cell values. Excel date serial numbers are auto-converted to date strings.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File name or substring to match' },
        sheet: { type: 'string', description: 'Sheet name (omit for first sheet)' },
        start_row: { type: 'integer', description: 'Start row, 0-indexed' },
        end_row: { type: 'integer', description: 'End row, exclusive. Max 50 rows per call.' },
      },
      required: ['file', 'start_row', 'end_row'],
    },
  },
  {
    name: 'get_column_stats',
    description: 'Get statistics for a column: data type distribution, unique values (for categorical columns), count of non-empty cells. Use to understand what a column contains.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File name or substring' },
        sheet: { type: 'string', description: 'Sheet name (omit for first)' },
        column: { type: 'integer', description: 'Column index, 0-indexed' },
        start_row: { type: 'integer', description: 'Start row for analysis (0-indexed, default 0)' },
      },
      required: ['file', 'column'],
    },
  },
  {
    name: 'find_rows',
    description: 'Search for rows where a column matches a value. Returns matching row indices and their full data. Use to verify data lookups, check specific accounts, etc.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File name or substring' },
        sheet: { type: 'string', description: 'Sheet name' },
        column: { type: 'integer', description: 'Column index to search' },
        value: { type: 'string', description: 'Value to search for (string match, or number if numeric)' },
        max_results: { type: 'integer', description: 'Max results (default 10)' },
      },
      required: ['file', 'column', 'value'],
    },
  },
  {
    name: 'compare_keys',
    description: 'Compare a key column between two files. Returns overlap count, keys only in file1, keys only in file2. Use to understand how files relate to each other.',
    input_schema: {
      type: 'object',
      properties: {
        file1: { type: 'string', description: 'First file name' },
        col1: { type: 'integer', description: 'Key column in file1' },
        start1: { type: 'integer', description: 'Data start row in file1' },
        file2: { type: 'string', description: 'Second file name' },
        col2: { type: 'integer', description: 'Key column in file2' },
        start2: { type: 'integer', description: 'Data start row in file2' },
      },
      required: ['file1', 'col1', 'start1', 'file2', 'col2', 'start2'],
    },
  },
  {
    name: 'generate_code',
    description: 'Submit the final JavaScript code to process the files. Only call this after you fully understand the file structures, data relationships, and the user\'s intent. The code runs in a Web Worker with XLSX (SheetJS) and JSZip as globals. It must return { buffer: ArrayBuffer, filename: string }.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript async function body. Will be wrapped as: async function(files, XLSX, JSZip, log) { ...code... }' },
        filename: { type: 'string', description: 'Output filename for the xlsx' },
        explanation: { type: 'string', description: 'Brief explanation of what the code does' },
      },
      required: ['code', 'filename'],
    },
  },
];

// ── Tool Execution ─────────────────────────────────────────

function executeTool(name, input) {
  switch (name) {
    case 'list_files': {
      return state.files.map(f => {
        const sheets = f.wb.SheetNames.map(n => {
          const ws = f.wb.Sheets[n];
          const ref = ws['!ref'];
          if (!ref) return { name: n, rows: 0, cols: 0 };
          const range = XLSX.utils.decode_range(ref);
          return { name: n, rows: range.e.r + 1, cols: range.e.c + 1 };
        });
        return { file: f.name, sheets };
      });
    }

    case 'read_rows': {
      const file = findFile(input.file);
      if (!file) return { error: `File not found: "${input.file}". Available: ${state.files.map(f => f.name).join(', ')}` };
      const { ws } = getSheet(file, input.sheet);
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      const start = Math.max(0, input.start_row);
      const end = Math.min(rows.length, input.end_row, start + 50);
      const result = [];
      for (let r = start; r < end; r++) {
        result.push({
          row: r,
          cells: (rows[r] || []).map(formatCellValue),
        });
      }
      return { total_rows: rows.length, returned: result.length, rows: result };
    }

    case 'get_column_stats': {
      const file = findFile(input.file);
      if (!file) return { error: `File not found: "${input.file}"` };
      const { ws } = getSheet(file, input.sheet);
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      const startRow = input.start_row || 0;
      const col = input.column;

      const types = {};
      const uniques = new Set();
      let count = 0, numCount = 0, emptyCount = 0;

      for (let r = startRow; r < rows.length; r++) {
        const v = (rows[r] || [])[col];
        if (v === null || v === undefined || v === '') { emptyCount++; continue; }
        count++;
        const t = typeof v;
        types[t] = (types[t] || 0) + 1;
        if (t === 'number') numCount++;
        if (uniques.size < 30) uniques.add(typeof v === 'number' && isDateSerial(v) ? excelDateToStr(v) : String(v));
      }

      return {
        column: col,
        from_row: startRow,
        non_empty: count,
        empty: emptyCount,
        types,
        unique_count: uniques.size >= 30 ? '30+' : uniques.size,
        unique_values: uniques.size <= 30 ? [...uniques] : [...uniques].slice(0, 30).concat(['...']),
      };
    }

    case 'find_rows': {
      const file = findFile(input.file);
      if (!file) return { error: `File not found: "${input.file}"` };
      const { ws } = getSheet(file, input.sheet);
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      const col = input.column;
      const target = input.value;
      const max = input.max_results || 10;
      const results = [];

      for (let r = 0; r < rows.length && results.length < max; r++) {
        const v = (rows[r] || [])[col];
        if (v !== null && String(v) === target) {
          results.push({ row: r, cells: (rows[r] || []).map(formatCellValue) });
        }
      }
      return { matches: results.length, rows: results };
    }

    case 'compare_keys': {
      const f1 = findFile(input.file1);
      const f2 = findFile(input.file2);
      if (!f1) return { error: `File not found: "${input.file1}"` };
      if (!f2) return { error: `File not found: "${input.file2}"` };
      const { ws: ws1 } = getSheet(f1, null);
      const { ws: ws2 } = getSheet(f2, null);
      const rows1 = XLSX.utils.sheet_to_json(ws1, { header: 1, defval: null });
      const rows2 = XLSX.utils.sheet_to_json(ws2, { header: 1, defval: null });

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

      const shared = [...keys1].filter(k => keys2.has(k));
      const only1 = [...keys1].filter(k => !keys2.has(k));
      const only2 = [...keys2].filter(k => !keys1.has(k));

      return {
        file1_keys: keys1.size,
        file2_keys: keys2.size,
        shared: shared.length,
        only_in_file1: only1.length,
        only_in_file2: only2.length,
        sample_only_file1: only1.slice(0, 5),
        sample_only_file2: only2.slice(0, 5),
      };
    }

    case 'generate_code':
      // This is handled specially in the agent loop
      return { status: 'code_submitted' };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── System Prompt ──────────────────────────────────────────
const SYSTEM_PROMPT = `You are an Excel processing agent. The user has uploaded Excel files and wants you to process them.

## How You Work

You have tools to explore the uploaded files. You MUST explore before writing code:

1. First, use \`list_files\` to see what files are available.
2. Use \`read_rows\` to examine file structure — headers, where data starts, what rows look like.
3. Use \`get_column_stats\` to understand columns — types, unique values, patterns.
4. Use \`find_rows\` to look up specific values and verify your understanding.
5. Use \`compare_keys\` to understand how files relate (shared keys, mismatches).
6. Only when you fully understand the data, use \`generate_code\` to submit processing code.

## Exploration Strategy

- Read the first ~10 rows of each file to find headers and data start.
- Check column types and unique values for key columns.
- Compare key columns between files to understand joins.
- Read a few data rows to verify your understanding.
- Check the last few rows for totals/summary rows.

## Code Environment (for generate_code)

Your code runs in a Web Worker with these globals:
- \`files\` — array of { name: string, buffer: ArrayBuffer }
- \`XLSX\` — SheetJS library. Read with: \`XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })\`
- \`JSZip\` — for post-write style injection into xlsx XML
- \`log(msg)\` — send progress to the user

Code is wrapped as: \`async function(files, XLSX, JSZip, log) { YOUR_CODE }\`
Must return \`{ buffer: ArrayBuffer, filename: string }\`.

### SheetJS Quick Reference

Read: \`const wb = XLSX.read(file.buffer, { type: 'array' }); const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });\`
Write: \`const ws = XLSX.utils.aoa_to_sheet(aoa); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1'); const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true });\`

### Styling with JSZip

After writing data-only xlsx with SheetJS, open with JSZip and inject XML styles:
\`\`\`
const zip = await JSZip.loadAsync(buf);
let stylesXml = await zip.file('xl/styles.xml').async('string');
// Parse existing counts, inject fonts/fills/borders/numFmts/cellXfs, update counts
// Then modify sheet XML to add s="N" attributes to <c> elements
let sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
// Use regex: /<c r="([A-Z]+)ROW"( s="\\d+")?/ to replace or add s= attr
zip.file(...); const styledBuf = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
\`\`\`

### Rules
- Return { buffer, filename } — buffer must be ArrayBuffer.
- Use log() for progress. Log sample data to verify correctness.
- Use sheet_to_json with { header: 1, defval: null } for reads.
- For s= attribute regex: always handle both cases (exists → replace, missing → add).
- Excel dates are serial numbers. Convert: new Date((serial - 25569) * 86400000).
- Access files by name: files.find(f => f.name.includes('keyword')).`;

// ── Claude API (non-streaming, with tool use) ──────────────
async function callClaudeWithTools(apiKey, model, system, messages, tools) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      system,
      messages,
      tools,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error (${response.status}): ${err}`);
  }

  return response.json();
}

// ── Worker Execution ───────────────────────────────────────
const WORKER_CODE = `
importScripts(
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
);

self.onmessage = async function(e) {
  const { code, fileBuffers } = e.data;
  const files = fileBuffers.map(f => ({ name: f.name, buffer: f.buffer }));

  function log(msg) {
    self.postMessage({ type: 'log', message: String(msg) });
  }

  try {
    const fn = new Function('files', 'XLSX', 'JSZip', 'log',
      '"use strict"; return (async () => {\\n' + code + '\\n})();'
    );

    log('Executing...');
    const result = await fn(files, XLSX, JSZip, log);

    if (!result || !result.buffer) {
      throw new Error('Code must return { buffer: ArrayBuffer, filename: string }');
    }

    const buf = result.buffer instanceof ArrayBuffer ? result.buffer : result.buffer.buffer;
    self.postMessage({ type: 'result', buffer: buf, filename: result.filename || 'output.xlsx' }, [buf]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message, stack: err.stack });
  }
};
`;

function executeInWorker(code, files) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));

    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('Worker timed out (120s)'));
    }, 120000);

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'log') {
        logTo($logPanel, msg.message, 'log-info');
      } else if (msg.type === 'result') {
        clearTimeout(timeout);
        worker.terminate();
        resolve({ buffer: msg.buffer, filename: msg.filename });
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error(msg.message + (msg.stack ? '\n' + msg.stack : '')));
      }
    };

    worker.onerror = (err) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(err.message || 'Worker error'));
    };

    const fileBuffers = files.map(f => ({ name: f.name, buffer: f.buffer.slice(0) }));
    worker.postMessage({ code, fileBuffers });
  });
}

// ── Download ───────────────────────────────────────────────
function downloadFile(buffer, filename) {
  if (!filename || !filename.endsWith('.xlsx')) {
    filename = (filename || 'output') + '.xlsx';
  }
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

$downloadBtn.addEventListener('click', () => {
  if (state.outputBuffer) downloadFile(state.outputBuffer, state.outputFilename);
});

// ── Agent Loop ─────────────────────────────────────────────
const MAX_TURNS = 20;
const MAX_CODE_RETRIES = 3;

$runBtn.addEventListener('click', async () => {
  const apiKey = $apiKey.value.trim();
  const prompt = $prompt.value.trim();
  const model = $modelSelect.value;
  if (!apiKey || !prompt || state.files.length === 0) return;

  clearPanel($codePanel);
  clearPanel($logPanel);
  $downloadBtn.hidden = true;
  $runBtn.disabled = true;
  state.outputBuffer = null;
  state.outputFilename = null;

  const fileList = state.files.map(f => f.name).join(', ');
  const messages = [
    { role: 'user', content: `I have these Excel files: ${fileList}\n\nTask: ${prompt}\n\nPlease explore the files first to understand their structure, then generate the processing code.` },
  ];

  try {
    let codeRetries = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      setStatus(`Agent thinking (turn ${turn + 1})...`);

      const response = await callClaudeWithTools(apiKey, model, SYSTEM_PROMPT, messages, TOOLS);

      // Process response content blocks
      const assistantContent = response.content;
      messages.push({ role: 'assistant', content: assistantContent });

      // Handle text blocks (Claude's thinking/explanations)
      for (const block of assistantContent) {
        if (block.type === 'text' && block.text.trim()) {
          logTo($logPanel, block.text, 'log-meta');
        }
      }

      // If no tool use, Claude is done talking
      if (response.stop_reason !== 'tool_use') {
        setStatus('Agent finished without generating code');
        logTo($logPanel, 'Agent did not produce output code.', 'log-warn');
        break;
      }

      // Process tool calls
      const toolResults = [];

      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue;

        const { id, name, input } = block;
        logTo($logPanel, `→ ${name}(${JSON.stringify(input).slice(0, 100)}${JSON.stringify(input).length > 100 ? '...' : ''})`, 'log-info');

        // Special handling for generate_code
        if (name === 'generate_code') {
          const code = input.code;
          const filename = input.filename || 'output.xlsx';

          // Show code in the code panel
          clearPanel($codePanel);
          $codePanel.textContent = code;

          if (input.explanation) {
            logTo($logPanel, `Code: ${input.explanation}`, 'log-meta');
          }

          // Execute in worker
          try {
            setStatus('Executing code...');
            const result = await executeInWorker(code, state.files);

            // Verify output
            let verifyMsg = `Output: ${filename} (${(result.buffer.byteLength / 1024).toFixed(0)} KB)`;
            try {
              const vwb = XLSX.read(result.buffer, { type: 'array' });
              const vws = vwb.Sheets[vwb.SheetNames[0]];
              const vrows = XLSX.utils.sheet_to_json(vws, { header: 1, defval: null });
              verifyMsg += ` — ${vrows.length} rows`;

              // Check for all-zeros problem
              if (vrows.length > 5) {
                const sample = vrows[5];
                const numCols = sample.filter(v => typeof v === 'number');
                const allZero = numCols.length > 0 && numCols.every(v => v === 0);
                if (allZero) {
                  verifyMsg += ' — WARNING: sample data row has all zeros in numeric columns!';
                  // Tell Claude about the problem
                  toolResults.push({
                    type: 'tool_result',
                    tool_use_id: id,
                    content: `Code executed but output has ALL ZEROS in data rows. This means the code did not correctly read values from the input files. Row 5 sample: ${JSON.stringify(sample)}. First 3 header rows: ${JSON.stringify(vrows.slice(0, 3))}. Please investigate and fix — re-read the input files and verify you're reading from the correct rows/columns.`,
                  });
                  codeRetries++;
                  logTo($logPanel, verifyMsg, 'log-error');

                  if (codeRetries >= MAX_CODE_RETRIES) {
                    // Accept it anyway
                    state.outputBuffer = result.buffer;
                    state.outputFilename = filename;
                    $downloadBtn.hidden = false;
                    setStatus('Done (with warnings)');
                    logTo($logPanel, 'Max retries reached. Output available but may have issues.', 'log-warn');
                    updateRunBtn();
                    return;
                  }
                  continue; // Skip success, let agent loop continue
                }
              }

              // Sample rows for verification
              verifyMsg += '\nSample output rows:';
              for (let i = 0; i < Math.min(3, vrows.length); i++) {
                verifyMsg += `\n  Row ${i}: ${JSON.stringify(vrows[i]).slice(0, 200)}`;
              }
              if (vrows.length > 4) {
                verifyMsg += `\n  Row 4: ${JSON.stringify(vrows[4]).slice(0, 200)}`;
                verifyMsg += `\n  Row 5: ${JSON.stringify(vrows[5]).slice(0, 200)}`;
              }
            } catch (ve) {
              verifyMsg += ` — verify error: ${ve.message}`;
            }

            // Success
            state.outputBuffer = result.buffer;
            state.outputFilename = filename;
            $downloadBtn.hidden = false;
            setStatus('Done');
            logTo($logPanel, verifyMsg, 'log-success');

            toolResults.push({
              type: 'tool_result',
              tool_use_id: id,
              content: `Success. ${verifyMsg}`,
            });

            // Push tool results and end
            messages.push({ role: 'user', content: toolResults });
            updateRunBtn();
            return;

          } catch (execErr) {
            codeRetries++;
            logTo($logPanel, `Execution failed: ${execErr.message}`, 'log-error');

            if (codeRetries >= MAX_CODE_RETRIES) {
              setStatus('Failed');
              logTo($logPanel, 'Max code retries reached.', 'log-error');
              toolResults.push({
                type: 'tool_result',
                tool_use_id: id,
                content: `Execution failed after ${MAX_CODE_RETRIES} attempts. Last error: ${execErr.message}`,
                is_error: true,
              });
              messages.push({ role: 'user', content: toolResults });
              updateRunBtn();
              return;
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: id,
              content: `Execution error: ${execErr.message}\n\nPlease fix the code. You can use read_rows to re-examine the files if needed.`,
              is_error: true,
            });
          }
          continue;
        }

        // Regular tool: execute and collect result
        const result = executeTool(name, input);
        const resultStr = JSON.stringify(result, null, 2);

        // Truncate very long results
        const maxLen = 4000;
        const truncated = resultStr.length > maxLen
          ? resultStr.slice(0, maxLen) + `\n... (truncated, ${resultStr.length} chars total)`
          : resultStr;

        logTo($logPanel, `  ← ${truncated.slice(0, 200)}${truncated.length > 200 ? '...' : ''}`, 'log-info');

        toolResults.push({
          type: 'tool_result',
          tool_use_id: id,
          content: truncated,
        });
      }

      // Send all tool results back
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }
    }

    setStatus('Max turns reached');
    logTo($logPanel, 'Agent loop hit turn limit.', 'log-warn');

  } catch (err) {
    setStatus('Error');
    logTo($logPanel, `Error: ${err.message}`, 'log-error');
  } finally {
    updateRunBtn();
  }
});
