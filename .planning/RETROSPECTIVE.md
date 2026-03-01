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

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | ~6 | 4 | Established baseline — gap closure workflow validated |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.0 | 113 | — | 0 (all deps from initial scaffold) |

### Top Lessons (Verified Across Milestones)

1. (Pending — first milestone, no cross-validation yet)
