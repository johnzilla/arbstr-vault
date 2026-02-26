import type { FastifyRequest, FastifyReply } from 'fastify';
import { agentsRepo } from '../modules/agents/agents.repo.js';
import { hashToken } from '../modules/tokens/tokens.service.js';
import type { agents } from '../db/schema.js';

// Augment FastifyRequest with agent identity fields
declare module 'fastify' {
  interface FastifyRequest {
    agentId?: string;
    agent?: typeof agents.$inferSelect;
  }
}

/**
 * Fastify onRequest hook for agent authentication.
 * Validates vtk_ Bearer token, injects agent identity, and enforces agent-owns-resource scope.
 * Uses app.db decorator (injected by buildApp) so tests can inject an in-memory db.
 */
export async function agentAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: { code: 'unauthorized', message: 'Invalid agent token' },
    });
  }

  const provided = authHeader.slice(7); // Strip "Bearer "

  // Agent tokens must start with vtk_
  if (!provided.startsWith('vtk_')) {
    return reply.status(401).send({
      error: { code: 'unauthorized', message: 'Invalid agent token' },
    });
  }

  // Hash and look up agent using the app-level db decorator
  const db = request.server.db;
  const tokenHash = hashToken(provided);
  const agent = agentsRepo.findByTokenHash(db, tokenHash);

  if (!agent) {
    return reply.status(401).send({
      error: { code: 'unauthorized', message: 'Invalid agent token' },
    });
  }

  // Inject agent identity into request
  request.agentId = agent.id;
  request.agent = agent;

  // Enforce agent-owns-resource scope: if route has :id param, it must match authenticated agent
  const params = request.params as Record<string, string> | undefined;
  if (params && typeof params.id === 'string' && params.id !== agent.id) {
    return reply.status(403).send({
      error: { code: 'forbidden', message: "Cannot access another agent's resources" },
    });
  }
}
