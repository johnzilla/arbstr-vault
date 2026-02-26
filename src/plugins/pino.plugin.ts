import { config } from '../config.js';

/**
 * Pino logger configuration with token redaction.
 *
 * Redacts sensitive credential fields before log serialization to prevent
 * bearer tokens from appearing in log output (SEC-05, OBSV-05).
 *
 * Redacted paths:
 * - req.headers.authorization — the HTTP Authorization header containing vtk_ tokens
 * - req.headers["authorization"] — bracket notation variant
 * - token — top-level token field
 * - *.token — any nested .token field (e.g. agent.token, body.token)
 * - token_hash — top-level SHA-256 hash (still sensitive to expose)
 * - *.token_hash — any nested .token_hash field
 * - raw_token — top-level raw token field
 * - *.raw_token — any nested .raw_token field
 *
 * Note: pino's `*` wildcard matches one level of nesting only.
 * Top-level fields require an explicit path (e.g. `token` not just `*.token`).
 */
export const loggerConfig = {
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["authorization"]',
      // Top-level sensitive fields (explicit paths required — `*.x` only matches nested)
      'token',
      'token_hash',
      'raw_token',
      // Nested sensitive fields
      '*.token',
      '*.token_hash',
      '*.raw_token',
    ],
    censor: '[REDACTED]',
  },
  // In test mode, suppress logs to keep test output clean
  ...(config.NODE_ENV === 'test' ? { level: 'silent' } : {}),
};
