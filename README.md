# Excelius

Drop Excel files, describe what you want in plain English, get a processed and styled `.xlsx` back. Runs entirely in the browser — your data never leaves your machine.

## How it works

1. You upload `.xlsx` files and type a prompt ("merge these by account, sum Q1, bold headers")
2. Claude explores your files using tools — reading rows, checking column types, comparing keys across sheets
3. Once it understands the structure, it writes JavaScript to process your data
4. The code runs in a Web Worker with [SheetJS](https://sheetjs.com/) + [JSZip](https://stuk.github.io/jszip/), producing a styled `.xlsx`
5. You download the result

This is not a one-shot code generator. Claude runs an **agentic loop** — it calls tools to inspect your data (`read_rows`, `get_column_stats`, `find_rows`, `compare_keys`), builds understanding, then writes code. If the code fails or produces bad output, it re-examines and fixes.

## Privacy

Your financial data stays in the browser. Only file metadata (sheet names, column headers, row counts) crosses the network to the Claude API. No values, no dollar amounts, no account balances.

## Usage

Serve the folder with any static HTTP server:

```
npx serve .
# or
python3 -m http.server
```

Open in browser. Enter your [Anthropic API key](https://console.anthropic.com/). Drop files. Go.

## Stack

Two files. No build step. No dependencies to install.

- `index.html` — UI
- `app.js` — agentic loop, tool execution, worker orchestration

Runtime dependencies loaded from CDN: SheetJS (xlsx read/write), JSZip (post-write style injection into xlsx XML).
