// Output verification for eval runner.

const XLSX = require('xlsx');

function verifyOutput(buffer, expected) {
  const results = { structure: 'pass', values: 'pass', styling: 'pass', errors: [] };

  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    results.structure = 'fail';
    results.errors.push(`Cannot parse output xlsx: ${err.message}`);
    return results;
  }

  // Sheet names
  if (expected.sheets) {
    for (const name of expected.sheets) {
      if (!wb.SheetNames.includes(name) && !wb.SheetNames.some(s => s.toLowerCase().includes(name.toLowerCase()))) {
        results.structure = 'fail';
        results.errors.push(`Missing expected sheet: "${name}". Found: ${wb.SheetNames.join(', ')}`);
      }
    }
  }

  // Row count
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  if (expected.min_rows && rows.length < expected.min_rows) {
    results.structure = 'fail';
    results.errors.push(`Too few rows: ${rows.length} < ${expected.min_rows}`);
  }

  // Required columns
  if (expected.required_columns && rows.length > 0) {
    const headers = rows[0].map(h => String(h || '').toLowerCase());
    for (const col of expected.required_columns) {
      if (!headers.includes(col.toLowerCase())) {
        results.structure = 'fail';
        results.errors.push(`Missing required column: "${col}". Found: ${rows[0].join(', ')}`);
      }
    }
  }

  // All-zeros check
  if (rows.length > 2) {
    const dataRows = rows.slice(1, 6);
    const allZeros = dataRows.every(row => {
      const nums = (row || []).filter(v => typeof v === 'number');
      return nums.length > 0 && nums.every(v => v === 0);
    });
    if (allZeros) {
      results.values = 'fail';
      results.errors.push('All data rows have zero values in numeric columns');
    }
  }

  return {
    ...results,
    pass: results.structure === 'pass' && results.values === 'pass',
    row_count: rows.length,
    sheet_names: wb.SheetNames,
  };
}

function scoreReport(report, expected) {
  const scores = { files_found: false, relationships_correct: false, issues_flagged: true };

  if (report.files && report.files.length > 0) {
    scores.files_found = true;
  }

  if (expected.checks?.join_key && report.relationships) {
    scores.relationships_correct = report.relationships.some(
      r => r.join_key.toLowerCase().includes(expected.checks.join_key.toLowerCase())
    );
  } else {
    scores.relationships_correct = true; // no relationship check needed
  }

  return scores;
}

module.exports = { verifyOutput, scoreReport };
