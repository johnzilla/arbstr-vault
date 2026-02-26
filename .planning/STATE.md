# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-26)

**Core value:** Agents can request and execute payments within explicit policy limits, with all keys and connections centralized in the Treasury Service — never in the agents themselves
**Current focus:** Phase 1 — Foundation

## Current Position

Phase: 1 of 4 (Foundation)
Plan: 0 of TBD in current phase
Status: Ready to plan
Last activity: 2026-02-26 — Roadmap created; all 34 v1 requirements mapped across 4 phases

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**
- Last 5 plans: —
- Trend: —

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Start with simulated spends (Milestone 1): de-risk by building skeleton first, real payments later
- Self-hosted Cashu mint as hot wallet: control over minting/redeeming, limited balance for security
- Static token auth for v1: simplicity — only personal agents, no external users
- HTTP/JSON API (not gRPC): simpler for agent integration, sufficient for internal use

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 2 (Lightning): LND payment state machine edge cases under load warrant targeted research before planning — specifically TrackPaymentV2, ListPayments retry semantics, and HTLC slot exhaustion
- Phase 3 (Cashu): Nutshell PENDING lock correctness must be verified via source inspection before Phase 3 begins; cashu-ts 3.5.x / Nutshell 0.19.x NUT compatibility should be confirmed with a minimal integration test

## Session Continuity

Last session: 2026-02-26
Stopped at: Roadmap created — ready to begin Phase 1 planning
Resume file: None
