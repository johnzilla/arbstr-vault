import { timingSafeEqual } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

/**
 * Fastify onRequest hook for internal service authentication.
 * Validates X-Internal-Token header against VAULT_INTERNAL_TOKEN using constant-time comparison.
 * Returns 401 on any failure (missing header, empty, wrong token, or token unconfigured).
 */
export async function internalAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.headers['x-internal-token'];

  if (!config.VAULT_INTERNAL_TOKEN || typeof token !== 'string' || !token) {
    return reply.status(401).send({
      error: { code: 'unauthorized', message: 'Invalid internal token' },
    });
  }

  try {
    const providedBuf = Buffer.from(token, 'utf8');
    const expectedBuf = Buffer.from(config.VAULT_INTERNAL_TOKEN, 'utf8');

    if (providedBuf.length !== expectedBuf.length) {
      return reply.status(401).send({
        error: { code: 'unauthorized', message: 'Invalid internal token' },
      });
    }

    const valid = timingSafeEqual(providedBuf, expectedBuf);
    if (!valid) {
      return reply.status(401).send({
        error: { code: 'unauthorized', message: 'Invalid internal token' },
      });
    }
  } catch {
    return reply.status(401).send({
      error: { code: 'unauthorized', message: 'Invalid internal token' },
    });
  }
}
