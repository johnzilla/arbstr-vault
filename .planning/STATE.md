# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-26)

**Core value:** Agents can request and execute payments within explicit policy limits, with all keys and connections centralized in the Treasury Service — never in the agents themselves
**Current focus:** Phase 1 — Foundation

## Current Position

Phase: 1 of 4 (Foundation)
Plan: 1 of 5 in current phase
Status: In progress
Last activity: 2026-02-26 — Completed 01-01: Foundation scaffolding, schema, app skeleton

Progress: [█░░░░░░░░░] 5%

## Performance Metrics

**Velocity:**
- Total plans completed: 1
- Average duration: ~3 minutes
- Total execution time: ~3 minutes

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-foundation | 1 | ~3 min | ~3 min |

**Recent Trend:**
- Last 5 plans: 01-01 (3 min)
- Trend: Baseline established

*Updated after each plan completion*

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

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 2 (Lightning): LND payment state machine edge cases under load warrant targeted research before planning — specifically TrackPaymentV2, ListPayments retry semantics, and HTLC slot exhaustion
- Phase 3 (Cashu): Nutshell PENDING lock correctness must be verified via source inspection before Phase 3 begins; cashu-ts 3.5.x / Nutshell 0.19.x NUT compatibility should be confirmed with a minimal integration test

## Session Continuity

Last session: 2026-02-26
Stopped at: Completed 01-01-PLAN.md — foundation scaffolding complete, ready for 01-02
Resume file: None
