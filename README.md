# Excelius

Drop Excel files, describe what you want in plain English, get a processed and styled `.xlsx` back. Runs entirely in the browser — your data never leaves your machine.

## How it works

1. You upload `.xlsx` files and type a prompt ("merge these by account, sum Q1, bold headers")
2. Claude explores your files using tools — reading rows, checking column types, comparing keys across sheets
3. Once it understands the structure, it writes JavaScript to process your data
4. The code runs in a **sandboxed iframe + Web Worker** with [SheetJS](https://sheetjs.com/) + [JSZip](https://stuk.github.io/jszip/), producing a styled `.xlsx`
5. The output previews in your browser and gets added to the file list — ask follow-up questions to refine it

This is not a one-shot code generator. Claude runs an **agentic loop** — it calls tools to inspect your data (`read_rows`, `get_column_stats`, `find_rows`, `compare_keys`), builds understanding, then writes code. If the code fails or produces bad output, it re-examines and fixes.

**Iterative workflow**: Each output file becomes an input for the next prompt. "Merge these files" → "Now add a percentage column" → "Format as currency and bold headers" — each step builds on the last.

## Privacy

All processing happens in your browser. Files are parsed locally with SheetJS — Claude sees **row samples** (up to 50 rows per tool call) and **column statistics** (types, unique counts, min/max) to understand structure. Full datasets are never sent in bulk.

Generated code executes inside a sandboxed iframe with `Content-Security-Policy: connect-src 'none'` — the sandbox has no network access. Even if the LLM produces a `fetch()` call, CSP blocks it. Libraries are pre-fetched in the trusted parent context and passed in as source text.

## Usage

Serve the folder with any static HTTP server:

```
bunx serve .
# or
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
