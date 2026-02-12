// XLSX is loaded as a global via <script> tag in index.html (SheetJS).
/* global XLSX */

// ── Constants ─────────────────────────────────────────────
const MAX_API_RETRIES = 3;
const RETRY_STATUS_CODES = [429, 529, 502, 503];
const MODEL_EXPLORE = 'claude-haiku-4-5-20251001';
const MODEL_CODEGEN = 'claude-opus-4-6';
const MAX_EXPLORATION_TURNS = 15;
const MAX_CODE_RETRIES = 3;
const MAX_TOKENS_DEFAULT = 16384;
const MAX_TOKENS_EXTENDED = 32768;
const WORKER_TIMEOUT_MS = 120_000;
// Leave ~80k tokens of headroom for system prompt, current turn, and response within a 200k context window
const TOKEN_PRUNE_THRESHOLD = 120_000;
const PRUNE_KEEP_RECENT = 8;
const PRUNE_CONTENT_LIMIT = 200;
const MAX_PREVIEW_ROWS = 50;
const MAX_READ_ROWS = 50;
const MAX_UNIQUE_VALUES = 30;
const TOOL_RESULT_MAX_CHARS = 4000;

// ── State ─────────────────────────────────────────────────
const state = {
  files: [],      // { name, buffer (ArrayBuffer), wb (parsed workbook), summary (string), generated? (bool) }
  outputBuffer: null,
  outputFilename: null,
  abortController: null,
  running: false,
  totalInputTokens: 0,
  totalOutputTokens: 0,
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

// Cache: WeakMap<worksheet, rows[]> — avoids re-parsing on every tool call.
// WeakMap ensures entries are garbage-collected when worksheets leave state.files.
const sheetJsonCache = new WeakMap();
function getSheetRows(ws) {
  if (sheetJsonCache.has(ws)) return sheetJsonCache.get(ws);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  sheetJsonCache.set(ws, rows);
  return rows;
}

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

// ── UI Helpers ────────────────────────────────────────────
// Escape HTML special characters to prevent XSS in innerHTML contexts
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ESC_MAP[c]);
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
  const total = state.totalInputTokens + state.totalOutputTokens;
  if (total === 0) { $tokenCounter.textContent = ''; return; }
  $tokenCounter.textContent = `${(total / 1000).toFixed(1)}k tokens`;
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
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    $fileInput.click();
  }
});
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
  $fileInput.value = ''; // Reset so re-uploading same file triggers change event
  renderFileList();
  updateRunBtn();
}

function removeFile(index) {
  state.files.splice(index, 1);
  renderFileList();
  updateRunBtn();
}

// Event delegation — registered once, no re-binding on each render
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
  if (!wb) {
    $previewPanel.innerHTML = '<div class="preview-empty">Could not preview output</div>';
    return;
  }
  try {
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = getSheetRows(ws);
    const maxRows = Math.min(rows.length, MAX_PREVIEW_ROWS);
    if (maxRows === 0) {
      $previewPanel.innerHTML = '<div class="preview-empty">Output is empty</div>';
      return;
    }
    const parts = ['<table class="preview-table"><thead><tr>'];
    const headers = rows[0] || [];
    for (const h of headers) parts.push(`<th>${esc(h ?? '')}</th>`);
    parts.push('</tr></thead><tbody>');
    for (let r = 1; r < maxRows; r++) {
      parts.push('<tr>');
      const row = rows[r] || [];
      for (let c = 0; c < headers.length; c++) {
        parts.push(`<td>${esc(row[c] ?? '')}</td>`);
      }
      parts.push('</tr>');
    }
    parts.push('</tbody></table>');
    if (rows.length > MAX_PREVIEW_ROWS) parts.push(`<div class="preview-empty">${rows.length - MAX_PREVIEW_ROWS} more rows...</div>`);
    $previewPanel.innerHTML = parts.join('');
  } catch (err) {
    logTo($logPanel, `Preview failed: ${err.message}`, 'log-error');
    $previewPanel.innerHTML = `<div class="preview-empty">Could not preview output: ${esc(err.message)}</div>`;
  }
}

