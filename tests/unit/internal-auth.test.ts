/**
 * Unit tests for internal auth middleware (Plan 05-01)
 *
 * Tests the internalAuth Fastify onRequest hook which validates X-Internal-Token header.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod/v4';

// Helper to build minimal mock Fastify reply
function buildMockReply() {
  const reply = {
    _statusCode: 200,
    _body: undefined as unknown,
    status(code: number) {
      reply._statusCode = code;
      return reply;
    },
    send(body: unknown) {
      reply._body = body;
      return reply;
    },
  };
  return reply;
}

describe('internalAuth middleware', () => {
  it('allows request when X-Internal-Token matches VAULT_INTERNAL_TOKEN', async () => {
    // Arrange: set env and import middleware fresh
    const token = 'a'.repeat(32);
    process.env.VAULT_INTERNAL_TOKEN = token;

    // We need to import after setting env since config parses at import time
    // Re-import via dynamic import with cache busting
    const { internalAuth } = await import('../../src/middleware/internalAuth.js');

    const request = { headers: { 'x-internal-token': token } } as any;
    const reply = buildMockReply();

    await internalAuth(request, reply as any);

    // Should NOT have sent a 401 — next handler called (reply not touched for 401)
    expect(reply._statusCode).toBe(200);
    expect(reply._body).toBeUndefined();
  });

  it('returns 401 when X-Internal-Token header is missing', async () => {
    const { internalAuth } = await import('../../src/middleware/internalAuth.js');

    const request = { headers: {} } as any;
    const reply = buildMockReply();

    await internalAuth(request, reply as any);

    expect(reply._statusCode).toBe(401);
    expect(reply._body).toEqual({
      error: { code: 'unauthorized', message: 'Invalid internal token' },
    });
  });

  it('returns 401 when X-Internal-Token header value is wrong', async () => {
    const { internalAuth } = await import('../../src/middleware/internalAuth.js');

    const request = { headers: { 'x-internal-token': 'wrong-token-here-that-is-long-enough' } } as any;
    const reply = buildMockReply();

    await internalAuth(request, reply as any);

    expect(reply._statusCode).toBe(401);
    expect(reply._body).toEqual({
      error: { code: 'unauthorized', message: 'Invalid internal token' },
    });
  });

  it('returns 401 when X-Internal-Token header is empty string', async () => {
    const { internalAuth } = await import('../../src/middleware/internalAuth.js');

    const request = { headers: { 'x-internal-token': '' } } as any;
    const reply = buildMockReply();

    await internalAuth(request, reply as any);

    expect(reply._statusCode).toBe(401);
    expect(reply._body).toEqual({
      error: { code: 'unauthorized', message: 'Invalid internal token' },
    });
  });

  it('returns 401 when VAULT_INTERNAL_TOKEN is not configured (undefined)', async () => {
    delete process.env.VAULT_INTERNAL_TOKEN;
    vi.resetModules();

    // Re-import after clearing the env var
    process.env.VAULTWARDEN_ADMIN_TOKEN = 'test-admin-token-that-is-long-enough-32c';
    const { internalAuth } = await import('../../src/middleware/internalAuth.js');

    const request = { headers: { 'x-internal-token': 'some-token-value-here-long-enough' } } as any;
    const reply = buildMockReply();

    await internalAuth(request, reply as any);

    expect(reply._statusCode).toBe(401);
    expect(reply._body).toEqual({
      error: { code: 'unauthorized', message: 'Invalid internal token' },
    });
  });
});

describe('VAULT_INTERNAL_TOKEN config validation (isolated schema snippet)', () => {
  const tokenFieldSchema = z
    .object({
      VAULT_INTERNAL_TOKEN: z.string().min(32).optional(),
    });

  it('config parses successfully when VAULT_INTERNAL_TOKEN is not set (optional field)', () => {
    const result = tokenFieldSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('config parses successfully with a valid 32+ char token', () => {
    const result = tokenFieldSchema.safeParse({
      VAULT_INTERNAL_TOKEN: 'a'.repeat(32),
    });
    expect(result.success).toBe(true);
  });

  it('config rejects VAULT_INTERNAL_TOKEN shorter than 32 characters', () => {
    const result = tokenFieldSchema.safeParse({
      VAULT_INTERNAL_TOKEN: 'short',
    });
    expect(result.success).toBe(false);
  });

  it('config rejects VAULT_INTERNAL_TOKEN with exactly 31 chars', () => {
    const result = tokenFieldSchema.safeParse({
      VAULT_INTERNAL_TOKEN: 'a'.repeat(31),
    });
    expect(result.success).toBe(false);
  });
});
