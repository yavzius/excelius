// Headless tool execution for eval runner.
// Mirrors app.js executeTool() but without DOM dependencies.

const XLSX = require('xlsx');

const MAX_READ_ROWS = 50;
const MAX_UNIQUE_VALUES = 30;
const TOOL_RESULT_MAX_CHARS = 4000;

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
  // files: [{ name, buffer (Buffer) }]
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

module.exports = { createToolExecutor, parseWorkbook, getSheetRows, TOOL_RESULT_MAX_CHARS };