function addGeneratedFile(buffer, filename, wb = null) {
  removeGeneratedByName(filename);
  if (!wb) {
    try {
      wb = parseWorkbook(buffer);
    } catch (err) {
      logTo($logPanel, `Could not parse generated file: ${err.message}`, 'log-error');
      state.files.push({ name: filename, buffer, wb: null, summary: '(could not parse)', generated: true });
      renderFileList();
      return;
    }
  }
  state.files.push({ name: filename, buffer, wb, summary: summarizeWorkbook(wb), generated: true });
  renderFileList();
}

// ── Tool Definitions for Claude ───────────────────────────
// Tool schemas follow Claude API snake_case convention; JS internals use camelCase.

function findFile(nameQuery) {
  const q = nameQuery.toLowerCase();
  return state.files.find(f => f.name.toLowerCase() === q)
      || state.files.find(f => f.name.toLowerCase().includes(q));
}

function getSheet(file, sheetName) {
  const name = sheetName || file.wb.SheetNames[0];
  const ws = file.wb.Sheets[name];
  if (!ws) return { ws: null, error: `Sheet "${name}" not found. Available: ${file.wb.SheetNames.join(', ')}` };
  return { ws };
}

const TOOLS = [
  {
    name: 'list_files',
    description: 'List all uploaded files with their sheet names, row counts, and column counts.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_rows',
    description: 'Read actual cell values from specific rows of a file. Use this to understand file structure, headers, where data starts, what values look like. Returns array of rows with raw cell values. Numbers that look like dates (e.g. 45292) are Excel date serials — convert with: new Date((serial - 25569) * 86400000).',
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
        sheet1: { type: 'string', description: 'Sheet name in file1 (omit for first)' },
        col1: { type: 'integer', description: 'Key column in file1' },
        start1: { type: 'integer', description: 'Data start row in file1' },
        file2: { type: 'string', description: 'Second file name' },
        sheet2: { type: 'string', description: 'Sheet name in file2 (omit for first)' },
        col2: { type: 'integer', description: 'Key column in file2' },
        start2: { type: 'integer', description: 'Data start row in file2' },
      },
      required: ['file1', 'col1', 'start1', 'file2', 'col2', 'start2'],
    },
  },
  {
    name: 'submit_report',
    description: 'Submit your exploration findings as a structured report. Call this when you have thoroughly explored all files and understand their structure, relationships, and any data issues. A separate code generation agent will use this report to write the processing code.',
    input_schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Analysis of each file',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              sheets: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    row_count: { type: 'integer' },
                    col_count: { type: 'integer' },
                    headers: { type: 'array', items: { type: 'string' } },
                    header_row: { type: 'integer', description: '0-indexed row where headers are' },
                    sample_rows: { type: 'array', description: '3-5 representative data rows after headers' },
                    data_types: { type: 'object', description: 'Column name → "number" | "string" | "date" | "mixed"' },
                    key_columns: { type: 'array', items: { type: 'string' }, description: 'Columns with high uniqueness (likely join keys)' },
                    notable: { type: 'array', items: { type: 'string' }, description: 'Observations: totals rows, blank rows, date formats, etc.' },
                  },
                  required: ['name', 'row_count', 'col_count', 'headers', 'header_row'],
                },
              },
            },
            required: ['name', 'sheets'],
          },
        },
        relationships: {
          type: 'array',
          description: 'Cross-file relationships discovered via compare_keys',
          items: {
            type: 'object',
            properties: {
              file1: { type: 'string' },
              file2: { type: 'string' },
              sheet1: { type: 'string' },
              sheet2: { type: 'string' },
              join_key: { type: 'string' },
              shared_count: { type: 'integer' },
              only_in_file1: { type: 'integer' },
              only_in_file2: { type: 'integer' },
              match_rate: { type: 'string', description: 'e.g. "95% (380/400)"' },
            },
            required: ['file1', 'file2', 'join_key'],
          },
        },
        data_issues: {
          type: 'array',
          items: { type: 'string' },
          description: 'Warnings the code agent should know about: blank rows, date serial numbers, merged cells, etc.',
        },
        recommended_approach: {
          type: 'string',
          description: 'Natural language suggestion for how to solve the user\'s task based on what you found.',
        },
      },
      required: ['files', 'data_issues', 'recommended_approach'],
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
    cache_control: { type: 'ephemeral' },
  },
];

