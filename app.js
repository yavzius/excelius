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
