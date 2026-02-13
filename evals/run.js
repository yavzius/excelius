#!/usr/bin/env bun
// Eval runner: runs the full pipeline against fixtures — explore, generate, execute, verify.
// Usage: ANTHROPIC_API_KEY=sk-ant-... bun evals/run.js [fixture-name]

const fs = require('fs');
const path = require('path');
const { runPipeline } = require('../src/pipeline');
const { scoreReport } = require('../src/pipeline/verify');

async function runFixture(apiKey, fixturePath) {
  const fixtureName = path.basename(fixturePath);
  const expected = JSON.parse(fs.readFileSync(path.join(fixturePath, 'expected.json'), 'utf-8'));

  const xlsxFiles = fs.readdirSync(fixturePath).filter(f => f.endsWith('.xlsx'));
  const files = xlsxFiles.map(f => ({
    name: f,
    buffer: fs.readFileSync(path.join(fixturePath, f)),
  }));

  console.log(`\n── ${fixtureName} ──`);
  console.log(`  Files: ${files.map(f => f.name).join(', ')}`);
  console.log(`  Prompt: ${expected.prompt.slice(0, 80)}...`);

  const t0 = Date.now();

  const result = await runPipeline({
    apiKey, files, prompt: expected.prompt, expected,
    onEvent: (e) => {
      if (e.status === 'started') process.stdout.write(`  Phase: ${e.phase}...`);
      else if (e.status === 'complete') process.stdout.write(` done\n`);
      else if (e.turn) process.stdout.write(` t${e.turn}`);
    },
  });

  const reportScore = scoreReport(result.report, expected);
  const verification = result.verification;

  // Print verification detail
  const tag = (pass) => pass === 'pass' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  Structure: ${tag(verification.structure)} | Values: ${tag(verification.values)} | Styling: ${tag(verification.styling)}`);
  console.log(`  Output: ${verification.row_count} rows, sheets: ${verification.sheet_names.join(', ')}`);
  if (verification.errors.length > 0) {
    for (const err of verification.errors) {
      console.log(`    \x1b[31m✗\x1b[0m ${err}`);
    }
  }

  return {
    fixture: fixtureName,
    reportScore,
    codeGenerated: true,
    executed: true,
    verification,
    explorationTurns: result.meta.explore.turns,
    codeGenAttempts: result.meta.codegen.attempts,
    tokens: {
      exploration: result.meta.explore.inputTokens + result.meta.explore.outputTokens,
      codegen: result.meta.codegen.inputTokens + result.meta.codegen.outputTokens,
    },
    latencyMs: Date.now() - t0,
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
      errors: errored.length,
      total_tokens: results.reduce((sum, r) => sum + (r.tokens?.exploration || 0) + (r.tokens?.codegen || 0), 0),
    },
  }, null, 2));

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results saved to: ${path.relative(process.cwd(), resultFile)}`);
  console.log(`Summary: ${passed.length}/${results.length} passed, ${styled.length}/${results.length} styled`);
  if (errored.length) console.log(`  Errors: ${errored.length}`);
  const totalTokens = results.reduce((sum, r) => sum + (r.tokens?.exploration || 0) + (r.tokens?.codegen || 0), 0);
  console.log(`  Total tokens: ${(totalTokens / 1000).toFixed(1)}k`);
}

main().catch(err => { console.error(err); process.exit(1); });