// ── Tool Execution ────────────────────────────────────────
// generate_code is handled separately in the agent loop; see executeGeneratedCode().

function fileNotFound(nameQuery) {
  return { error: `File not found: "${nameQuery}". Available: ${state.files.map(f => f.name).join(', ')}` };
}

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
        const entry = { file: f.name, sheets };
        if (f.generated) entry.generated = true;
        return entry;
      });
    }

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
        column: col,
        from_row: startRow,
        non_empty: count,
        empty: emptyCount,
        types,
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
        if (v !== null && String(v) === target) {
          results.push({ row: r, cells: rows[r] || [] });
        }
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

      // Single-pass comparison avoids spreading large Sets multiple times
      let shared = 0;
      const only1 = [];
      for (const k of keys1) {
        if (keys2.has(k)) shared++;
        else only1.push(k);
      }
      const only2 = [];
      for (const k of keys2) {
        if (!keys1.has(k)) only2.push(k);
      }

      return {
        file1_keys: keys1.size,
        file2_keys: keys2.size,
        shared,
        only_in_file1: only1.length,
        only_in_file2: only2.length,
        sample_only_file1: only1.slice(0, 5),
        sample_only_file2: only2.slice(0, 5),
      };
    }

    case 'submit_report':
      return { error: 'submit_report is handled by the exploration agent loop, not executeTool' };

    case 'generate_code':
      return { error: 'generate_code is handled by the agent loop, not executeTool' };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── System Prompts ───────────────────────────────────────
// Two distinct prompts: one for the exploration agent (Haiku), one for code gen (Opus).
// The exploration prompt focuses on thorough data discovery.
// The code gen prompt receives the structured report and focuses on correct SheetJS code.

const EXPLORATION_PROMPT = `You are a data exploration agent. Your job is to thoroughly understand Excel files so a separate code generation agent can process them correctly.

## Your Tools
- list_files: See what files are available
- read_rows: Examine rows (headers, data samples, totals)
- get_column_stats: Understand column types, unique values, patterns
- find_rows: Search for specific values
- compare_keys: Understand relationships between files
- submit_report: Submit your structured findings when done

## Exploration Strategy
1. list_files to see all available files
2. read_rows on each file: first 5 rows (find headers), rows 5-10 (data samples), last 3 rows (check for totals/summary rows)
3. get_column_stats on columns that look like keys, amounts, or dates
4. compare_keys between files on likely join columns
5. Once you understand the structure, call submit_report with your findings

## Rules
- Be thorough. The code agent cannot explore — it only sees your report.
- If headers aren't in row 0, note the actual header_row.
- Flag data issues: blank rows, merged cells, serial number dates, inconsistent formats.
- Identify which columns are keys (high uniqueness) vs values (numeric, repeated).
- For recommended_approach, consider the user's task and suggest the processing strategy.
- Do NOT generate code. Your only job is exploration and reporting.

The user's task is provided for context so you know what to look for, but explore broadly — the code agent may need details you didn't anticipate.`;

function buildCodeGenPrompt(report) {
  return `You are an Excel code generation agent. A data exploration agent has already analyzed the files. Its structured report is below.

## Exploration Report
${JSON.stringify(report, null, 2)}

## Code Environment
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
let sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
// Use regex: /<c r="([A-Z]+)ROW"( s="\\\\d+")?/ to replace or add s= attr
zip.file(...); const styledBuf = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
\`\`\`

### Rules
- Trust the exploration report. Do not second-guess column names or row positions.
- Use the header_row from the report — data may not start at row 0.
- Handle the data_issues flagged in the report (date conversions, blank rows, etc).
- Return { buffer, filename } — buffer must be ArrayBuffer.
- Use log() for progress. Log sample data to verify correctness.
- Use sheet_to_json with { header: 1, defval: null } for reads.
- For s= attribute regex: always handle both cases (exists → replace, missing → add).
- Excel dates are serial numbers. Convert: new Date((serial - 25569) * 86400000).
- Access files by name: files.find(f => f.name.includes('keyword')).`;
}

