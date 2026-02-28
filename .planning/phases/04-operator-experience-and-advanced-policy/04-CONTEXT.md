# Phase 4: Operator Experience and Advanced Policy - Context

**Gathered:** 2026-02-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Complete the operator control plane: human approval workflow for over-limit transactions with configurable timeout, agent withdrawal requests, balance alert notifications, operator dashboard API, and versioned policy history. This phase delivers PAY-07, PLCY-06, PLCY-07, PLCY-08, PLCY-09, OBSV-06, OBSV-07.

</domain>

<decisions>
## Implementation Decisions

### Human Approval Workflow
- Webhook callback to a configured operator URL when a payment triggers REQUIRE_HUMAN_APPROVAL; event type `approval_required`
- Operator approves or denies via REST API: POST /operator/approvals/:id/approve or /deny; returns the payment result immediately
- Default timeout: 5 minutes before auto-deny; configurable per-agent in policy (`approval_timeout_ms`)
- RESERVE the payment amount immediately when entering pending state (same RESERVE/RELEASE pattern as Lightning/Cashu); RELEASE on deny or timeout
- Agent's payment request returns `status: 'PENDING_APPROVAL'` with the transaction_id so the agent can poll for resolution

### Withdrawal Mechanics
- Dedicated endpoint: POST /agents/:id/withdrawals — agent provides a BOLT11 invoice and amount
- Returns a withdrawal_id that enters the approval queue
- Withdrawals always require operator approval (no auto-approve path)
- No separate withdrawal limits — same per-agent max_transaction and daily_limit policy applies; approval is the primary safeguard
- Treasury fulfills approved withdrawals by paying the BOLT11 invoice via LND (reuses existing Lightning payment flow)

### Notification Delivery
- Single operator webhook URL for all event types: `approval_required`, `balance_alert`, `withdrawal_requested`, `approval_timeout`
- Balance alerts check after each payment settles — if balance is below the configured per-agent floor, fire alert
- Cooldown period: after sending a balance alert for an agent, don't send another for that agent within a configurable cooldown (default 1 hour)
- Webhook failure handling: retry 3x with exponential backoff (1s, 5s, 15s), then log as `webhook_delivery_failed` in audit log; never block the payment flow
- Webhook URL configured in global config: `OPERATOR_WEBHOOK_URL`

### Operator Dashboard API
- GET /operator/dashboard returns full snapshot per agent: balance, daily spend, daily utilization (% of daily limit), active policy (current version fields), pending approvals count, last payment timestamp, balance alert status (below floor or not)
- Basic filtering: query param `status` (active/all), sort by `balance`, `daily_spend`, or `name` (asc/desc)
- Single API call — no pagination needed for personal-use scale (10-50 agents)

### Policy Versioning
- Append-only version history: every policy update creates a new version row with `effective_from` timestamp and `version` number
- Current policy = latest version for that agent
- Payment evaluation reads the policy version whose `effective_from` <= request timestamp (PLCY-09)
- Old versions are never deleted
- PATCH /operator/agents/:id/policy updates the policy; new version takes effect immediately (`effective_from = now`)

### Claude's Discretion
- Webhook payload schema and signing/verification
- Approval queue storage schema (new table vs extending audit_log)
- Policy version query optimization
- Dashboard response schema field names
- Timeout checker implementation (interval polling vs event-driven)

</decisions>

<specifics>
## Specific Ideas

- RESERVE pattern for pending approvals mirrors Lightning and Cashu — consistent three-phase flow across all payment states
- Withdrawal endpoint is intentionally separate from payment endpoint to keep the API semantics clean (paying an external service vs withdrawing your own balance)
- Webhook is fire-and-forget from Treasury's perspective — never blocks payment flow; operator's integration handles routing events to the right handler

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-operator-experience-and-advanced-policy*
*Context gathered: 2026-02-27*
