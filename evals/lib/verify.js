// Output verification for eval runner.
// Three layers: structure (schema), values (data correctness), styling (presentation).

const XLSX = require('xlsx');
const JSZip = require('jszip');

// ── Helpers ─────────────────────────────────────

function getHeaders(rows) {
  if (!rows.length) return [];
  return rows[0].map(h => String(h || '').trim());
}

function colIndex(headers, name) {
  const lower = name.toLowerCase();
  return headers.findIndex(h => h.toLowerCase() === lower);
}

function approxEqual(a, b, tolerance = 0.01) {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  return diff <= tolerance || diff <= Math.abs(b) * tolerance;
}

// ── Structure Checks ────────────────────────────

function checkStructure(wb, rows, headers, expected) {
  const errors = [];

  // Sheet names
  if (expected.sheets) {
    for (const name of expected.sheets) {
      if (!wb.SheetNames.some(s => s.toLowerCase().includes(name.toLowerCase()))) {
        errors.push(`Missing sheet: "${name}". Found: ${wb.SheetNames.join(', ')}`);
      }
    }
  }

  // Row count
  if (expected.min_rows && rows.length < expected.min_rows) {
    errors.push(`Too few rows: ${rows.length} < ${expected.min_rows}`);
  }

  // Required columns
  if (expected.required_columns) {
    const headerLower = headers.map(h => h.toLowerCase());
    for (const col of expected.required_columns) {
      if (!headerLower.includes(col.toLowerCase())) {
        errors.push(`Missing column: "${col}". Found: ${headers.join(', ')}`);
      }
    }
  }

  return errors;
}

// ── Value Checks ─────────────────────────────────

