# Phase 5: Internal Auth and Reserve - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-02
**Phase:** 05-internal-auth-and-reserve
**Areas discussed:** Auth middleware, Request schema, Error responses, Policy check

---

## Auth Middleware

### Token Validation

| Option | Description | Selected |
|--------|-------------|----------|
| Constant-time compare | Same pattern as adminAuth.ts — timingSafeEqual against VAULT_INTERNAL_TOKEN | ✓ |
| Simple === comparison | Simpler but leaks timing info | |

**User's choice:** Constant-time compare
**Notes:** Matches existing adminAuth pattern

### Token Length

| Option | Description | Selected |
|--------|-------------|----------|
| 32 chars (same as admin) | Matches VAULTWARDEN_ADMIN_TOKEN constraint | ✓ |
| 16 chars | Shorter — service-to-service, less exposure | |
| No minimum | Trust the operator | |

**User's choice:** 32 chars
**Notes:** Consistency with existing admin token constraint

### Token Required?

| Option | Description | Selected |
|--------|-------------|----------|
| Optional | Internal routes only register when set — existing deployments unaffected | ✓ |
| Required | Forces all deployments to set it | |

**User's choice:** Optional
**Notes:** Non-breaking for existing deployments

---

## Request Schema

### Field Requirements

| Option | Description | Selected |
|--------|-------------|----------|
| Both required | Arbstr core always has this info — enforce at schema level | ✓ |
| Both optional | More flexible for other callers | |
| correlation_id required, model optional | Correlation essential, model just audit metadata | |

**User's choice:** Both required (correlation_id and model)
**Notes:** None

### Amount Constraints

| Option | Description | Selected |
|--------|-------------|----------|
| Positive integer only | z.number().int().positive() — prevents zero/negative | ✓ |
| Non-negative integer | Allow zero-amount reserves | |
| Just a number | Minimal validation | |

**User's choice:** Positive integer only
**Notes:** None

---

## Error Responses

### 402 Detail Level

| Option | Description | Selected |
|--------|-------------|----------|
| Include balance info | Return current_balance_msats and requested_msats — helps caller decide | ✓ |
| Code and message only | Don't leak balance to internal caller | |
| You decide | Claude picks | |

**User's choice:** Include balance info
**Notes:** Helps arbstr core decide whether to retry with lower amount

### Success Response

| Option | Description | Selected |
|--------|-------------|----------|
| Just reservation_id | Minimal response | |
| Include remaining balance | reservation_id + remaining_balance_msats | ✓ |

**User's choice:** Include remaining balance
**Notes:** Caller can make decisions without extra API call

---

## Policy Check

### Policy Enforcement

| Option | Description | Selected |
|--------|-------------|----------|
| Skip for v1.1 | Balance check sufficient for trusted internal caller | ✓ |
| Check max_transaction only | Reuse existing policy engine for per-agent limits | |
| Full policy check | max_transaction + daily_spend | |

**User's choice:** Skip for v1.1
**Notes:** Arbstr core is trusted — policy enforcement on billing reserves is future work

---

## Claude's Discretion

- Exact Zod schema structure for request/response types
- Where to place shared types (inline vs extracted)
- Conditional route registration pattern when VAULT_INTERNAL_TOKEN is unset

## Deferred Ideas

None — discussion stayed within phase scope
