#!/usr/bin/env bun
// Generates synthetic xlsx test fixtures for eval harness.
// Run: bun evals/generate-fixtures.js

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

function writeXlsx(filePath, sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  XLSX.writeFile(wb, filePath);
  console.log(`  Created: ${filePath}`);
}

// ── Fixture 1: two-files-join ─────────────────────────
const accountIds = Array.from({ length: 20 }, (_, i) => `ACC-${String(i + 1).padStart(3, '0')}`);
const names = ['Acme Corp', 'Beta LLC', 'Gamma Inc', 'Delta Co', 'Echo Ltd',
  'Foxtrot SA', 'Gulf Intl', 'Hotel Group', 'India Tech', 'Juliet Svcs',
  'Kilo Mfg', 'Lima Foods', 'Mike Auto', 'Nov Pharma', 'Oscar Retail',
  'Papa Fin', 'Quebec Tel', 'Romeo Air', 'Sierra Prop', 'Tango Media'];

const accountsAoa = [['AccountID', 'Name', 'Type', 'Status']];
accountIds.forEach((id, i) => {
  accountsAoa.push([id, names[i], i % 3 === 0 ? 'Asset' : i % 3 === 1 ? 'Liability' : 'Equity', 'Active']);
});

const balancesAoa = [['AccountID', 'Debit', 'Credit', 'Period']];
accountIds.forEach((id, i) => {
  balancesAoa.push([id, (i + 1) * 1000, (i + 1) * 800, 'Q1-2024']);
});

writeXlsx('evals/fixtures/two-files-join/accounts.xlsx', { Accounts: accountsAoa });
writeXlsx('evals/fixtures/two-files-join/balances.xlsx', { Balances: balancesAoa });

fs.writeFileSync('evals/fixtures/two-files-join/expected.json', JSON.stringify({
  prompt: 'Merge these files by AccountID. Include all columns from both files. Bold the headers.',
  sheets: ['Merged'],
  min_rows: 20,
  required_columns: ['AccountID', 'Name', 'Type', 'Status', 'Debit', 'Credit', 'Period'],
  checks: {
    join_key: 'AccountID',
    all_accounts_present: true,
  },
}, null, 2));

// ── Fixture 2: single-file-filter ─────────────────────
const txnAoa = [['Date', 'Description', 'Amount', 'Category', 'Status']];
for (let i = 0; i < 50; i++) {
  const date = `2024-${String(Math.floor(i / 4) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
  const cats = ['Revenue', 'Expense', 'Revenue', 'Expense', 'Transfer'];
  const cat = cats[i % 5];
  txnAoa.push([date, `Transaction ${i + 1}`, (i + 1) * 150 * (cat === 'Expense' ? -1 : 1), cat, i % 7 === 0 ? 'Pending' : 'Cleared']);
}

writeXlsx('evals/fixtures/single-file-filter/transactions.xlsx', { Transactions: txnAoa });

fs.writeFileSync('evals/fixtures/single-file-filter/expected.json', JSON.stringify({
  prompt: 'Filter to only Revenue transactions. Calculate the total revenue. Bold headers and format amounts as currency.',
  sheets: ['Revenue'],
  min_rows: 15,
  required_columns: ['Date', 'Description', 'Amount', 'Category'],
  checks: {
    only_category: 'Revenue',
    all_amounts_positive: true,
  },
}, null, 2));

// ── Fixture 3: multi-sheet-aggregate ──────────────────
const quarterlySheets = {};
['Q1', 'Q2', 'Q3', 'Q4'].forEach((q, qi) => {
  const aoa = [['Region', 'Sales', 'Expenses', 'Headcount']];
  ['North', 'South', 'East', 'West'].forEach((region, ri) => {
    aoa.push([region, (qi + 1) * (ri + 1) * 10000, (qi + 1) * (ri + 1) * 7000, 10 + qi + ri]);
  });
  quarterlySheets[q] = aoa;
});

writeXlsx('evals/fixtures/multi-sheet-aggregate/quarterly.xlsx', quarterlySheets);

fs.writeFileSync('evals/fixtures/multi-sheet-aggregate/expected.json', JSON.stringify({
  prompt: 'Aggregate all 4 quarterly sheets into a single summary. Sum Sales and Expenses by Region across all quarters. Add a Profit column (Sales - Expenses). Bold headers.',
  sheets: ['Summary'],
  min_rows: 4,
  required_columns: ['Region', 'Sales', 'Expenses', 'Profit'],
  checks: {
    regions: ['North', 'South', 'East', 'West'],
    profit_is_sales_minus_expenses: true,
  },
}, null, 2));

// ── Fixture 4: styling-test ───────────────────────────
const styleAoa = [['Product', 'Units', 'Price', 'Revenue']];
for (let i = 0; i < 10; i++) {
  styleAoa.push([`Product ${String.fromCharCode(65 + i)}`, (i + 1) * 10, (i + 1) * 25.50, (i + 1) * 10 * (i + 1) * 25.50]);
}

writeXlsx('evals/fixtures/styling-test/data.xlsx', { Products: styleAoa });

fs.writeFileSync('evals/fixtures/styling-test/expected.json', JSON.stringify({
  prompt: 'Create a styled summary: bold headers, currency format on Price and Revenue columns, add a Total row at the bottom that sums Units, Price (average), and Revenue.',
  sheets: ['Products'],
  min_rows: 11,
  required_columns: ['Product', 'Units', 'Price', 'Revenue'],
  checks: {
    has_total_row: true,
    has_bold_headers: true,
    has_number_format: true,
  },
}, null, 2));

console.log('\nAll fixtures generated.');
