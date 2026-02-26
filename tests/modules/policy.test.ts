import { describe, it, expect } from 'vitest';
import {
  evaluatePolicy,
  type PolicyConfig,
  type PolicyContext,
  type PolicyOutcome,
  type PolicyDecision,
} from '../../src/modules/policy/policy.engine.js';

// Standard valid policy used across tests
const validPolicy: PolicyConfig = {
  max_transaction_msat: 100_000,
  daily_limit_msat: 1_000_000,
};

// Standard valid context: balance well above request, daily spend low
const validCtx: PolicyContext = {
  balance_msat: 500_000,
  daily_spent_msat: 50_000,
  request_amount_msat: 10_000,
};

describe('evaluatePolicy', () => {
  it('null policy returns DENY with reason no_policy_configured', () => {
    const result = evaluatePolicy(null, validCtx);
    expect(result.outcome).toBe('DENY');
    expect(result.reason).toBe('no_policy_configured');
  });

  it('deny-all policy (both limits 0) returns DENY with reason deny_all_policy', () => {
    const denyAll: PolicyConfig = { max_transaction_msat: 0, daily_limit_msat: 0 };
    const result = evaluatePolicy(denyAll, validCtx);
    expect(result.outcome).toBe('DENY');
    expect(result.reason).toBe('deny_all_policy');
  });

  it('amount exceeding max_transaction_msat returns DENY', () => {
    const ctx: PolicyContext = {
      balance_msat: 500_000,
      daily_spent_msat: 0,
      request_amount_msat: 100_001,
    };
    const result = evaluatePolicy(validPolicy, ctx);
    expect(result.outcome).toBe('DENY');
    expect(result.reason).toBe('exceeds_max_transaction');
    expect(result.rule_matched).toBe('max_transaction_msat');
  });

  it('amount exactly at max_transaction_msat returns ALLOW (boundary)', () => {
    const ctx: PolicyContext = {
      balance_msat: 500_000,
      daily_spent_msat: 0,
      request_amount_msat: 100_000, // exactly at max
    };
    const result = evaluatePolicy(validPolicy, ctx);
    expect(result.outcome).toBe('ALLOW');
    expect(result.reason).toBe('policy_passed');
  });

  it('daily spend + amount exceeding daily_limit_msat returns DENY', () => {
    const ctx: PolicyContext = {
      balance_msat: 500_000,
      daily_spent_msat: 950_000,
      request_amount_msat: 60_000, // 950k + 60k = 1_010_000 > 1_000_000
    };
    const result = evaluatePolicy(validPolicy, ctx);
    expect(result.outcome).toBe('DENY');
    expect(result.reason).toBe('exceeds_daily_limit');
    expect(result.rule_matched).toBe('daily_limit_msat');
  });

  it('daily spend + amount exactly at daily_limit_msat returns ALLOW (boundary)', () => {
    const ctx: PolicyContext = {
      balance_msat: 500_000,
      daily_spent_msat: 900_000,
      request_amount_msat: 100_000, // 900k + 100k = exactly 1_000_000
    };
    const result = evaluatePolicy(validPolicy, ctx);
    expect(result.outcome).toBe('ALLOW');
    expect(result.reason).toBe('policy_passed');
  });

  it('insufficient balance returns DENY', () => {
    const ctx: PolicyContext = {
      balance_msat: 5_000,
      daily_spent_msat: 0,
      request_amount_msat: 10_000, // balance < request
    };
    const result = evaluatePolicy(validPolicy, ctx);
    expect(result.outcome).toBe('DENY');
    expect(result.reason).toBe('insufficient_balance');
  });

  it('all checks pass returns ALLOW', () => {
    const result = evaluatePolicy(validPolicy, validCtx);
    expect(result.outcome).toBe('ALLOW');
    expect(result.reason).toBe('policy_passed');
  });

  it('policy with throwing getter fields returns DENY (fail-closed) — catch block fires on property access error', () => {
    // Craft a policy object where accessing max_transaction_msat throws — this triggers the catch.
    // The plan requires: "pass a crafted object with NaN values to trigger the catch".
    // NaN alone does not throw in JS, so we use a getter that throws to force the catch path.
    const throwingPolicy = Object.defineProperties({} as PolicyConfig, {
      max_transaction_msat: {
        get() { throw new TypeError('simulated NaN/corrupt field error'); },
      },
      daily_limit_msat: { value: NaN },
    });
    const result = evaluatePolicy(throwingPolicy, validCtx);
    expect(result.outcome).toBe('DENY');
    expect(result.reason).toBe('policy_engine_error');
  });

  it('Object.create(null) as policy triggers catch — ALLOW is never returned from error path', () => {
    // Object.create(null) has no prototype; property access doesn't throw,
    // but we can make the catch trigger by setting a getter that throws.
    const badPolicy = Object.defineProperty(Object.create(null), 'max_transaction_msat', {
      get() {
        throw new Error('property access error');
      },
    }) as PolicyConfig;
    const result = evaluatePolicy(badPolicy, validCtx);
    expect(result.outcome).toBe('DENY');
    expect(result.reason).toBe('policy_engine_error');
    // Critical assertion: catch path NEVER returns ALLOW
    expect(result.outcome).not.toBe('ALLOW');
  });

  it('REQUIRE_HUMAN_APPROVAL is a valid PolicyOutcome type', () => {
    // Type-level verification that REQUIRE_HUMAN_APPROVAL is part of PolicyOutcome union.
    // This type is reserved for Phase 4 escalation paths but must exist in the type system.
    const humanApproval: PolicyOutcome = 'REQUIRE_HUMAN_APPROVAL';
    expect(humanApproval).toBe('REQUIRE_HUMAN_APPROVAL');

    // Verify it's usable as a PolicyDecision outcome
    const decision: PolicyDecision = {
      outcome: 'REQUIRE_HUMAN_APPROVAL',
      reason: 'human_review_required',
    };
    expect(decision.outcome).toBe('REQUIRE_HUMAN_APPROVAL');
  });
});
