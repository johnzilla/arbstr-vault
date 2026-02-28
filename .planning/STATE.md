---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: in_progress
last_updated: "2026-02-28T03:59:08Z"
progress:
  total_phases: 4
  completed_phases: 3
  total_plans: 14
  completed_plans: 12
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-26)

**Core value:** Agents can request and execute payments within explicit policy limits, with all keys and connections centralized in the Treasury Service — never in the agents themselves
**Current focus:** Phase 4 — Operator Experience and Advanced Policy

## Current Position

Phase: 4 of 4 (Operator Experience and Advanced Policy)
Plan: 1 of 3 in current phase — COMPLETE
Status: 04-01 complete — Append-only policy versioning, point-in-time evaluation, webhook service, PATCH route.
Last activity: 2026-02-28 — Completed 04-01: policy_versions table, webhookService, policyVersionsRepo, 5 tests

Progress: [████████████░░░] ~85% (Phase 4 Plan 1 of 3 done)

## Performance Metrics

**Velocity:**
- Total plans completed: 5
- Average duration: ~4.0 minutes
- Total execution time: ~21 minutes

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-foundation | 5 | ~21 min | ~4.2 min |
| 02-lightning-backend | 3 | ~13 min | ~4.3 min |
| 03-cashu-backend | 3 | ~15 min | ~5 min |
| 04-operator-experience | 1 done | ~8 min | ~8 min |

**Recent Trend:**
- Last 8 plans: 01-04 (4 min), 01-05 (6 min), 02-01 (3 min), 02-02 (5 min), 02-03 (5 min), 03-01 (5 min), 03-02 (5 min), 04-01 (8 min)
- Trend: Stable at ~5-8 min/plan