function checkValues(rows, headers, checks) {
  if (!checks) return [];
  const errors = [];
  const dataRows = rows.slice(1); // skip header

  // All-zeros
  if (dataRows.length > 0) {
    const sampled = dataRows.slice(0, 5);
    const allZeros = sampled.every(row => {
      const nums = (row || []).filter(v => typeof v === 'number');
      return nums.length > 0 && nums.every(v => v === 0);
    });
    if (allZeros) {
      errors.push('Data rows have all zeros in numeric columns');
    }
  }

  // Column sum (excludes total/summary rows to avoid double-counting)
  if (checks.column_sum) {
    for (const [colName, expectedSum] of Object.entries(checks.column_sum)) {
      const ci = colIndex(headers, colName);
      if (ci === -1) { errors.push(`column_sum: column "${colName}" not found`); continue; }
      let sum = 0;
      for (const row of dataRows) {
        // Skip rows that look like totals/summaries
        const isSummaryRow = (row || []).some(v =>
          typeof v === 'string' && /\b(total|sum|subtotal|grand)\b/i.test(v)
        );
        if (isSummaryRow) continue;
        const v = row?.[ci];
        if (typeof v === 'number') sum += v;
      }
      if (!approxEqual(sum, expectedSum)) {
        errors.push(`column_sum: "${colName}" sum = ${sum}, expected ${expectedSum}`);
      }
    }
  }

  // Column average
  if (checks.column_avg) {
    for (const [colName, expectedAvg] of Object.entries(checks.column_avg)) {
      const ci = colIndex(headers, colName);
      if (ci === -1) { errors.push(`column_avg: column "${colName}" not found`); continue; }
      let sum = 0, count = 0;
      for (const row of dataRows) {
        const v = row?.[ci];
        if (typeof v === 'number') { sum += v; count++; }
      }
      const avg = count > 0 ? sum / count : 0;
      if (!approxEqual(avg, expectedAvg)) {
        errors.push(`column_avg: "${colName}" avg = ${avg}, expected ${expectedAvg}`);
      }
    }
  }

  // Only-category: all data rows must have this value in a given column
  if (checks.only_category) {
    const ci = colIndex(headers, 'Category');
    if (ci === -1) {
      errors.push(`only_category: "Category" column not found`);
    } else {
      const expected = checks.only_category;
      const violations = dataRows.filter(row => {
        const v = String(row?.[ci] || '').trim();
        return v && v.toLowerCase() !== expected.toLowerCase();
      });
      if (violations.length > 0) {
        errors.push(`only_category: ${violations.length} rows have wrong category (expected "${expected}")`);
      }
    }
  }

  // All amounts positive
  if (checks.all_amounts_positive) {
    const ci = colIndex(headers, 'Amount');
    if (ci === -1) {
      errors.push('all_amounts_positive: "Amount" column not found');
    } else {
      const negatives = dataRows.filter(row => typeof row?.[ci] === 'number' && row[ci] < 0);
      if (negatives.length > 0) {
        errors.push(`all_amounts_positive: ${negatives.length} rows have negative amounts`);
      }
    }
  }

  // Regions present
  if (checks.regions) {
    const ci = colIndex(headers, 'Region');
    if (ci === -1) {
      errors.push('regions: "Region" column not found');
    } else {
      const found = new Set(dataRows.map(row => String(row?.[ci] || '').trim()));
      for (const region of checks.regions) {
        if (!found.has(region)) {
          errors.push(`regions: missing "${region}". Found: ${[...found].join(', ')}`);
        }
      }
    }
  }

  // Profit = Sales - Expenses
  if (checks.profit_is_sales_minus_expenses) {
    const si = colIndex(headers, 'Sales');
    const ei = colIndex(headers, 'Expenses');
    const pi = colIndex(headers, 'Profit');
    if (si === -1 || ei === -1 || pi === -1) {
      errors.push(`profit check: missing column(s). Need Sales(${si}), Expenses(${ei}), Profit(${pi})`);
    } else {
      for (let r = 0; r < dataRows.length; r++) {
        const row = dataRows[r];
        const sales = row?.[si];
        const expenses = row?.[ei];
        const profit = row?.[pi];
        if (typeof sales === 'number' && typeof expenses === 'number' && typeof profit === 'number') {
          if (!approxEqual(profit, sales - expenses)) {
            errors.push(`profit check: row ${r + 1} profit=${profit}, expected ${sales - expenses} (sales=${sales}, expenses=${expenses})`);
          }
        }
      }
    }
  }

  // Regional totals (exact expected values per region)
  if (checks.regional_totals) {
    const regionCI = colIndex(headers, 'Region');
    if (regionCI === -1) {
      errors.push('regional_totals: "Region" column not found');
    } else {
      for (const expected of checks.regional_totals) {
        const row = dataRows.find(r => String(r?.[regionCI] || '').trim() === expected.region);
        if (!row) { errors.push(`regional_totals: row for "${expected.region}" not found`); continue; }
        for (const [colName, expectedVal] of Object.entries(expected.values)) {
          const ci = colIndex(headers, colName);
          if (ci === -1) { errors.push(`regional_totals: column "${colName}" not found`); continue; }
          if (!approxEqual(row[ci], expectedVal, 0.01)) {
            errors.push(`regional_totals: ${expected.region}.${colName} = ${row[ci]}, expected ${expectedVal}`);
          }
        }
      }
    }
  }

  // Has total row (a row containing "Total" in a text column)
  if (checks.has_total_row) {
    const hasTotal = dataRows.some(row =>
      (row || []).some(v => typeof v === 'string' && v.toLowerCase().includes('total'))
    );
    if (!hasTotal) {
      errors.push('has_total_row: no row contains "Total"');
    }
  }

  // Total row values
  if (checks.total_row_values) {
    const totalRow = dataRows.find(row =>
      (row || []).some(v => typeof v === 'string' && v.toLowerCase().includes('total'))
    );
    if (!totalRow) {
      errors.push('total_row_values: no total row found');
    } else {
      for (const [colName, expected] of Object.entries(checks.total_row_values)) {
        const ci = colIndex(headers, colName);
        if (ci === -1) { errors.push(`total_row_values: column "${colName}" not found`); continue; }
        if (!approxEqual(totalRow[ci], expected, 0.01)) {
          errors.push(`total_row_values: Total.${colName} = ${totalRow[ci]}, expected ${expected}`);
        }
      }
    }
  }

  // All accounts present (join completeness)
  if (checks.all_accounts_present && checks.expected_keys) {
    const keyCol = checks.join_key || headers[0];
    const ci = colIndex(headers, keyCol);
    if (ci === -1) {
      errors.push(`all_accounts_present: key column "${keyCol}" not found`);
    } else {
      const found = new Set(dataRows.map(row => String(row?.[ci] || '').trim()));
      const missing = checks.expected_keys.filter(k => !found.has(k));
      if (missing.length > 0) {
        errors.push(`all_accounts_present: ${missing.length} missing keys: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`);
      }
    }
  }

  // Spot checks: verify specific cell values
  if (checks.spot_values) {
    for (const spot of checks.spot_values) {
      const ci = colIndex(headers, spot.col);
      if (ci === -1) { errors.push(`spot_values: column "${spot.col}" not found`); continue; }
      const row = dataRows[spot.data_row]; // 0-indexed into data rows (after header)
      if (!row) { errors.push(`spot_values: data row ${spot.data_row} doesn't exist`); continue; }
      const actual = row[ci];
      if (typeof spot.value === 'number') {
        if (!approxEqual(actual, spot.value)) {
          errors.push(`spot_values: row ${spot.data_row} "${spot.col}" = ${actual}, expected ${spot.value}`);
        }
      } else {
        if (String(actual || '').trim() !== String(spot.value).trim()) {
          errors.push(`spot_values: row ${spot.data_row} "${spot.col}" = "${actual}", expected "${spot.value}"`);
        }
      }
    }
  }

  return errors;
}