// ── Exploration Agent (Haiku) ────────────────────────────
// Runs autonomously: calls exploration tools, then submit_report.
// Returns the structured ExplorationReport JSON.

async function runExplorationAgent(apiKey, prompt, signal) {
  const fileList = state.files.map(f => f.name).join(', ');
  const messages = [
    { role: 'user', content: `Files available: ${fileList}\n\nUser's task: ${prompt}\n\nPlease explore these files thoroughly, then submit_report with your findings.` },
  ];

  // Exploration tools: everything except generate_code
  const explorationTools = TOOLS.filter(t => t.name !== 'generate_code');

  for (let turn = 0; turn < MAX_EXPLORATION_TURNS; turn++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    setStatus(`Exploring (turn ${turn + 1})...`);

    const response = await callClaudeWithTools(
      apiKey, MODEL_EXPLORE, EXPLORATION_PROMPT, messages, explorationTools, signal
    );

    updateTokens('explore', response.usage);

    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    // Log text blocks
    for (const block of assistantContent) {
      if (block.type === 'text' && block.text.trim()) {
        logTo($logPanel, block.text, 'log-meta');
      }
    }

    // Check for submit_report in tool calls
    for (const block of assistantContent) {
      if (block.type === 'tool_use' && block.name === 'submit_report') {
        logTo($logPanel, `Exploration complete: ${block.input.files?.length || 0} files analyzed`, 'log-success');
        return block.input;
      }
    }

    if (response.stop_reason !== 'tool_use') {
      throw new Error('Exploration agent stopped without submitting a report');
    }

    // Process exploration tool calls
    const toolResults = [];

    for (const block of assistantContent) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'submit_report') continue; // already handled above
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const { id, name, input } = block;
      const inputStr = JSON.stringify(input);
      logTo($logPanel, `\u2192 ${name}(${inputStr.slice(0, 100)}${inputStr.length > 100 ? '...' : ''})`, 'log-info');

      const result = executeTool(name, input);
      const resultStr = JSON.stringify(result, null, 2);
      const truncated = resultStr.length > TOOL_RESULT_MAX_CHARS
        ? resultStr.slice(0, TOOL_RESULT_MAX_CHARS) + `\n... (truncated, ${resultStr.length} chars total)`
        : resultStr;

      logTo($logPanel, `  \u2190 ${truncated.slice(0, 200)}${truncated.length > 200 ? '...' : ''}`, 'log-info');

      toolResults.push({
        type: 'tool_result',
        tool_use_id: id,
        content: truncated,
      });
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }
  }

  throw new Error('Exploration agent hit turn limit without submitting a report');
}

// ── Code Generation Agent (Opus) ─────────────────────────
// Receives the exploration report, generates SheetJS/JSZip code.
// Retries with error feedback if execution fails.

