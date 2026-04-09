/**
 * Full lifecycle end-to-end test (Plan 05)
 *
 * Exercises the ENTIRE Phase 1 API in sequence, validating all 5 ROADMAP success criteria:
 *
 * SC-1: Operator registers agent, receives agent_id + bearer token
 * SC-2: Agent submits payment, receives simulated response with policy decision and tx ref
 * SC-3: Over-limit payment is denied before ledger write
 * SC-4: Every action produces audit log entry, retrievable via API
 * SC-5: Tokens never appear in logs or subsequent API responses
 *
 * Also validates: balance isolation, pagination, audit filtering, agent details endpoint.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

const TEST_ADMIN_TOKEN = 'test-admin-token-for-integration-tests-only';

process.env.VAULT_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
process.env.NODE_ENV = 'test';

function buildTestApp() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return buildApp(db);
}

describe('Complete payment lifecycle end-to-end', () => {
  it('validates all 5 Phase 1 success criteria in a single sequential test', async () => {
    const app = buildTestApp();
    await app.ready();

    // Track all response bodies to verify token doesn't leak
    const allResponseBodies: string[] = [];
    // The agent token returned on registration — never should appear again
    let agentToken = '';

    // ----------------------------------------------------------------
    // Step 1: Health check
    // ----------------------------------------------------------------
    {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { status: string; timestamp: string };
      expect(body.status).toBe('ok');
      expect(typeof body.timestamp).toBe('string');
      // Verify ISO 8601
      expect(() => new Date(body.timestamp)).not.toThrow();
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    }

    // ----------------------------------------------------------------
    // Step 2: Register agent (SC-1: operator registers, receives agent_id + bearer token)
    // ----------------------------------------------------------------
    let agentId = '';
    {
      const res = await app.inject({
        method: 'POST',
        url: '/agents',
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
        payload: { name: 'trading-bot-1' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as {
        agent_id: string;
        token: string;
        created_at: string;
      };

      // SC-1: agent_id starts with ag_, token starts with vtk_
      expect(body.agent_id).toMatch(/^ag_/);
      expect(body.token).toMatch(/^vtk_/);
      expect(typeof body.created_at).toBe('string');

      agentId = body.agent_id;
      agentToken = body.token;
      // We now have the token — it should never appear in subsequent response bodies
    }

    // ----------------------------------------------------------------
    // Step 3: Verify deny-all default — agent cannot spend without policy
    // ----------------------------------------------------------------
    {
      const res = await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/pay`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: {
          amount_msat: 1_000,
          asset: 'BTC_simulated',
          purpose: 'test payment without policy',
          destination_type: 'lightning_invoice',
          destination: 'lnbc...',
        },
      });
      expect(res.statusCode).toBe(200);
      allResponseBodies.push(res.body);
      const body = JSON.parse(res.body) as { policy_decision: string; reason: string };
      expect(body.policy_decision).toBe('DENY');
      expect(body.reason).toBe('deny_all_policy');
    }

    // ----------------------------------------------------------------
    // Step 4: Set policy
    // ----------------------------------------------------------------
    {
      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${agentId}/policy`,
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
        payload: { max_transaction_msat: 50_000, daily_limit_msat: 200_000 },
      });
      expect(res.statusCode).toBe(200);
      allResponseBodies.push(res.body);
      const body = JSON.parse(res.body) as {
        agent_id: string;
        policy: { max_transaction_msat: number; daily_limit_msat: number };
      };
      expect(body.agent_id).toBe(agentId);
      expect(body.policy.max_transaction_msat).toBe(50_000);
      expect(body.policy.daily_limit_msat).toBe(200_000);
    }

    // ----------------------------------------------------------------
    // Step 5: Deposit funds
    // ----------------------------------------------------------------
    {
      const res = await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/deposit`,
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
        payload: { amount_msat: 500_000 },
      });
      expect(res.statusCode).toBe(200);
      allResponseBodies.push(res.body);
      const body = JSON.parse(res.body) as {
        agent_id: string;
        amount_msat: number;
        balance_msat: number;
        transaction_id: string;
      };
      expect(body.agent_id).toBe(agentId);
      expect(body.amount_msat).toBe(500_000);
      expect(body.balance_msat).toBe(500_000);
      expect(body.transaction_id).toMatch(/^tx_/);
    }

    // ----------------------------------------------------------------
    // Step 6: Successful payment (SC-2: agent submits payment, receives ALLOW + tx ref)
    // ----------------------------------------------------------------
    let txId = '';
    {
      const res = await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/pay`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: {
          amount_msat: 25_000,
          asset: 'BTC_simulated',
          purpose: 'test payment',
          destination_type: 'lightning_invoice',
          destination: 'lnbc...',
        },
      });
      expect(res.statusCode).toBe(200);
      allResponseBodies.push(res.body);
      const body = JSON.parse(res.body) as {
        transaction_id: string;
        policy_decision: string;
        mode: string;
        status: string;
      };

      // SC-2: ALLOW decision with simulated mode and SETTLED status
      expect(body.policy_decision).toBe('ALLOW');
      expect(body.mode).toBe('simulated');
      expect(body.status).toBe('SETTLED');
      expect(body.transaction_id).toMatch(/^tx_/);

      txId = body.transaction_id;
    }

    // ----------------------------------------------------------------
    // Step 7: Check balance after payment
    // ----------------------------------------------------------------
    {
      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agentId}/balance`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(res.statusCode).toBe(200);
      allResponseBodies.push(res.body);
      const body = JSON.parse(res.body) as {
        agent_id: string;
        balance_msat: number;
        asset: string;
      };
      // 500_000 - 25_000 = 475_000
      expect(body.balance_msat).toBe(475_000);
      expect(body.agent_id).toBe(agentId);
      expect(typeof body.asset).toBe('string');
    }

    // ----------------------------------------------------------------
    // Step 8: Policy deny — over limit (SC-3: over-limit denied before ledger write)
    // ----------------------------------------------------------------
    {
      const res = await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/pay`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: {
          amount_msat: 60_000, // exceeds max_transaction_msat: 50_000
          asset: 'BTC_simulated',
          purpose: 'over-limit payment',
          destination_type: 'lightning_invoice',
          destination: 'lnbc...',
        },
      });
      expect(res.statusCode).toBe(200);
      allResponseBodies.push(res.body);
      const body = JSON.parse(res.body) as { policy_decision: string; reason: string };
      // SC-3: DENY before ledger write
      expect(body.policy_decision).toBe('DENY');
      expect(body.reason).toBe('exceeds_max_transaction');
    }

    // ----------------------------------------------------------------
    // Step 9: Balance unchanged after denied payment
    // ----------------------------------------------------------------
    {
      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agentId}/balance`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(res.statusCode).toBe(200);
      allResponseBodies.push(res.body);
      const body = JSON.parse(res.body) as { balance_msat: number };
      // Still 475_000 — denied payment doesn't touch the ledger
      expect(body.balance_msat).toBe(475_000);
    }

    // ----------------------------------------------------------------
    // Step 10: Query full audit log (SC-4: every action in audit, retrievable via API)
    // ----------------------------------------------------------------
    {
      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agentId}/history`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(res.statusCode).toBe(200);
      allResponseBodies.push(res.body);
      const body = JSON.parse(res.body) as {
        entries: Array<{
          action: string;
          policy_decision: string | null;
          amount_msat: number | null;
          ref_id: string | null;
        }>;
        next_cursor: string | null;
        has_more: boolean;
      };

      expect(Array.isArray(body.entries)).toBe(true);
      const actions = body.entries.map((e) => e.action);

      // SC-4: all expected audit action types present
      expect(actions).toContain('AGENT_REGISTERED');
      expect(actions).toContain('POLICY_UPDATED');
      expect(actions).toContain('DEPOSIT');
      expect(actions).toContain('PAYMENT_REQUEST');
      expect(actions).toContain('PAYMENT_SETTLED');

      // Verify ALLOW and DENY PAYMENT_REQUEST entries both exist
      const allowEntry = body.entries.find(
        (e) => e.action === 'PAYMENT_REQUEST' && e.policy_decision === 'ALLOW',
      );
      const denyEntry = body.entries.find(
        (e) => e.action === 'PAYMENT_REQUEST' && e.policy_decision === 'DENY',
      );
      expect(allowEntry).toBeDefined();
      expect(denyEntry).toBeDefined();

      // Verify PAYMENT_SETTLED has the transaction ref_id
      const settledEntry = body.entries.find((e) => e.action === 'PAYMENT_SETTLED');
      expect(settledEntry).toBeDefined();
      expect(settledEntry!.ref_id).toBe(txId);

      // Pagination fields present
      expect('has_more' in body).toBe(true);
      expect('next_cursor' in body).toBe(true);

      // All entries use integer amounts (millisatoshis)
      for (const entry of body.entries.filter((e) => e.amount_msat !== null)) {
        expect(Number.isInteger(entry.amount_msat)).toBe(true);
      }
    }

    // ----------------------------------------------------------------
    // Step 11: Audit filtered by action_type
    // ----------------------------------------------------------------
    {
      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agentId}/history?action_type=PAYMENT_REQUEST`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(res.statusCode).toBe(200);
      allResponseBodies.push(res.body);
      const body = JSON.parse(res.body) as {
        entries: Array<{ action: string }>;
      };

      // All returned entries must be PAYMENT_REQUEST
      expect(body.entries.length).toBeGreaterThanOrEqual(1);
      for (const entry of body.entries) {
        expect(entry.action).toBe('PAYMENT_REQUEST');
      }
    }

    // ----------------------------------------------------------------
    // Step 12: Audit filtered by time range
    // ----------------------------------------------------------------
    {
      const start = Date.now() - 60_000; // 1 minute ago
      const end = Date.now() + 60_000; // 1 minute from now

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agentId}/history?start_date=${start}&end_date=${end}`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(res.statusCode).toBe(200);
      allResponseBodies.push(res.body);
      const body = JSON.parse(res.body) as { entries: unknown[] };
      // All entries should be within the time range
      expect(body.entries.length).toBeGreaterThan(0);
    }

    // ----------------------------------------------------------------
    // Step 13: View agent details (AGNT-05: includes metadata and policy snapshot)
    // ----------------------------------------------------------------
    {
      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agentId}`,
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      allResponseBodies.push(res.body);
      const body = JSON.parse(res.body) as {
        agent_id: string;
        name: string;
        metadata: Record<string, string> | null;
        policy: { max_transaction_msat: number; daily_limit_msat: number };
        created_at: string;
      };

      expect(body.agent_id).toBe(agentId);
      expect(body.name).toBe('trading-bot-1');
      expect(body.policy.max_transaction_msat).toBe(50_000);
      expect(body.policy.daily_limit_msat).toBe(200_000);
      expect(typeof body.created_at).toBe('string');
    }

    // ----------------------------------------------------------------
    // Step 14: List agents (with cursor pagination fields)
    // ----------------------------------------------------------------
    {
      const res = await app.inject({
        method: 'GET',
        url: '/agents',
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      allResponseBodies.push(res.body);
      const body = JSON.parse(res.body) as {
        agents: Array<{ id: string; name: string }>;
        next_cursor: string | null;
        has_more: boolean;
      };

      // The registered agent should be in the list
      expect(Array.isArray(body.agents)).toBe(true);
      expect(body.agents.length).toBeGreaterThanOrEqual(1);
      const found = body.agents.find((a) => a.id === agentId);
      expect(found).toBeDefined();
      expect(found!.name).toBe('trading-bot-1');

      // Cursor pagination fields present
      expect('next_cursor' in body).toBe(true);
      expect('has_more' in body).toBe(true);
    }

    // ----------------------------------------------------------------
    // Step 15: Verify agent token never appears in any subsequent response body (SC-5)
    // ----------------------------------------------------------------
    {
      // agentToken was only returned in step 2's response body (not tracked in allResponseBodies)
      // All subsequent response bodies must NOT contain the raw vtk_ token
      for (const bodyText of allResponseBodies) {
        expect(bodyText).not.toContain(agentToken);
      }
    }

    // ----------------------------------------------------------------
    // Additional assertions: ID prefixes, amounts, timestamps throughout
    // ----------------------------------------------------------------
    {
      // agent ID prefix
      expect(agentId).toMatch(/^ag_/);
      // transaction ID prefix
      expect(txId).toMatch(/^tx_/);
      // agentToken prefix
      expect(agentToken).toMatch(/^vtk_/);
    }
  });
});
