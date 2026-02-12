#!/usr/bin/env bun
// Eval runner: runs the agent pipeline against fixtures and reports results.
// Usage: ANTHROPIC_API_KEY=sk-ant-... bun evals/run.js [fixture-name]

const fs = require('fs');
const path = require('path');
const { runExploration, runCodeGen } = require('./lib/agent');
const { scoreReport } = require('./lib/verify');

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

  const latencyMs = Date.now() - t0;

  return {
    fixture: fixtureName,
    reportScore,
    codeGenerated: !!codeResult.code,
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

  console.log(`Running ${fixtures.length} fixture(s)...`);

  const results = [];
  for (const fixture of fixtures) {
    try {
      const result = await runFixture(apiKey, path.join(fixturesDir, fixture));
      results.push(result);
      console.log(`  Result: ${result.codeGenerated ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      console.log(`  Result: ERROR — ${err.message}`);
      results.push({ fixture, error: err.message });
    }
  }

  // Save results
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const resultFile = path.join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(resultFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    model_explore: 'claude-haiku-4-5-20251001',
    model_codegen: 'claude-opus-4-6',
    fixtures: results,
    summary: {
      total: results.length,
      passed: results.filter(r => r.codeGenerated).length,
      failed: results.filter(r => !r.codeGenerated && !r.error).length,
      errors: results.filter(r => r.error).length,
      total_tokens: results.reduce((sum, r) => sum + (r.tokens?.exploration || 0) + (r.tokens?.codegen || 0), 0),
    },
  }, null, 2));

  console.log(`\nResults saved to: ${resultFile}`);
  console.log(`Summary: ${results.filter(r => r.codeGenerated).length}/${results.length} passed`);
}

main().catch(err => { console.error(err); process.exit(1); });
