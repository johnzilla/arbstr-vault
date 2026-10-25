import { pino } from 'pino';
import { loggerConfig } from '../plugins/pino.plugin.js';

/**
 * Logger for code that runs outside a request (startup recovery, services).
 * Same level and token redaction as Fastify's app.log, and silent under test.
 */
export const logger = pino(loggerConfig);