async function runCodeGenAgent(apiKey, prompt, report, signal) {
  const systemPrompt = buildCodeGenPrompt(report);
  const messages = [
    { role: 'user', content: `Task: ${prompt}\n\nThe exploration report is in the system prompt. Generate the processing code.` },
  ];

  // Only generate_code is available to this agent
  const codeTools = TOOLS.filter(t => t.name === 'generate_code');

  for (let attempt = 0; attempt < MAX_CODE_RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    setStatus(attempt === 0 ? 'Generating code...' : `Fixing code (attempt ${attempt + 1})...`);

    let response = await callClaudeWithTools(
      apiKey, MODEL_CODEGEN, systemPrompt, messages, codeTools, signal
    );

    // Handle max_tokens truncation
    if (response.stop_reason === 'max_tokens') {
      const last = response.content[response.content.length - 1];
      if (last?.type === 'tool_use') {
        logTo($logPanel, 'Response truncated mid-tool-call — retrying with higher limit...', 'log-warn');
        response = await callClaudeWithTools(
          apiKey, MODEL_CODEGEN, systemPrompt, messages, codeTools, signal, MAX_TOKENS_EXTENDED
        );
      }
    }

    updateTokens('codegen', response.usage);

    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    // Log text blocks
    for (const block of assistantContent) {
      if (block.type === 'text' && block.text.trim()) {
        logTo($logPanel, block.text, 'log-meta');
      }
    }

    const codeBlock = assistantContent.find(b => b.type === 'tool_use' && b.name === 'generate_code');
    if (!codeBlock) {
      if (response.stop_reason !== 'tool_use') {
        throw new Error('Code agent finished without calling generate_code');
      }
      continue;
    }

    const gen = await executeGeneratedCode({ id: codeBlock.id, input: codeBlock.input, signal });

    if (gen.action === 'success') {
      return gen;
    }

    // Feed error back for retry
    messages.push({ role: 'user', content: [gen.toolResult] });

    // On last attempt, offer partial output if available
    if (attempt === MAX_CODE_RETRIES - 1 && gen.buffer) {
      state.outputBuffer = gen.buffer;
      state.outputFilename = gen.filename;
      $downloadBtn.hidden = false;
      addGeneratedFile(gen.buffer, gen.filename, gen.verifyWb);
      showPreview(gen.verifyWb);
      setStatus('Done (with warnings) — ask a follow-up or download');
      logTo($logPanel, 'Max retries reached. Output available but may have issues.', 'log-warn');
      return gen;
    }
  }

  throw new Error('Code generation failed after max retries');
}

// ── Claude API (non-streaming, with tool use + retry) ─────
async function callClaudeWithTools(apiKey, model, system, messages, tools, signal, maxTokens = MAX_TOKENS_DEFAULT) {
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
        tools,
      }),
    });

    if (response.ok) {
      let data;
      try {
        data = await response.json();
      } catch (parseErr) {
        if (attempt < MAX_API_RETRIES) {
          logTo($logPanel, 'API returned invalid JSON — retrying...', 'log-warn');
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        throw new Error(`Claude API returned invalid JSON: ${parseErr.message}`);
      }
      if (data.usage) {
        state.totalInputTokens += data.usage.input_tokens || 0;
        state.totalOutputTokens += data.usage.output_tokens || 0;
        updateTokenCounter();
      }
      return data;
    }

    let errText;
    try { errText = await response.text(); } catch { errText = '(could not read response body)'; }

    if (RETRY_STATUS_CODES.includes(response.status) && attempt < MAX_API_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
      logTo($logPanel, `API ${response.status} — retrying in ${delay / 1000}s...`, 'log-warn');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
      continue;
    }

    throw new Error(`Claude API error (${response.status}): ${errText}`);
  }
}

// ── Sandboxed Execution ───────────────────────────────────
// LLM-generated code runs inside: sandboxed iframe → Web Worker.
// Why iframe + Worker instead of just a Worker: the iframe's sandbox attribute
// creates an opaque origin, so the Worker inherits no ambient privileges
// (no same-origin access, no localStorage, no cookies). The Worker provides
// async execution without blocking the UI.
// Libraries are pre-fetched in the trusted parent and passed as source text.
// The sandbox has zero network access — connect-src 'none' is inherited by the Worker.

let libsPromise = null;

function fetchLibraries() {
  if (!libsPromise) {
    const fetchLib = url => fetch(url).then(r => {
      if (!r.ok) throw new Error(`Failed to load library from ${url}: HTTP ${r.status}`);
      return r.text();
    });
    libsPromise = Promise.all([
      fetchLib('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'),
      fetchLib('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'),
    ]).catch(err => {
      libsPromise = null; // Allow retry on next call
      throw err;
    });
  }
  return libsPromise;
}

