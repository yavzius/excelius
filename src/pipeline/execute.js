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
