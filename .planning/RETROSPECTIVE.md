# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP

**Shipped:** 2026-02-28
**Phases:** 4 | **Plans:** 15 | **Sessions:** ~6

### What Was Built
- Complete agent treasury system with registration, auth, sub-accounts, and policy engine
- Lightning payment backend via LND with correct state machine and crash recovery
- Cashu hot wallet backend via self-hosted Nutshell with automatic rail routing
- Operator control plane: human approval, versioned policies, balance alerts, dashboard
- 113 passing tests, 9,617 LOC TypeScript

### What Worked
- Phase dependency ordering (ledger → simulated → Lightning → Cashu → operator) meant each phase had stable foundations
- buildApp() factory with injected DB gave clean test isolation from day one — never had to refactor for testability
- RESERVE/RELEASE/PAYMENT ledger pattern proved robust across all three wallet backends (simulated, Lightning, Cashu)
- Gap closure workflow caught the approval execution gap and fixed it in a focused 1-plan cycle
- Wave-based execution allowed clear handoff boundaries between dependent work

### What Was Inefficient
- Phase 4 approval route shipped without wallet execution (the gap) — the planner described the complexity but the executor chose a simpler "status only" approach. The verifier caught it, but the round-trip cost an extra plan
- ROADMAP.md plan checkboxes and counts fell out of sync during Phase 4 execution — manual fixup needed at milestone completion
- Some traceability table entries stayed "Pending" despite requirements being implemented — needed manual correction
- Summary files lacked one_liner fields, making automated accomplishment extraction fail

### Patterns Established
- RESERVE before async wallet call, RELEASE on failure, PAYMENT on success — universal ledger pattern
- createPaymentsService(wallet) factory for wallet injection — no module mocking in tests
- agentAuth hook with request.server.db — routes never import DB directly
- Fire-and-forget webhook with HMAC-SHA256 and exponential backoff — used by approvals, alerts, withdrawals
- CAS (compare-and-swap) pattern for concurrent state transitions (approval resolution)

### Key Lessons
1. Executors may simplify away critical behavior when implementation is complex — verifier step is essential, not optional
2. Traceability status tracking should be automated, not left to executors to update manually
3. SUMMARY.md template compliance varies — enforcing one_liner field would improve milestone tooling
4. Point-in-time policy evaluation must capture timestamp before the first transaction, not after — subtle but critical for correctness

### Cost Observations
- Model mix: ~10% opus (orchestration), ~90% sonnet (research, planning, execution, verification)
- Sessions: ~6 across 4 days
- Notable: Phase 1 (5 plans) took longest wall-clock; Phases 2-4 (3-4 plans each) were faster as patterns stabilized

---

## Milestone: v1.1 — Internal Billing API

**Shipped:** 2026-04-03
**Phases:** 2 | **Plans:** 4 | **Sessions:** 1

### What Was Built
- POST /internal/reserve — hold funds against agent balance before LLM call
- POST /internal/settle — partial settlement via atomic RELEASE+PAYMENT+audit in single transaction
- POST /internal/release — cancel reservation and restore balance
- Internal auth middleware (constant-time X-Internal-Token comparison)
- Idempotent settle and release via RELEASE existence check
- 22 new integration tests + 9 unit tests; 266 total passing (up from 113)

### What Worked
- User provided exact spec with route contracts, error codes, and ledger entry patterns — eliminated ambiguity in discuss-phase
- All building blocks existed from v1.0 (ledgerRepo, agentAuth pattern, auditRepo) — Phase 5-6 was pure assembly
- Worktree isolation kept agents from stepping on each other's commits
- Skip-research decision saved time — codebase was well-understood, no new libraries needed
- Two-wave structure (auth+reserve → settle+release → tests) created clean dependency boundaries

### What Was Inefficient
- Worktree agent for 06-02 committed to its branch but the docs commit landed on main separately — required cherry-pick to reconcile test file
- First verification of Phase 6 flagged tests as missing from main (correct, but caused by worktree/main branch confusion)
- Pre-existing Drizzle DB type widening issue (`DB` vs `Db`) surfaced as TS errors in new routes — harmless at runtime but noisy

### Patterns Established
- Internal service auth via X-Internal-Token header with optional config — routes only register when token is set
- Partial settlement pattern: RELEASE (full credit) + PAYMENT (actual debit) in atomic transaction
- Idempotency guard: check for RELEASE entry with matching ref_id before inserting
- Settle metadata stored in audit log (not ledger) — keeps ledger table schema clean

### Key Lessons
1. When executor agents commit to worktree branches, always verify the commits landed on main before running verification
2. Precise user specs dramatically reduce discuss→plan→execute cycle time — this milestone shipped in a single session
3. The RESERVE/RELEASE/PAYMENT pattern from v1.0 proved extensible to billing without any ledger schema changes
4. Optional config entries (`.optional()` in Zod) are the right pattern for features that shouldn't break existing deployments

### Cost Observations
- Model mix: ~15% opus (planning), ~85% sonnet (execution, verification)
- Sessions: 1 (entire milestone in single session)
- Notable: 4 plans in ~3 hours wall-clock — significantly faster than v1.0 as patterns were established

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | ~6 | 4 | Established baseline — gap closure workflow validated |
| v1.1 | 1 | 2 | Precise spec + established patterns = single-session milestone |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.0 | 113 | — | 0 (all deps from initial scaffold) |
| v1.1 | 266 | — | 0 (no new dependencies) |

### Top Lessons (Verified Across Milestones)

1. RESERVE/RELEASE/PAYMENT ledger pattern is extensible — worked for wallet payments (v1.0) and billing (v1.1) without schema changes
2. Verifier step catches real gaps (v1.0: approval execution gap, v1.1: missing test merge) — essential, not optional
3. Precise user specs reduce cycle time dramatically — v1.0 took ~6 sessions, v1.1 shipped in 1