const WORKER_HANDLER = `
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

// HTML injected into the sandboxed iframe via srcdoc. Acts as a bridge:
// receives the worker source and file buffers from the parent via postMessage,
// spawns the Web Worker, and relays results back.
const BRIDGE_HTML = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:;">
</head><body><script>
window.addEventListener("message", function(e) {
  let msg = e.data;
  if (msg.type !== "exec") return;
  let blob = new Blob([msg.workerSrc], { type: "application/javascript" });
  let worker = new Worker(URL.createObjectURL(blob));
  worker.onmessage = function(ev) {
    parent.postMessage(ev.data, "*");
    if (ev.data.type !== "log") worker.terminate();
  };
  worker.onerror = function(err) {
    parent.postMessage({ type: "error", message: err.message || "Worker error" }, "*");
    worker.terminate();
  };
  let transfers = msg.fileBuffers.map(function(f) { return f.buffer; });
  worker.postMessage({ code: msg.code, fileBuffers: msg.fileBuffers }, transfers);
});
parent.postMessage({ type: "bridge_ready" }, "*");
<\/script></body></html>`;

async function executeInWorker(code, files, signal) {
  const [sheetjsSrc, jszipSrc] = await fetchLibraries();
  const workerSrc = sheetjsSrc + ';\n' + jszipSrc + ';\n' + WORKER_HANDLER;

  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-scripts';
    iframe.style.display = 'none';
    iframe.srcdoc = BRIDGE_HTML;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Worker timed out (120s)'));
    }, WORKER_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }

    // The iframe has an opaque origin (sandbox without allow-same-origin),
    // so e.origin is "null" — we validate with e.source instead.
    function onMessage(e) {
      if (e.source !== iframe.contentWindow) return;
      const msg = e.data;

      if (msg.type === 'bridge_ready') {
        const fileBuffers = files.map(f => ({ name: f.name, buffer: f.buffer.slice(0) }));
        const transfers = fileBuffers.map(f => f.buffer);
        iframe.contentWindow.postMessage(
          { type: 'exec', workerSrc, code, fileBuffers },
          '*', transfers
        );
        return;
      }

      if (msg.type === 'log') {
        logTo($logPanel, msg.message, 'log-info');
      } else if (msg.type === 'result') {
        cleanup();
        resolve({ buffer: msg.buffer, filename: msg.filename });
      } else if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.message + (msg.stack ? '\n' + msg.stack : '')));
      }
    }

    window.addEventListener('message', onMessage);
    document.body.appendChild(iframe);

    if (signal) {
      signal.addEventListener('abort', () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  });
}

// ── Download ──────────────────────────────────────────────
function downloadFile(buffer, filename = 'output.xlsx') {
  if (!filename.endsWith('.xlsx')) filename += '.xlsx';
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

// ── Context Window Management ─────────────────────────────
function pruneMessages(messages) {
  // Replace old tool_result content blocks with summaries.
  // Keep the last few message pairs (most recent context) intact.
  if (messages.length <= PRUNE_KEEP_RECENT + 1) return false;

  let pruned = false;
  for (let i = 1; i < messages.length - PRUNE_KEEP_RECENT; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    msg.content = msg.content.map(block => {
      if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > PRUNE_CONTENT_LIMIT) {
        pruned = true;
        return { ...block, content: block.content.slice(0, PRUNE_CONTENT_LIMIT) + '... [pruned for context]' };
      }
      return block;
    });
  }
  return pruned;
}

// ── Code Execution + Verification ─────────────────────────
// Extracted from the agent loop for clarity. Handles executing LLM-generated
// code in the sandbox, verifying the output, and returning a structured result.

