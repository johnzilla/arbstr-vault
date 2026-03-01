# Milestones

## v1.0 MVP (Shipped: 2026-02-28)

**Phases completed:** 4 phases, 15 plans, ~30 tasks
**Timeline:** 4 days (2026-02-24 → 2026-02-28)
**Codebase:** 9,617 LOC TypeScript, 70 commits, 120 files

**Key accomplishments:**
- Agent management with registration, bearer auth, sub-accounts, and policy engine with fail-closed DENY defaults
- Lightning payment backend via LND with BOLT11 execution, correct state machine, crash recovery, and macaroon scope verification
- Cashu hot wallet backend via self-hosted Nutshell mint with automatic Lightning/Cashu rail routing based on amount and destination
- Operator control plane with human approval workflow, versioned policies (point-in-time evaluation), balance alerts, and full dashboard
- Append-only audit log written atomically with every ledger update, filterable by agent/action/time
- 113 passing tests across unit and integration suites with zero regressions

---

