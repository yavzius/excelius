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

function writeExpected(dir, data) {
  fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(data, null, 2));
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

const fixtureDir1 = 'evals/fixtures/two-files-join';
writeXlsx(`${fixtureDir1}/accounts.xlsx`, { Accounts: accountsAoa });
writeXlsx(`${fixtureDir1}/balances.xlsx`, { Balances: balancesAoa });

// Debit sum: 1000+2000+...+20000 = 20*21/2 * 1000 = 210,000
// Credit sum: 800+1600+...+16000 = 20*21/2 * 800 = 168,000
writeExpected(fixtureDir1, {
  prompt: 'Merge these files by AccountID. Include all columns from both files. Bold the headers.',
  sheets: ['Merged'],
  min_rows: 20,
  required_columns: ['AccountID', 'Name', 'Type', 'Status', 'Debit', 'Credit', 'Period'],
  checks: {
    join_key: 'AccountID',
    all_accounts_present: true,
    expected_keys: accountIds,
    column_sum: { Debit: 210000, Credit: 168000 },
    spot_values: [
      { data_row: 0, col: 'AccountID', value: 'ACC-001' },
      { data_row: 0, col: 'Debit', value: 1000 },
      { data_row: 0, col: 'Credit', value: 800 },
      { data_row: 19, col: 'AccountID', value: 'ACC-020' },
      { data_row: 19, col: 'Debit', value: 20000 },
    ],
    has_bold_headers: true,
  },
});

// ── Fixture 2: single-file-filter ─────────────────────
const txnAoa = [['Date', 'Description', 'Amount', 'Category', 'Status']];
const cats = ['Revenue', 'Expense', 'Revenue', 'Expense', 'Transfer'];
let revenueSum = 0;
let revenueCount = 0;
for (let i = 0; i < 50; i++) {
  const date = `2024-${String(Math.floor(i / 4) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
  const cat = cats[i % 5];
  const amount = (i + 1) * 150 * (cat === 'Expense' ? -1 : 1);
  txnAoa.push([date, `Transaction ${i + 1}`, amount, cat, i % 7 === 0 ? 'Pending' : 'Cleared']);
  if (cat === 'Revenue') { revenueSum += amount; revenueCount++; }
}

const fixtureDir2 = 'evals/fixtures/single-file-filter';
writeXlsx(`${fixtureDir2}/transactions.xlsx`, { Transactions: txnAoa });

writeExpected(fixtureDir2, {
  prompt: 'Filter to only Revenue transactions. Calculate the total revenue. Bold headers and format amounts as currency.',
  sheets: ['Revenue'],
  min_rows: 15,
  required_columns: ['Date', 'Description', 'Amount', 'Category'],
  checks: {
    only_category: 'Revenue',
    all_amounts_positive: true,
    column_sum: { Amount: revenueSum },
    has_bold_headers: true,
    has_number_format: true,
  },
});

// ── Fixture 3: multi-sheet-aggregate ──────────────────
const quarterlySheets = {};
const regions = ['North', 'South', 'East', 'West'];
const regionalTotals = regions.map((region, ri) => {
  let totalSales = 0, totalExpenses = 0;
  for (let qi = 0; qi < 4; qi++) {
    totalSales += (qi + 1) * (ri + 1) * 10000;
    totalExpenses += (qi + 1) * (ri + 1) * 7000;
  }
  return { region, values: { Sales: totalSales, Expenses: totalExpenses, Profit: totalSales - totalExpenses } };
});

['Q1', 'Q2', 'Q3', 'Q4'].forEach((q, qi) => {
  const aoa = [['Region', 'Sales', 'Expenses', 'Headcount']];
  regions.forEach((region, ri) => {
    aoa.push([region, (qi + 1) * (ri + 1) * 10000, (qi + 1) * (ri + 1) * 7000, 10 + qi + ri]);
  });
  quarterlySheets[q] = aoa;
});

const fixtureDir3 = 'evals/fixtures/multi-sheet-aggregate';
writeXlsx(`${fixtureDir3}/quarterly.xlsx`, quarterlySheets);

writeExpected(fixtureDir3, {
  prompt: 'Aggregate all 4 quarterly sheets into a single summary. Sum Sales and Expenses by Region across all quarters. Add a Profit column (Sales - Expenses). Bold headers.',
  sheets: ['Summary'],
  min_rows: 4,
  required_columns: ['Region', 'Sales', 'Expenses', 'Profit'],
  checks: {
    regions: regions,
    profit_is_sales_minus_expenses: true,
    regional_totals: regionalTotals,
    has_bold_headers: true,
  },
});

// ── Fixture 4: styling-test ───────────────────────────
const styleAoa = [['Product', 'Units', 'Price', 'Revenue']];
let unitsSum = 0, priceSum = 0, revenueTotal = 0;
for (let i = 0; i < 10; i++) {
  const units = (i + 1) * 10;
  const price = (i + 1) * 25.50;
  const revenue = units * price;
  styleAoa.push([`Product ${String.fromCharCode(65 + i)}`, units, price, revenue]);
  unitsSum += units;
  priceSum += price;
  revenueTotal += revenue;
}
const priceAvg = priceSum / 10;

const fixtureDir4 = 'evals/fixtures/styling-test';
writeXlsx(`${fixtureDir4}/data.xlsx`, { Products: styleAoa });

writeExpected(fixtureDir4, {
  prompt: 'Create a styled summary: bold headers, currency format on Price and Revenue columns, add a Total row at the bottom that sums Units, Price (average), and Revenue.',
  sheets: ['Products'],
  min_rows: 11,
  required_columns: ['Product', 'Units', 'Price', 'Revenue'],
  checks: {
    has_total_row: true,
    total_row_values: { Units: unitsSum, Revenue: revenueTotal },
    has_bold_headers: true,
    has_number_format: true,
  },
});

console.log('\nAll fixtures generated.');
console.log(`  Revenue fixture: ${revenueCount} revenue transactions, sum = ${revenueSum}`);
console.log(`  Styling fixture: units=${unitsSum}, priceAvg=${priceAvg}, revenue=${revenueTotal}`);
console.log(`  Regional totals:`, regionalTotals.map(r => `${r.region}: S=${r.values.Sales} E=${r.values.Expenses} P=${r.values.Profit}`).join(', '));
