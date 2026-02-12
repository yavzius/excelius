# Excelius

Drop Excel files, describe what you want in plain English, get a processed and styled `.xlsx` back. Runs entirely in the browser — your data never leaves your machine.

## Architecture

Two-agent pipeline — each with its own model, system prompt, and conversation:

1. **Exploration Agent** (Claude Haiku 4.5) — explores your files using tools (read rows, column stats, key comparison). Produces a structured report.
2. **Code Generation Agent** (Claude Opus 4.6) — receives the exploration report, generates SheetJS/JSZip code.
3. **Verification** — executes code in a sandboxed iframe + Web Worker, verifies output, retries if needed.

This separation means Opus never sees 15 turns of raw exploration data — it gets a dense, structured summary. Better code, fewer retries, lower cost.

## How it works

1. You upload `.xlsx` files and type a prompt ("merge these by account, sum Q1, bold headers")
2. Haiku explores your files using tools — reading rows, checking column types, comparing keys across sheets
3. Once it understands the structure, it submits a structured exploration report
4. Opus receives the report and writes JavaScript to process your data
5. The code runs in a **sandboxed iframe + Web Worker** with [SheetJS](https://sheetjs.com/) + [JSZip](https://stuk.github.io/jszip/), producing a styled `.xlsx`
6. The output previews in your browser and gets added to the file list — ask follow-up questions to refine it

**Iterative workflow**: Each output file becomes an input for the next prompt. "Merge these files" → "Now add a percentage column" → "Format as currency and bold headers" — each step builds on the last.

## Privacy

All processing happens in your browser. Files are parsed locally with SheetJS — Claude sees **row samples** (up to 50 rows per tool call) and **column statistics** (types, unique counts, min/max) to understand structure. Full datasets are never sent in bulk.

Generated code executes inside a sandboxed iframe with `Content-Security-Policy: connect-src 'none'` — the sandbox has no network access. Even if the LLM produces a `fetch()` call, CSP blocks it. Libraries are pre-fetched in the trusted parent context and passed in as source text.

## Usage

Serve the folder with any static HTTP server:

```
bunx serve .
```

Open in browser. Enter your [Anthropic API key](https://console.anthropic.com/). Drop files. Go.

## Evals

```
ANTHROPIC_API_KEY=sk-ant-... bun evals/run.js
```

Runs the agent pipeline against synthetic test fixtures and reports pass/fail, token usage, and latency per scenario. Fixtures cover: file joins, filtering, multi-sheet aggregation, and styling.

## Stack

Two files. No build step. No dependencies to install.

- `index.html` — UI
- `app.js` — two-agent pipeline, tool execution, worker orchestration

Runtime dependencies loaded from CDN: SheetJS (xlsx read/write), JSZip (post-write style injection into xlsx XML).
