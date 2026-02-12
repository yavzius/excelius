// Headless code execution for eval verification.
// Mirrors the browser's sandboxed iframe + Worker execution, but in Node.js.

const XLSX = require('xlsx');
const JSZip = require('jszip');

const EXECUTION_TIMEOUT_MS = 30_000;

async function executeCode(code, files) {
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

  // Normalize to Node Buffer
  const buffer = result.buffer instanceof ArrayBuffer
    ? Buffer.from(result.buffer)
    : Buffer.isBuffer(result.buffer) ? result.buffer : Buffer.from(result.buffer);

  return { buffer, filename: result.filename || 'output.xlsx', logs };
}

module.exports = { executeCode };
