/**
 * Approval lifecycle tests (Plan 04-02)
 *
 * Validates:
 * - PLCY-06: Over-limit transactions with approval_timeout_ms route to PENDING_APPROVAL
 * - PLCY-07: Pending approvals time out to DENY after configurable interval
 * - Operator can approve/deny via REST API
 * - CAS prevents race between manual resolution and timeout
 * - Payment status route returns PENDING_APPROVAL for approval-pending payments
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { approvalsService } from '../../src/modules/approvals/approvals.service.js';
import type { FastifyInstance } from 'fastify';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type Db = BetterSQLite3Database<Record<string, never>>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

const TEST_ADMIN_TOKEN = 'test-admin-token-for-integration-tests-only';

process.env.VAULTWARDEN_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
process.env.NODE_ENV = 'test';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

function buildTestApp() {
  const db = createTestDb();
  const app = buildApp(db);
  return { app, db };
}

// Helper: register a new agent and return { agent_id, token }
async function registerAgent(app: FastifyInstance, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { agent_id: string; token: string };
}

// Helper: deposit funds for an agent
async function deposit(app: FastifyInstance, agentId: string, amountMsat: number) {
  const res = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/deposit`,
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    payload: { amount_msat: amountMsat },
  });
  expect(res.statusCode).toBe(200);
}

// Helper: set policy with approval_timeout_ms
async function setPolicyWithApproval(
  app: FastifyInstance,
  agentId: string,
  opts: { maxTxMsat: number; dailyLimitMsat: number; approvalTimeoutMs: number },
) {
  const res = await app.inject({
    method: 'PATCH',
    url: `/operator/agents/${agentId}/policy`,
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    payload: {
      max_transaction_msat: opts.maxTxMsat,
      daily_limit_msat: opts.dailyLimitMsat,
      approval_timeout_ms: opts.approvalTimeoutMs,
    },
  });
  expect(res.statusCode).toBe(200);
}

// Helper: submit a payment
async function submitPayment(app: FastifyInstance, agentId: string, token: string, amountMsat: number) {
  const res = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/pay`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      amount_msat: amountMsat,
      asset: 'BTC_simulated',
      purpose: 'test payment',
      destination_type: 'internal',
      destination: 'test-dest',
    },
  });
  return res;
}

describe('Approval lifecycle (PLCY-06, PLCY-07)', () => {
  // Test 1: Payment exceeding max_transaction_msat with approval_timeout_ms returns PENDING_APPROVAL
  it('returns PENDING_APPROVAL for over-limit payment when approval_timeout_ms is configured', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'approval-test-agent');
    await deposit(app, agent_id, 100_000);
    await setPolicyWithApproval(app, agent_id, {
      maxTxMsat: 5_000,
      dailyLimitMsat: 100_000,
      approvalTimeoutMs: 300_000, // 5 minutes
    });

    // Payment exceeds max_transaction_msat (10_000 > 5_000)
    const res = await submitPayment(app, agent_id, token, 10_000);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('PENDING_APPROVAL');
    expect(body.policy_decision).toBe('REQUIRE_HUMAN_APPROVAL');
    expect(body.transaction_id).toMatch(/^tx_/);
  });

  // Test 2: Operator approves pending payment
  it('operator approves pending payment — approval changes to approved state', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'approve-test-agent');
    await deposit(app, agent_id, 100_000);
    await setPolicyWithApproval(app, agent_id, {
      maxTxMsat: 5_000,
      dailyLimitMsat: 100_000,
      approvalTimeoutMs: 300_000,
    });

    // Submit over-limit payment
    const payRes = await submitPayment(app, agent_id, token, 10_000);
    const payBody = JSON.parse(payRes.body);
    expect(payBody.status).toBe('PENDING_APPROVAL');
    const txId = payBody.transaction_id;

    // Find the approval via listing
    const listRes = await app.inject({
      method: 'GET',
      url: '/operator/approvals',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    expect(listBody.approvals.length).toBe(1);
    const approvalId = listBody.approvals[0].id;

    // Operator approves
    const approveRes = await app.inject({
      method: 'POST',
      url: `/operator/approvals/${approvalId}/approve`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(approveRes.statusCode).toBe(200);
    const approveBody = JSON.parse(approveRes.body);
    expect(approveBody.status).toBe('approved');
    expect(approveBody.payment_status).toBe('APPROVED');
    expect(approveBody.transaction_id).toBe(txId);
  });

  // Test 3: Operator denies pending payment
  it('operator denies pending payment — RELEASE written, balance restored', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'deny-test-agent');
    await deposit(app, agent_id, 100_000);
    await setPolicyWithApproval(app, agent_id, {
      maxTxMsat: 5_000,
      dailyLimitMsat: 100_000,
      approvalTimeoutMs: 300_000,
    });

    // Submit over-limit payment (reserves 10_000)
    const payRes = await submitPayment(app, agent_id, token, 10_000);
    expect(JSON.parse(payRes.body).status).toBe('PENDING_APPROVAL');
    const txId = JSON.parse(payRes.body).transaction_id;

    // Find the approval
    const listRes = await app.inject({
      method: 'GET',
      url: '/operator/approvals',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    const approvalId = JSON.parse(listRes.body).approvals[0].id;

    // Operator denies
    const denyRes = await app.inject({
      method: 'POST',
      url: `/operator/approvals/${approvalId}/deny`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(denyRes.statusCode).toBe(200);
    const denyBody = JSON.parse(denyRes.body);
    expect(denyBody.status).toBe('denied');
    expect(denyBody.transaction_id).toBe(txId);

    // Check payment status is now FAILED
    const statusRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/payments/${txId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(statusRes.statusCode).toBe(200);
    const statusBody = JSON.parse(statusRes.body);
    expect(statusBody.status).toBe('FAILED');

    // Check balance restored to full 100_000 (RESERVE was released)
    const balRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/balance`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(balRes.body).balance_msat).toBe(100_000);
  });

  // Test 4: Double-resolve returns 409 Conflict
  it('double-resolve returns 409 Conflict (CAS prevents race)', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'double-resolve-agent');
    await deposit(app, agent_id, 100_000);
    await setPolicyWithApproval(app, agent_id, {
      maxTxMsat: 5_000,
      dailyLimitMsat: 100_000,
      approvalTimeoutMs: 300_000,
    });

    // Submit over-limit payment
    await submitPayment(app, agent_id, token, 10_000);

    const listRes = await app.inject({
      method: 'GET',
      url: '/operator/approvals',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    const approvalId = JSON.parse(listRes.body).approvals[0].id;

    // First approve — should succeed
    const approveRes = await app.inject({
      method: 'POST',
      url: `/operator/approvals/${approvalId}/approve`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(approveRes.statusCode).toBe(200);

    // Second resolve (deny) — should return 409
    const denyRes = await app.inject({
      method: 'POST',
      url: `/operator/approvals/${approvalId}/deny`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(denyRes.statusCode).toBe(409);
    expect(JSON.parse(denyRes.body).error.code).toBe('conflict');
  });

  // Test 5: Payment status shows PENDING_APPROVAL (not PENDING)
  it('payment status route returns PENDING_APPROVAL for approval-pending payment', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'status-test-agent');
    await deposit(app, agent_id, 100_000);
    await setPolicyWithApproval(app, agent_id, {
      maxTxMsat: 5_000,
      dailyLimitMsat: 100_000,
      approvalTimeoutMs: 300_000,
    });

    // Submit over-limit payment
    const payRes = await submitPayment(app, agent_id, token, 10_000);
    const txId = JSON.parse(payRes.body).transaction_id;

    // Poll payment status — must be PENDING_APPROVAL (not PENDING)
    const statusRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/payments/${txId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(JSON.parse(statusRes.body).status).toBe('PENDING_APPROVAL');
  });

  // Test 6: Timeout expiration auto-denies with RELEASE + APPROVAL_TIMEOUT audit
  it('expireTimedOut auto-denies expired approvals with RELEASE and APPROVAL_TIMEOUT audit', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'timeout-test-agent');
    await deposit(app, agent_id, 100_000);

    // Use minimum allowed approval_timeout_ms (30_000 = 30s) for setup
    await setPolicyWithApproval(app, agent_id, {
      maxTxMsat: 5_000,
      dailyLimitMsat: 100_000,
      approvalTimeoutMs: 30_000, // minimum allowed by API validation
    });

    // Submit over-limit payment (creates pending approval with 30s timeout)
    const payRes = await submitPayment(app, agent_id, token, 10_000);
    const txId = JSON.parse(payRes.body).transaction_id;
    expect(JSON.parse(payRes.body).status).toBe('PENDING_APPROVAL');

    // Find the approval ID
    const listRes1 = await app.inject({
      method: 'GET',
      url: '/operator/approvals',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    const approvalId = JSON.parse(listRes1.body).approvals[0].id;

    // Directly expire the approval by manipulating its expires_at in the DB
    // (testing internal expiry logic directly, without waiting 30s)
    const { pendingApprovals: pendingApprovalsTable } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    db.update(pendingApprovalsTable)
      .set({ expires_at: new Date(Date.now() - 1) }) // Set to 1ms ago
      .where(eq(pendingApprovalsTable.id, approvalId))
      .run();

    // Call expireTimedOut directly
    approvalsService.expireTimedOut(db as unknown as Db);

    // Payment status should now be FAILED (RELEASE written by timeout)
    const statusRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/payments/${txId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(JSON.parse(statusRes.body).status).toBe('FAILED');

    // Balance should be restored (RESERVE released by timeout)
    const balRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/balance`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(balRes.body).balance_msat).toBe(100_000);

    // Verify the approval row is timed_out
    const listRes2 = await app.inject({
      method: 'GET',
      url: '/operator/approvals?status=all',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    const approvals = JSON.parse(listRes2.body).approvals;
    const timedOut = approvals.find((a: any) => a.transaction_id === txId);
    expect(timedOut).toBeDefined();
    expect(timedOut.status).toBe('timed_out');
  });

  // Test 7: Payment without approval_timeout_ms returns DENY (not REQUIRE_HUMAN_APPROVAL)
  it('payment without approval_timeout_ms returns FAILED with DENY (not PENDING_APPROVAL)', async () => {
    const { app } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'no-approval-timeout-agent');
    await deposit(app, agent_id, 100_000);

    // Set policy WITHOUT approval_timeout_ms
    const policyRes = await app.inject({
      method: 'PATCH',
      url: `/operator/agents/${agent_id}/policy`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: {
        max_transaction_msat: 5_000,
        daily_limit_msat: 100_000,
        // No approval_timeout_ms
      },
    });
    expect(policyRes.statusCode).toBe(200);

    // Payment exceeds max_transaction_msat — should DENY (not REQUIRE_HUMAN_APPROVAL)
    const res = await submitPayment(app, agent_id, token, 10_000);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('FAILED');
    expect(body.policy_decision).toBe('DENY');
  });
});
