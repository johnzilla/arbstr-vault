/**
 * Policy versioning tests (Plan 04-01)
 *
 * Validates:
 * - PLCY-08: Policy changes create new version rows (append-only)
 * - PLCY-09: Payment evaluation reads policy version at request timestamp (point-in-time)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';
import { policyVersionsRepo } from '../../src/modules/agents/agents.repo.js';

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

// Helper: PATCH versioned policy endpoint
async function patchPolicy(
  app: FastifyInstance,
  agentId: string,
  body: Record<string, unknown>,
) {
  const res = await app.inject({
    method: 'PATCH',
    url: `/operator/agents/${agentId}/policy`,
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    payload: body,
  });
  return res;
}

describe('Policy versioning (PLCY-08, PLCY-09)', () => {
  // Test 1: PATCH /operator/agents/:id/policy creates new versions
  it('creates version 1 on first PATCH, version 2 on second PATCH', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id } = await registerAgent(app, 'versioning-test-agent');

    // First PATCH — should create version 2 (version 1 was created on registration)
    const res1 = await patchPolicy(app, agent_id, {
      max_transaction_msat: 100_000,
      daily_limit_msat: 1_000_000,
    });
    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.policy.version).toBe(2);
    expect(body1.policy.max_transaction_msat).toBe(100_000);
    expect(body1.policy.daily_limit_msat).toBe(1_000_000);

    // Second PATCH — should create version 3
    const res2 = await patchPolicy(app, agent_id, {
      max_transaction_msat: 200_000,
      daily_limit_msat: 2_000_000,
    });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.policy.version).toBe(3);
    expect(body2.policy.max_transaction_msat).toBe(200_000);
  });

  // Test 2: Point-in-time policy evaluation (PLCY-09)
  it('payment uses the policy version effective at request time', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'point-in-time-agent');

    // Record timestamp T0 (after registration, before first manual policy update)
    const t0 = Date.now();

    // Wait a tick so effective_from timestamps are distinct
    await new Promise(r => setTimeout(r, 2));

    // Update to high limits (version 2)
    const patchRes = await patchPolicy(app, agent_id, {
      max_transaction_msat: 1_000_000_000, // 1M sat — should always ALLOW
      daily_limit_msat: 10_000_000_000,
    });
    expect(patchRes.statusCode).toBe(200);

    // Verify policyVersionsRepo.getVersionAt at T0 returns version 1 (deny-all)
    const vAtT0 = policyVersionsRepo.getVersionAt(db, agent_id, t0);
    expect(vAtT0).not.toBeNull();
    expect(vAtT0!.version).toBe(1);
    expect(vAtT0!.max_transaction_msat).toBe(0); // deny-all

    // Verify getVersionAt at current time returns version 2 (high limits)
    const vNow = policyVersionsRepo.getVersionAt(db, agent_id, Date.now());
    expect(vNow).not.toBeNull();
    expect(vNow!.version).toBe(2);
    expect(vNow!.max_transaction_msat).toBe(1_000_000_000);
  });

  // Test 3: Agent registration creates both policies and policy_versions rows
  it('registration creates both legacy policies row and policy_versions version 1', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id } = await registerAgent(app, 'registration-test-agent');

    // Check policy_versions has version 1
    const version1 = policyVersionsRepo.getCurrent(db, agent_id);
    expect(version1).not.toBeNull();
    expect(version1!.version).toBe(1);
    expect(version1!.max_transaction_msat).toBe(0); // deny-all defaults
    expect(version1!.daily_limit_msat).toBe(0);

    // Check legacy policies table still has a row (for backward compat)
    const legacyRows = db.select().from(schema.policies).all();
    const agentLegacyPolicy = legacyRows.find(p => p.agent_id === agent_id);
    expect(agentLegacyPolicy).toBeDefined();
    expect(agentLegacyPolicy!.max_transaction_msat).toBe(0);
  });

  // Test 4: GET /agents/:id returns policy from policy_versions (not legacy table)
  it('GET /agents/:id returns policy from policy_versions', async () => {
    const { app } = buildTestApp();
    await app.ready();

    const { agent_id } = await registerAgent(app, 'get-policy-test-agent');

    // Update to specific limits
    await patchPolicy(app, agent_id, {
      max_transaction_msat: 500_000,
      daily_limit_msat: 5_000_000,
      approval_timeout_ms: 120_000,
    });

    // GET /agents/:id should return the updated policy
    const getRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body);
    expect(body.policy.max_transaction_msat).toBe(500_000);
    expect(body.policy.daily_limit_msat).toBe(5_000_000);
  });

  // Test 5: Policy versioning preserves all fields including new Phase 4 fields
  it('policy version preserves approval_timeout_ms, alert_floor_msat, alert_cooldown_ms', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id } = await registerAgent(app, 'full-fields-agent');

    const patchRes = await patchPolicy(app, agent_id, {
      max_transaction_msat: 100_000,
      daily_limit_msat: 1_000_000,
      max_fee_msat: 500,
      approval_timeout_ms: 60_000,
      alert_floor_msat: 5_000_000,
      alert_cooldown_ms: 1_800_000,
    });
    expect(patchRes.statusCode).toBe(200);
    const patchBody = JSON.parse(patchRes.body);
    expect(patchBody.policy.max_fee_msat).toBe(500);
    expect(patchBody.policy.approval_timeout_ms).toBe(60_000);
    expect(patchBody.policy.alert_floor_msat).toBe(5_000_000);
    expect(patchBody.policy.alert_cooldown_ms).toBe(1_800_000);

    // Verify stored in DB
    const current = policyVersionsRepo.getCurrent(db, agent_id);
    expect(current!.approval_timeout_ms).toBe(60_000);
    expect(current!.alert_floor_msat).toBe(5_000_000);
    expect(current!.alert_cooldown_ms).toBe(1_800_000);
  });
});