// ── Styling Checks ───────────────────────────────

async function checkStyling(buffer, checks) {
  if (!checks?.has_bold_headers && !checks?.has_number_format) return [];
  const errors = [];

  try {
    const zip = await JSZip.loadAsync(buffer);
    const stylesFile = zip.file('xl/styles.xml');
    const sheetFile = zip.file('xl/worksheets/sheet1.xml');

    if (!stylesFile || !sheetFile) {
      errors.push('styling: cannot read xl/styles.xml or sheet XML');
      return errors;
    }

    const stylesXml = await stylesFile.async('string');
    const sheetXml = await sheetFile.async('string');

    // Bold headers: check for <b/> in fonts AND s= attributes on row 1 cells
    if (checks.has_bold_headers) {
      const hasBoldFont = /<b\s*\/?>/.test(stylesXml);
      const hasHeaderStyles = /<c r="[A-Z]+1"[^>]*s="\d+"/.test(sheetXml);
      if (!hasBoldFont) {
        errors.push('styling: no bold font defined in styles.xml');
      }
      if (!hasHeaderStyles) {
        errors.push('styling: header row cells have no style attributes');
      }
    }

    // Currency format: check for $ in formatCode
    if (checks.has_number_format) {
      const hasCurrencyFmt = /formatCode="[^"]*\$[^"]*"/.test(stylesXml)
        || /formatCode="[^"]*#,##0[^"]*"/.test(stylesXml);
      if (!hasCurrencyFmt) {
        errors.push('styling: no currency number format found in styles.xml');
      }
    }
  } catch (err) {
    errors.push(`styling: verification failed — ${err.message}`);
  }

  return errors;
}

// ── Main Verification ────────────────────────────

async function verifyOutput(buffer, expected) {
  const result = {
    structure: 'pass',
    values: 'pass',
    styling: 'pass',
    errors: [],
    row_count: 0,
    sheet_names: [],
  };

  // Parse
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    result.structure = 'fail';
    result.errors.push(`Cannot parse xlsx: ${err.message}`);
    result.pass = false;
    return result;
  }

  result.sheet_names = wb.SheetNames;
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  result.row_count = rows.length;
  const headers = getHeaders(rows);

  // Structure
  const structErrors = checkStructure(wb, rows, headers, expected);
  if (structErrors.length > 0) {
    result.structure = 'fail';
    result.errors.push(...structErrors);
  }

  // Values
  const valueErrors = checkValues(rows, headers, expected.checks);
  if (valueErrors.length > 0) {
    result.values = 'fail';
    result.errors.push(...valueErrors);
  }

  // Styling
  const styleErrors = await checkStyling(buffer, expected.checks);
  if (styleErrors.length > 0) {
    result.styling = 'fail';
    result.errors.push(...styleErrors);
  }

  result.pass = result.structure === 'pass' && result.values === 'pass';
  // Styling failures are warnings — don't fail the overall pass
  result.styling_pass = result.styling === 'pass';

  return result;
}

function scoreReport(report, expected) {
  const scores = { files_found: false, relationships_correct: false };

  if (report.files && report.files.length > 0) {
    scores.files_found = true;
  }

  if (expected.checks?.join_key && report.relationships) {
    scores.relationships_correct = report.relationships.some(
      r => r.join_key.toLowerCase().includes(expected.checks.join_key.toLowerCase())
    );
  } else {
    scores.relationships_correct = true;
  }

  return scores;
}

module.exports = { verifyOutput, scoreReport };