async function executeGeneratedCode({ id, input, signal }) {
  const code = input.code;
  const filename = input.filename || 'output.xlsx';

  clearPanel($codePanel);
  $codePanel.textContent = code;
  if (input.explanation) logTo($logPanel, `Code: ${input.explanation}`, 'log-meta');

  let result;
  try {
    setStatus('Executing code...');
    result = await executeInWorker(code, state.files, signal);
  } catch (execErr) {
    if (execErr.name === 'AbortError') throw execErr;
    logTo($logPanel, `Execution failed: ${execErr.message}`, 'log-error');
    return {
      action: 'retry',
      toolResult: {
        type: 'tool_result', tool_use_id: id,
        content: `Execution error: ${execErr.message}\n\nPlease fix the code. You can use read_rows to re-examine the files if needed.`,
        is_error: true,
      },
    };
  }

  // Verify output
  let verifyMsg = `Output: ${filename} (${(result.buffer.byteLength / 1024).toFixed(0)} KB)`;
  let verifyWb = null;

  try {
    verifyWb = parseWorkbook(result.buffer);
    const verifyWs = verifyWb.Sheets[verifyWb.SheetNames[0]];
    const verifyRows = getSheetRows(verifyWs);
    verifyMsg += ` — ${verifyRows.length} rows`;

    // Check for all-zeros problem (common LLM code failure mode)
    if (verifyRows.length > 2) {
      const dataStart = Math.min(2, verifyRows.length - 1);
      const sampled = verifyRows.slice(dataStart, Math.min(dataStart + 5, verifyRows.length));
      const allZeros = sampled.length > 0 && sampled.every(row => {
        const nums = (row || []).filter(v => typeof v === 'number');
        return nums.length > 0 && nums.every(v => v === 0);
      });
      if (allZeros) {
        verifyMsg += ' — WARNING: data rows have all zeros in numeric columns!';
        logTo($logPanel, verifyMsg, 'log-error');
        return {
          action: 'retry',
          toolResult: {
            type: 'tool_result', tool_use_id: id,
            content: `Code executed but output has ALL ZEROS in data rows. Sample rows ${dataStart}-${dataStart + sampled.length - 1}: ${JSON.stringify(sampled.slice(0, 3))}. Headers: ${JSON.stringify(verifyRows[0])}. Please investigate and fix.`,
          },
          buffer: result.buffer, filename, verifyWb,
        };
      }
    }

    // Sample rows for verification message
    verifyMsg += '\nSample output rows:';
    for (let i = 0; i < Math.min(5, verifyRows.length); i++) {
      verifyMsg += `\n  Row ${i}: ${JSON.stringify(verifyRows[i]).slice(0, 200)}`;
    }
  } catch (ve) {
    verifyMsg += ` — verify error: ${ve.message}`;
  }

  // Success — store output, preview, switch tab
  state.outputBuffer = result.buffer;
  state.outputFilename = filename;
  $downloadBtn.hidden = false;
  setStatus('Done — ask a follow-up or download');
  logTo($logPanel, verifyMsg, 'log-success');

  addGeneratedFile(result.buffer, filename, verifyWb);
  showPreview(verifyWb);
  switchTab('preview');

  return {
    action: 'success',
    toolResult: { type: 'tool_result', tool_use_id: id, content: `Success. ${verifyMsg}` },
  };
}

// ── Agent Loop ────────────────────────────────────────────
$cancelBtn.addEventListener('click', () => {
  if (state.abortController) {
    state.abortController.abort();
    logTo($logPanel, 'Cancelling...', 'log-warn');
  }
});

