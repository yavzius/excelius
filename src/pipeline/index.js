// Pipeline orchestrator: explore → codegen → execute.
// Each phase is a standalone module; this composes them with event callbacks.

const { explore } = require('./explore');
const { codegen } = require('./codegen');
const { execute } = require('./execute');
const { verifyOutput } = require('./verify');

async function runPipeline({ apiKey, files, prompt, expected, onEvent, signal }) {
  const result = {
    report: null,
    code: null,
    output: null,
    verification: null,
    meta: { explore: null, codegen: null },
  };

  // Phase 1: Explore
  onEvent?.({ phase: 'exploring', status: 'started' });
  const exploration = await explore({
    apiKey, files, prompt, signal,
    onTurn: (turn) => onEvent?.({ phase: 'exploring', ...turn }),
  });
  result.report = exploration.report;
  result.meta.explore = exploration.meta;
  onEvent?.({ phase: 'exploring', status: 'complete', turns: exploration.meta.turns });

  // Phase 2: Generate code
  onEvent?.({ phase: 'codegen', status: 'started' });
  const codeResult = await codegen({
    apiKey, prompt, report: exploration.report, signal,
    onAttempt: (info) => onEvent?.({ phase: 'codegen', ...info }),
  });
  result.code = codeResult;
  result.meta.codegen = codeResult.meta;
  onEvent?.({ phase: 'codegen', status: 'complete', attempts: codeResult.meta.attempts });

  // Phase 3: Execute
  onEvent?.({ phase: 'executing', status: 'started' });
  const output = await execute(codeResult.code, files);
  result.output = output;
  onEvent?.({ phase: 'executing', status: 'complete', size: output.buffer.length });

  // Phase 4: Verify (optional — only if expected is provided)
  if (expected) {
    onEvent?.({ phase: 'verifying', status: 'started' });
    result.verification = await verifyOutput(output.buffer, expected);
    onEvent?.({ phase: 'verifying', status: 'complete', pass: result.verification.pass });
  }

  return result;
}

// Re-export individual modules for direct use
module.exports = {
  runPipeline,
  explore,
  codegen,
  execute,
  verifyOutput,
};
