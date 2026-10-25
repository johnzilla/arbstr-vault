/**
 * Operator webhook delivery (createWebhookService).
 *
 * - Signs the payload and stops at the first 2xx
 * - Retries non-2xx and network errors, then audits WEBHOOK_DELIVERY_FAILED
 * - Never throws, even when the audit write fails
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import { createWebhookService } from '../../src/modules/webhook/webhook.service.js';
import { logger } from '../../src/lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

const URL = 'https://ops.example/webhook';
const SECRET = 'webhook-secret-at-least-16';

type Db = BetterSQLite3Database<Record<string, never>>;

const event = {
  event: 'approval_required',
  agent_id: 'ag_hook',
  transaction_id: 'tx_hook',
  amount_msat: 5_000,
};

describe('operator webhook delivery', () => {
  let sqlite: Database.Database;
  let db: Db;
  let fetchMock: ReturnType<typeof vi.fn>;

  const failures = () =>
    db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'WEBHOOK_DELIVERY_FAILED')).all();

  const service = (overrides = {}) =>
    createWebhookService({ url: URL, secret: SECRET, retryDelaysMs: [0, 0, 0], ...overrides });

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const d = drizzle({ client: sqlite, schema });
    migrate(d, { migrationsFolder: MIGRATIONS_FOLDER });
    db = d as unknown as Db;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (sqlite.open) sqlite.close();
  });

  it('delivers a signed payload once and audits nothing on success', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await service().send(event, db);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL);
    const expected = createHmac('sha256', SECRET).update(init.body).digest('hex');
    expect(init.headers['X-ArbstrVault-Signature']).toBe(expected);
    expect(JSON.parse(init.body)).toMatchObject({ ...event, timestamp: expect.any(Number) });
    expect(failures()).toHaveLength(0);
  });

  it('audits WEBHOOK_DELIVERY_FAILED after every attempt returns non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 500 }));

    await service().send(event, db);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [row] = failures();
    expect(row).toMatchObject({ agent_id: 'ag_hook', ref_id: 'tx_hook', amount_msat: 5_000 });
    expect(row.metadata).toEqual({ event_type: 'approval_required', attempts: 4, last_error: 'HTTP 500' });
  });

  it('records the network error when the endpoint is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await service().send(event, db);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(failures()[0].metadata).toMatchObject({ attempts: 4, last_error: 'fetch failed' });
  });

  it('does not audit when a retry succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 200 }));

    await service().send(event, db);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(failures()).toHaveLength(0);
  });

  it('attributes events without an agent to system', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    await service().send({ event: 'approval_timeout' }, db);

    expect(failures()[0]).toMatchObject({ agent_id: 'system', ref_id: null, amount_msat: null });
  });

  it('sends unsigned when no secret is configured', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await service({ secret: undefined }).send(event, db);

    expect(fetchMock.mock.calls[0][1].headers['X-ArbstrVault-Signature']).toBe('unsigned');
  });

  it('does nothing when no webhook URL is configured', async () => {
    await createWebhookService({ retryDelaysMs: [0, 0, 0] }).send(event, db);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(failures()).toHaveLength(0);
  });

  it('resolves even if the audit write fails (DB closed during retries)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
    sqlite.close();

    await expect(service().send(event, db)).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });
});