$runBtn.addEventListener('click', async () => {
  const apiKey = $apiKey.value.trim();
  const prompt = $prompt.value.trim();
  if (!apiKey || !prompt || state.files.length === 0) return;

  clearPanel($codePanel);
  clearPanel($logPanel);
  $downloadBtn.hidden = true;
  $runBtn.disabled = true;
  $cancelBtn.hidden = false;
  state.outputBuffer = null;
  state.outputFilename = null;
  state.running = true;
  state.totalInputTokens = 0;
  state.totalOutputTokens = 0;
  state.abortController = new AbortController();
  updateTokenCounter();

  const fileList = state.files.map(f => f.name).join(', ');
  const messages = [
    { role: 'user', content: `I have these Excel files: ${fileList}\n\nTask: ${prompt}\n\nPlease explore the files first to understand their structure, then generate the processing code.` },
  ];

  try {
    let codeRetries = 0;
    const signal = state.abortController.signal;

    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      setStatus(`Agent thinking (turn ${turn + 1})...`);

      if (state.totalInputTokens > TOKEN_PRUNE_THRESHOLD && pruneMessages(messages)) {
        logTo($logPanel, 'Pruned old tool results to manage context window.', 'log-warn');
      }

      let response = await callClaudeWithTools(apiKey, 'claude-sonnet-4-5-20250929', SYSTEM_PROMPT, messages, TOOLS, signal);

      // Handle max_tokens truncation: if last block is tool_use, retry with higher limit
      if (response.stop_reason === 'max_tokens') {
        const last = response.content[response.content.length - 1];
        if (last?.type === 'tool_use') {
          logTo($logPanel, 'Response truncated mid-tool-call — retrying with higher limit...', 'log-warn');
          response = await callClaudeWithTools(apiKey, 'claude-sonnet-4-5-20250929', SYSTEM_PROMPT, messages, TOOLS, signal, MAX_TOKENS_EXTENDED);
        }
      }

      const assistantContent = response.content;
      messages.push({ role: 'assistant', content: assistantContent });

      for (const block of assistantContent) {
        if (block.type === 'text' && block.text.trim()) {
          logTo($logPanel, block.text, 'log-meta');
        }
      }

      if (response.stop_reason !== 'tool_use') {
        setStatus('Agent finished without generating code');
        logTo($logPanel, 'Agent did not produce output code.', 'log-warn');
        break;
      }

      // Process tool calls
      const toolResults = [];

      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

        const { id, name, input } = block;
        const inputStr = JSON.stringify(input);
        logTo($logPanel, `\u2192 ${name}(${inputStr.slice(0, 100)}${inputStr.length > 100 ? '...' : ''})`, 'log-info');

        // Code generation — handled by extracted function
        if (name === 'generate_code') {
          const gen = await executeGeneratedCode({ id, input, signal });

          if (gen.action === 'success') {
            toolResults.push(gen.toolResult);
            messages.push({ role: 'user', content: toolResults });
            return;
          }

          // Retry path
          codeRetries++;
          toolResults.push(gen.toolResult);

          if (codeRetries >= MAX_CODE_RETRIES) {
            if (gen.buffer) {
              // Output exists but has issues — offer it anyway
              state.outputBuffer = gen.buffer;
              state.outputFilename = gen.filename;
              $downloadBtn.hidden = false;
              addGeneratedFile(gen.buffer, gen.filename, gen.verifyWb);
              showPreview(gen.verifyWb);
              setStatus('Done (with warnings) — ask a follow-up or download');
              logTo($logPanel, 'Max retries reached. Output available but may have issues.', 'log-warn');
            } else {
              setStatus('Failed');
              logTo($logPanel, 'Max code retries reached.', 'log-error');
            }
            messages.push({ role: 'user', content: toolResults });
            return;
          }

          continue;
        }

        // Regular tool: execute and collect result
        const result = executeTool(name, input);
        const resultStr = JSON.stringify(result, null, 2);

        const truncated = resultStr.length > TOOL_RESULT_MAX_CHARS
          ? resultStr.slice(0, TOOL_RESULT_MAX_CHARS) + `\n... (truncated, ${resultStr.length} chars total)`
          : resultStr;

        logTo($logPanel, `  \u2190 ${truncated.slice(0, 200)}${truncated.length > 200 ? '...' : ''}`, 'log-info');

        toolResults.push({
          type: 'tool_result',
          tool_use_id: id,
          content: truncated,
        });
      }

      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }
    }

    setStatus('Max turns reached');
    logTo($logPanel, 'Agent loop hit turn limit.', 'log-warn');

  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('Cancelled');
      logTo($logPanel, 'Run cancelled by user.', 'log-warn');
    } else {
      setStatus('Error');
      logTo($logPanel, `Error: ${err.message}`, 'log-error');
    }
  } finally {
    state.running = false;
    state.abortController = null;
    $cancelBtn.hidden = true;
    updateRunBtn();
  }
});
