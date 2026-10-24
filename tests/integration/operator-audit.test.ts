/**
 * GET /operator/audit — operator query over the whole audit log.
 *
 * - Admin token required (agent tokens are rejected)
 * - Newest first, cursor pagination without gaps or overlap
 * - Filters: agent_id (incl. "system"), action (one or a comma-separated list), ref_id, time range
 * - A real webhook delivery failure is visible through the endpoint
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ulid } from 'ulidx';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { hashToken } from '../../src/modules/tokens/tokens.service.js';
import { createWebhookService } from '../../src/modules/webhook/webhook.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

const TEST_ADMIN_TOKEN = 'test-admin-token-for-integration-tests-only';
const AGENT_TOKEN = 'vtk_operator_audit_agent_token';
const T0 = Date.UTC(2026, 9, 1);

process.env.VAULT_ADMIN_TOKEN = TEST_ADMIN_TOKEN;

type Db = BetterSQLite3Database<Record<string, never>>;
type Action = (typeof schema.auditLog.action.enumValues)[number];

describe('GET /operator/audit', () => {
  let app: ReturnType<typeof buildApp>;

  const db = () => app.db as unknown as Db;

  const get = (query = '', token = TEST_ADMIN_TOKEN) =>
    app.inject({ method: 'GET', url: `/operator/audit${query}`, headers: { authorization: `Bearer ${token}` } });

  const ids = async (query: string) => (await get(query)).json().entries.map((e: { id: string }) => e.id);

  /** Seed one entry per minute after T0 so id order == time order. */
  const seeded: { id: string; agent_id: string; action: Action; ref_id: string | null; at: number }[] = [];
  function seed(agent_id: string, action: Action, ref_id: string | null = null) {
    const at = T0 + seeded.length * 60_000;
    const id = ulid(at);
    app.db.insert(schema.auditLog).values({ id, agent_id, action, ref_id, created_at: new Date(at) }).run();
    seeded.push({ id, agent_id, action, ref_id, at });
    return id;
  }

  beforeEach(async () => {
    const sqlite = new Database(':memory:');
    const d = drizzle({ client: sqlite, schema });
    migrate(d, { migrationsFolder: MIGRATIONS_FOLDER });
    app = buildApp(d);
    await app.ready();
    app.db.insert(schema.agents).values({ id: 'ag_a', name: 'A', token_hash: hashToken(AGENT_TOKEN) }).run();

    seeded.length = 0;
    seed('ag_a', 'DEPOSIT');                              // 0
    seed('ag_b', 'PAYMENT_REQUEST', 'tx_1');              // 1
    seed('system', 'WEBHOOK_DELIVERY_FAILED');            // 2
    seed('ag_a', 'WEBHOOK_DELIVERY_FAILED', 'tx_2');      // 3
    seed('ag_b', 'APPROVAL_TIMEOUT', 'tx_1');             // 4
    seed('ag_a', 'RESERVATION_EXPIRED', 'tx_3');          // 5
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  const newestFirst = (pred: (s: (typeof seeded)[number]) => boolean = () => true) =>
    seeded.filter(pred).map((s) => s.id).reverse();

  it('requires the admin token', async () => {
    expect((await app.inject({ method: 'GET', url: '/operator/audit' })).statusCode).toBe(401);
    expect((await get('', AGENT_TOKEN)).statusCode).toBe(401);
  });

  it('returns entries across all agents, newest first', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(newestFirst());
    expect(body).toMatchObject({ has_more: false, next_cursor: null });
    expect(body.entries[0]).toMatchObject({ agent_id: 'ag_a', action: 'RESERVATION_EXPIRED', ref_id: 'tx_3' });
  });

  it('filters by agent, including system', async () => {
    expect(await ids('?agent_id=ag_a')).toEqual(newestFirst((s) => s.agent_id === 'ag_a'));
    expect(await ids('?agent_id=system')).toEqual([seeded[2].id]);
  });

  it('filters by one action or a comma-separated list', async () => {
    expect(await ids('?action=WEBHOOK_DELIVERY_FAILED'))
      .toEqual(newestFirst((s) => s.action === 'WEBHOOK_DELIVERY_FAILED'));
    expect(await ids('?action=APPROVAL_TIMEOUT,%20RESERVATION_EXPIRED'))
      .toEqual([seeded[5].id, seeded[4].id]);
  });

  it('rejects unknown actions', async () => {
    expect((await get('?action=NOT_AN_ACTION')).statusCode).toBe(400);
    expect((await get('?action=DEPOSIT,BOGUS')).statusCode).toBe(400);
    expect((await get('?action=')).statusCode).toBe(400);
  });

  it('filters by ref_id', async () => {
    expect(await ids('?ref_id=tx_1')).toEqual([seeded[4].id, seeded[1].id]);
  });

  it('filters by an inclusive time range', async () => {
    const q = `?start_date=${seeded[1].at}&end_date=${seeded[3].at}`;
    expect(await ids(q)).toEqual([seeded[3].id, seeded[2].id, seeded[1].id]);
    expect((await get(`?start_date=${seeded[3].at}&end_date=${seeded[1].at}`)).statusCode).toBe(400);
  });

  it('combines filters', async () => {
    expect(await ids(`?agent_id=ag_a&action=WEBHOOK_DELIVERY_FAILED,DEPOSIT&start_date=${seeded[1].at}`))
      .toEqual([seeded[3].id]);
  });

  it('paginates with a cursor, without gaps or overlap', async () => {
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const body = (await get(`?limit=4${cursor ? `&cursor=${cursor}` : ''}`)).json();
      pages.push(body.entries.map((e: { id: string }) => e.id));
      expect(body.has_more).toBe(body.next_cursor !== null);
      cursor = body.next_cursor;
    } while (cursor);

    expect(pages.map((p) => p.length)).toEqual([4, 2]);
    expect(pages.flat()).toEqual(newestFirst());
  });

  it('validates limit', async () => {
    expect((await get('?limit=0')).statusCode).toBe(400);
    expect((await get('?limit=201')).statusCode).toBe(400);
  });

  it('shows a real webhook delivery failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 502 })));
    const webhook = createWebhookService({ url: 'https://ops.example/hook', retryDelaysMs: [0, 0, 0] });
    await webhook.send({ event: 'approval_required', agent_id: 'ag_a', transaction_id: 'tx_live', amount_msat: 7_000 }, db());

    const [entry] = (await get('?action=WEBHOOK_DELIVERY_FAILED&ref_id=tx_live')).json().entries;
    expect(entry).toMatchObject({
      agent_id: 'ag_a',
      amount_msat: 7_000,
      metadata: { event_type: 'approval_required', attempts: 4, last_error: 'HTTP 502' },
    });
  });
});
