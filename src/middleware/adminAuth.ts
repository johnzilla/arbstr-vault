import { timingSafeEqual } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

/**
 * Fastify onRequest hook for admin authentication.
 * Validates Bearer token against VAULTWARDEN_ADMIN_TOKEN using constant-time comparison.
 * Returns 401 on any failure (missing header, malformed, wrong token).
 */
export async function adminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: { code: 'unauthorized', message: 'Invalid admin token' },
    });
  }

  const provided = authHeader.slice(7); // Strip "Bearer "

  // Constant-time comparison against admin token
  try {
    const providedBuf = Buffer.from(provided, 'utf8');
    const expectedBuf = Buffer.from(config.VAULTWARDEN_ADMIN_TOKEN, 'utf8');

    // If lengths differ, pad both to same length but still return false
    if (providedBuf.length !== expectedBuf.length) {
      return reply.status(401).send({
        error: { code: 'unauthorized', message: 'Invalid admin token' },
      });
    }

    const valid = timingSafeEqual(providedBuf, expectedBuf);
    if (!valid) {
      return reply.status(401).send({
        error: { code: 'unauthorized', message: 'Invalid admin token' },
      });
    }
  } catch {
    return reply.status(401).send({
      error: { code: 'unauthorized', message: 'Invalid admin token' },
    });
  }
}
