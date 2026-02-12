#!/usr/bin/env bun
// Eval runner: runs the full agent pipeline against fixtures — explore, generate, execute, verify.
// Usage: ANTHROPIC_API_KEY=sk-ant-... bun evals/run.js [fixture-name]

const fs = require('fs');
const path = require('path');
const { runExploration, runCodeGen } = require('./lib/agent');
const { executeCode } = require('./lib/execute');
const { verifyOutput, scoreReport } = require('./lib/verify');

const EXPLORATION_PROMPT = fs.readFileSync(path.join(__dirname, 'lib', 'exploration-prompt.txt'), 'utf-8');

function buildCodeGenPrompt(report) {
  const template = fs.readFileSync(path.join(__dirname, 'lib', 'codegen-prompt-template.txt'), 'utf-8');
  return template.replace('{{REPORT}}', JSON.stringify(report, null, 2));
}

async function runFixture(apiKey, fixturePath) {
  const fixtureName = path.basename(fixturePath);
  const expected = JSON.parse(fs.readFileSync(path.join(fixturePath, 'expected.json'), 'utf-8'));

  // Load xlsx files
  const xlsxFiles = fs.readdirSync(fixturePath).filter(f => f.endsWith('.xlsx'));
  const files = xlsxFiles.map(f => ({
    name: f,
    buffer: fs.readFileSync(path.join(fixturePath, f)),
  }));

  console.log(`\n── ${fixtureName} ──`);
  console.log(`  Files: ${files.map(f => f.name).join(', ')}`);
  console.log(`  Prompt: ${expected.prompt.slice(0, 80)}...`);

  const t0 = Date.now();

  // Phase 1: Explore
  console.log('  Phase 1: Exploring...');
  const exploration = await runExploration(apiKey, files, expected.prompt, EXPLORATION_PROMPT);
  const reportScore = scoreReport(exploration.report, expected);
  console.log(`  Exploration: ${exploration.meta.turns} turns, ${exploration.meta.inputTokens + exploration.meta.outputTokens} tokens`);

  // Phase 2: Generate code
  console.log('  Phase 2: Generating code...');
  const codeGenPrompt = buildCodeGenPrompt(exploration.report);
  const codeResult = await runCodeGen(apiKey, expected.prompt, exploration.report, codeGenPrompt);
  console.log(`  Code gen: ${codeResult.meta.attempts} attempt(s), ${codeResult.meta.inputTokens + codeResult.meta.outputTokens} tokens`);

  // Phase 3: Execute generated code
  console.log('  Phase 3: Executing code...');
  let execution;
  try {
    execution = await executeCode(codeResult.code, files);
    console.log(`  Execution: OK (${(execution.buffer.length / 1024).toFixed(1)} KB, ${execution.logs.length} log lines)`);
  } catch (execErr) {
    console.log(`  Execution: FAILED — ${execErr.message}`);
    return {
      fixture: fixtureName,
      reportScore,
      codeGenerated: true,
      executed: false,
      executionError: execErr.message,
      explorationTurns: exploration.meta.turns,
      codeGenAttempts: codeResult.meta.attempts,
      tokens: {
        exploration: exploration.meta.inputTokens + exploration.meta.outputTokens,
        codegen: codeResult.meta.inputTokens + codeResult.meta.outputTokens,
      },
      latencyMs: Date.now() - t0,
      trace: exploration.trace,
    };
  }

  // Phase 4: Verify output
  console.log('  Phase 4: Verifying output...');
  const verification = await verifyOutput(execution.buffer, expected);

  // Print verification detail
  const tag = (pass) => pass === 'pass' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  Structure: ${tag(verification.structure)} | Values: ${tag(verification.values)} | Styling: ${tag(verification.styling)}`);
  console.log(`  Output: ${verification.row_count} rows, sheets: ${verification.sheet_names.join(', ')}`);
  if (verification.errors.length > 0) {
    for (const err of verification.errors) {
      console.log(`    \x1b[31m✗\x1b[0m ${err}`);
    }
  }

  const latencyMs = Date.now() - t0;

  return {
    fixture: fixtureName,
    reportScore,
    codeGenerated: true,
    executed: true,
    verification,
    explorationTurns: exploration.meta.turns,
    codeGenAttempts: codeResult.meta.attempts,
    tokens: {
      exploration: exploration.meta.inputTokens + exploration.meta.outputTokens,
      codegen: codeResult.meta.inputTokens + codeResult.meta.outputTokens,
    },
    latencyMs,
    trace: exploration.trace,
  };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Set ANTHROPIC_API_KEY environment variable');
    process.exit(1);
  }

  const fixtureFilter = process.argv[2];
  const fixturesDir = path.join(__dirname, 'fixtures');
  let fixtures = fs.readdirSync(fixturesDir).filter(f =>
    fs.statSync(path.join(fixturesDir, f)).isDirectory()
  );

  if (fixtureFilter) {
    fixtures = fixtures.filter(f => f.includes(fixtureFilter));
  }

  console.log(`Running ${fixtures.length} fixture(s)...\n`);

  const results = [];
  for (const fixture of fixtures) {
    try {
      const result = await runFixture(apiKey, path.join(fixturesDir, fixture));
      results.push(result);

      // Summary line
      const passed = result.verification?.pass;
      const styled = result.verification?.styling_pass;
      const label = !result.executed ? '\x1b[31mEXEC_FAIL\x1b[0m'
        : passed && styled ? '\x1b[32mPASS\x1b[0m'
        : passed ? '\x1b[33mPASS (no styling)\x1b[0m'
        : '\x1b[31mFAIL\x1b[0m';
      console.log(`  Result: ${label}`);
    } catch (err) {
      console.log(`  Result: \x1b[31mERROR\x1b[0m — ${err.message}`);
      results.push({ fixture, error: err.message });
    }
  }

  // Save results
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const resultFile = path.join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  const passed = results.filter(r => r.verification?.pass);
  const styled = results.filter(r => r.verification?.styling_pass);
  const execFailed = results.filter(r => r.executed === false);
  const errored = results.filter(r => r.error);

  fs.writeFileSync(resultFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    model_explore: 'claude-haiku-4-5-20251001',
    model_codegen: 'claude-opus-4-6',
    fixtures: results,
    summary: {
      total: results.length,
      passed: passed.length,
      styling_passed: styled.length,
      exec_failed: execFailed.length,
      errors: errored.length,
      total_tokens: results.reduce((sum, r) => sum + (r.tokens?.exploration || 0) + (r.tokens?.codegen || 0), 0),
    },
  }, null, 2));

  // Final summary
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results saved to: ${path.relative(process.cwd(), resultFile)}`);
  console.log(`Summary: ${passed.length}/${results.length} passed, ${styled.length}/${results.length} styled`);
  if (execFailed.length) console.log(`  Execution failures: ${execFailed.length}`);
  if (errored.length) console.log(`  Errors: ${errored.length}`);
  const totalTokens = results.reduce((sum, r) => sum + (r.tokens?.exploration || 0) + (r.tokens?.codegen || 0), 0);
  console.log(`  Total tokens: ${(totalTokens / 1000).toFixed(1)}k`);
}

main().catch(err => { console.error(err); process.exit(1); });
