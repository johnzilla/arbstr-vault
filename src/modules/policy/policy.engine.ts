// Policy engine — pure synchronous function with zero external dependencies.
// Fail-closed: any error or unconfigured policy produces DENY, never ALLOW or throws.

export type PolicyOutcome = 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN_APPROVAL';

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason: string;
  rule_matched?: string;
}

export interface PolicyConfig {
  max_transaction_msat: number;
  daily_limit_msat: number;
}

export interface PolicyContext {
  balance_msat: number;
  daily_spent_msat: number;
  request_amount_msat: number;
}

/**
 * Evaluate a payment request against a policy configuration.
 *
 * Returns ALLOW only when all checks pass.
 * Returns DENY for: null policy, deny-all policy, over-limit, insufficient balance, any internal error.
 * Never throws — all errors are caught and converted to DENY.
 *
 * REQUIRE_HUMAN_APPROVAL is a valid outcome type reserved for Phase 4 escalation paths.
 */
export function evaluatePolicy(
  policy: PolicyConfig | null,
  ctx: PolicyContext,
): PolicyDecision {
  try {
    // Check 1: no policy configured
    if (policy === null) {
      return { outcome: 'DENY', reason: 'no_policy_configured' };
    }

    // Check 2: deny-all policy (both limits explicitly set to 0)
    if (policy.max_transaction_msat === 0 && policy.daily_limit_msat === 0) {
      return { outcome: 'DENY', reason: 'deny_all_policy' };
    }

    // Check 3: per-transaction amount limit
    if (ctx.request_amount_msat > policy.max_transaction_msat) {
      return {
        outcome: 'DENY',
        reason: 'exceeds_max_transaction',
        rule_matched: 'max_transaction_msat',
      };
    }

    // Check 4: daily spend limit (rolling 24h window)
    if (ctx.daily_spent_msat + ctx.request_amount_msat > policy.daily_limit_msat) {
      return {
        outcome: 'DENY',
        reason: 'exceeds_daily_limit',
        rule_matched: 'daily_limit_msat',
      };
    }

    // Check 5: sufficient balance
    if (ctx.balance_msat < ctx.request_amount_msat) {
      return { outcome: 'DENY', reason: 'insufficient_balance' };
    }

    // All checks passed
    return { outcome: 'ALLOW', reason: 'policy_passed' };
  } catch {
    // Fail-closed: any internal error produces DENY, never ALLOW, never throws
    return { outcome: 'DENY', reason: 'policy_engine_error' };
  }
}