*Updated after each plan completion*
| Phase 03 P03 | 5 | 2 tasks | 4 files |
| Phase 04 P01 | 8 | 2 tasks | 9 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Start with simulated spends (Milestone 1): de-risk by building skeleton first, real payments later
- Self-hosted Cashu mint as hot wallet: control over minting/redeeming, limited balance for security
- Static token auth for v1: simplicity — only personal agents, no external users
- HTTP/JSON API (not gRPC): simpler for agent integration, sufficient for internal use
- Use zod/v4 import path (not 'zod') — confirmed subpath available in zod@4.3.6
- WAL mode enabled with foreign_keys=ON and synchronous=NORMAL for SQLite performance
- buildApp() factory pattern separates app construction from server lifecycle
- Deny-all defaults: policies default to 0 msat limits — agents cannot spend until operator configures
- REQUIRE_HUMAN_APPROVAL type exists in PolicyOutcome now — trigger path deferred to Phase 4
- BetterSQLite3Database<Record<string, never>> as module Db type — satisfies TablesRelationalConfig for both db and tx
- ledgerRepo uses drizzle sql tagged template for COALESCE(SUM(...)) — no first-class sum() in drizzle SQLite
- buildApp(injectedDb?) accepts optional db — routes use app.db decorator for test isolation without module mocking
- agentAuth uses request.server.db (not direct import) — same testability reason as above
- vitest.config.ts sets env vars before ESM module graph loads — config.ts evaluates at import time, not runtime
- Agent scope enforcement: agentAuth hook checks :id param against authenticated agent.id, returns 403 on mismatch
- better-sqlite3 sync constraint: transaction callbacks cannot return promises; payment service uses two-phase sync IMMEDIATE transactions with async wallet call between them
- POST /agents/:id/pay always returns 200; policy_decision field carries ALLOW/DENY outcome — HTTP status reflects request processing not policy outcome
- Dual Db type casting: agentsRepo uses full-schema DB; ledger/audit repos use narrow Record<string,never>; cast via unknown at call sites inside transaction
- Pino top-level redact paths: `*.token` wildcard only matches nested fields — explicit `token`, `token_hash`, `raw_token` paths also required for top-level redaction
- buildApp overloaded to accept BuildAppOptions {db?, loggerStream?} — loggerStream enables test capture of pino output
- Fail-closed test via paymentsService.processPayment(closedDb) — service layer boundary more reliable than HTTP when agentAuth also uses DB
- ESM named imports from lightning 11.x work directly in type:module project — no createRequire wrapper needed
- verifyMacaroonScope (SEC-05): attempt getChainBalance at startup; success = overprivileged macaroon = process.exit(1)
- getPendingLightningPayments uses SQL NOT IN subquery to find RESERVE entries without RELEASE/PAYMENT counterparts
- Drizzle insert() requires explicit cast for narrow enum types: `as 'simulated' | 'lightning'`
- LightningStreamError rejects Promise but does NOT trigger RELEASE — stream errors keep ledger PENDING
- payment_hash stored synchronously in closure variable in 'paying' handler — prevents race condition in regtest
- createPaymentsService(wallet) factory enables wallet injection without module mocking; backward-compat singleton exported
- app.paymentsService Fastify decorator — routes use decorator, not direct import, for wallet decoupling
- initializeLightningBackend dynamically imported in index.ts — avoids loading lightning npm when WALLET_BACKEND=simulated
- Fee debit is a separate PAYMENT ledger entry on SETTLED — cleaner balance math and audit trail
- [Phase 02-lightning-backend]: Audit log is authoritative for payment status (PAYMENT_SETTLED/PAYMENT_FAILED actions); ledger entry types are fallback
- [Phase 02-lightning-backend]: verifyMacaroonScope throws FATAL Error; connectWithRetry catches it and calls process.exit(1)
- [Phase 02-lightning-backend]: Mock Lightning tests use vi.mock('lightning') hoisted before module graph — no live LND needed for CI
- [Phase 03-cashu-backend]: cashu-ts v3.5.0 Wallet.keyChain.getKeysets() used for keyset rotation; proof pool depletion returns FAILED (no auto-mint until Plan 02); MeltQuoteState.PAID enum used for type safety; WALLET_BACKEND=auto requires both Lightning AND Cashu env vars
- [Phase 03-cashu-backend]: createPaymentsService backward compat: single non-simulatedWallet arg treated as lightningWallet (not simulatedWallet) to preserve RESERVE/RELEASE semantic from pre-refactor tests
- [Phase 03-cashu-backend]: selectRail() not exported; preferred_rail agent hint overrides threshold routing; fallback adjusts RESERVE/RELEASE correctly per direction (Lightning->Cashu vs Cashu->Lightning)
- [Phase 03-cashu-backend]: CashuClient.getKeysets() is synchronous; crash recovery uses checkMeltQuote per PENDING op; keyset rotation writes CASHU_KEYSET_SWAP audit with agent_id='system'
- [Phase 03]: Cashu PAYMENT ledger entry omits explicit id=txId when fallback after Lightning RESERVE — prevents UNIQUE constraint violation
- [Phase 03]: Payment status routing trace prefers PAYMENT_SETTLED metadata; falls back to PAYMENT_REQUEST metadata for initial_rail
- [Phase 04-01]: requestTimestamp = Date.now() captured before Phase 1 IMMEDIATE tx — point-in-time lookups use this snapshot for correct versioning even if policy changes mid-flight
- [Phase 04-01]: processPayment falls back to agentsRepo.getWithPolicy (legacy policies table) when getVersionAt returns null — ensures test fixtures that only insert policies rows continue to pass
- [Phase 04-01]: pendingApprovals table schema added in migration 0003 alongside policy_versions — Plan 02 will wire repo and service; schema-only for now
- [Phase 04-01]: webhookService.send is fire-and-forget; callers use .catch(() => {}) to avoid blocking payment flow

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 2 (Lightning): LND payment state machine edge cases under load warrant targeted research before planning — specifically TrackPaymentV2, ListPayments retry semantics, and HTLC slot exhaustion
- Phase 3 (Cashu): Nutshell PENDING lock correctness must be verified via source inspection before Phase 3 begins; cashu-ts 3.5.x / Nutshell 0.19.x NUT compatibility should be confirmed with a minimal integration test

## Session Continuity

Last session: 2026-02-28
Stopped at: Completed 04-01-PLAN.md — Append-only policy versioning, point-in-time evaluation, webhook service, PATCH route.
Resume file: .planning/phases/04-operator-experience-and-advanced-policy/04-02-PLAN.md
Resume command: /gsd:execute-phase 4
