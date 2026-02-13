// Shared configuration for the pipeline.
// All model names, limits, and timeouts in one place.

module.exports = {
  MODEL_EXPLORE: 'claude-haiku-4-5-20251001',
  MODEL_CODEGEN: 'claude-opus-4-6',

  MAX_API_RETRIES: 3,
  RETRY_STATUS_CODES: [429, 529, 502, 503],

  MAX_EXPLORATION_TURNS: 15,
  MAX_CODE_RETRIES: 3,

  MAX_TOKENS_DEFAULT: 16384,
  MAX_TOKENS_EXTENDED: 32768,

  EXECUTION_TIMEOUT_MS: 30_000,

  MAX_READ_ROWS: 50,
  MAX_UNIQUE_VALUES: 30,
  TOOL_RESULT_MAX_CHARS: 4000,
};
