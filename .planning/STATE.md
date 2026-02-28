---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: unknown
last_updated: "2026-02-28T00:18:13.442Z"
progress:
  total_phases: 3
  completed_phases: 3
  total_plans: 11
  completed_plans: 11
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-26)

**Core value:** Agents can request and execute payments within explicit policy limits, with all keys and connections centralized in the Treasury Service — never in the agents themselves
**Current focus:** Phase 4 — Agent UX (phase 3 complete)

## Current Position

Phase: 3 of 4 (Cashu Backend) — COMPLETE
Plan: 3 of 3 in current phase — COMPLETE
Status: 03-03 complete — Integration tests (14 tests), Docker Nutshell mint, payment status routing trace. Phase 3 complete.
Last activity: 2026-02-28 — Completed 03-03: Cashu integration tests, Docker Nutshell, payment status routing trace

Progress: [████████████] ~100% (Phase 3 of 3 done)

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

**Recent Trend:**
- Last 7 plans: 01-04 (4 min), 01-05 (6 min), 02-01 (3 min), 02-02 (5 min), 02-03 (5 min), 03-01 (5 min), 03-02 (5 min)
- Trend: Stable at ~4-5 min/plan

*Updated after each plan completion*
| Phase 03 P03 | 5 | 2 tasks | 4 files |

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

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 2 (Lightning): LND payment state machine edge cases under load warrant targeted research before planning — specifically TrackPaymentV2, ListPayments retry semantics, and HTLC slot exhaustion
- Phase 3 (Cashu): Nutshell PENDING lock correctness must be verified via source inspection before Phase 3 begins; cashu-ts 3.5.x / Nutshell 0.19.x NUT compatibility should be confirmed with a minimal integration test

## Session Continuity

Last session: 2026-02-28
Stopped at: Completed 03-03-PLAN.md — Integration tests, Docker Nutshell, payment status routing trace. Phase 3 complete.
Resume file: .planning/phases/04-agent-ux/ (next phase)
Resume command: /gsd:execute-phase 4
