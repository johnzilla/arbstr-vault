# Phase 3: Cashu Backend - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Add Cashu (ecash) as a second payment rail alongside Lightning via a self-hosted Nutshell mint. The Treasury automatically routes payments between Lightning and Cashu based on amount thresholds, with optional agent hints and automatic fallback. Agents interact through the existing payment API with a new `BTC_cashu` asset type. Operator experience and advanced policy are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Payment Routing Logic
- Amount-threshold routing: payments under 1,000 sats (1,000,000 msat) route to Cashu, at or above route to Lightning
- Default threshold is 1,000 sats — configurable in global config
- Agent can pass an optional `preferred_rail` hint (`'lightning'` | `'cashu'`) to override automatic routing; Treasury respects the hint if the rail supports the destination
- If the chosen/routed rail fails, Treasury automatically falls back to the other rail; fallback is logged in audit with `initial_rail`, `final_rail`, `fallback_occurred` fields
- Routing decision is recorded in the audit log entry for every payment

### Cashu Token Lifecycle
- Treasury connects to an external Nutshell mint via its REST API (not embedded) — operator deploys Nutshell alongside Treasury (e.g., Docker Compose)
- Mint liquidity comes from Lightning: Treasury mints Cashu tokens by paying Lightning invoices to the Nutshell mint
- Treasury is the custodian — it holds ecash proofs in its DB and tracks balances per agent in the ledger; agents never touch raw tokens
- Melt flow: Treasury melts tokens directly to pay the target amount; Nutshell handles change via its split/swap mechanics internally
- Keyset rotation: when the mint signals a keyset change, Treasury automatically swaps old proofs for new ones; swap logged in audit

### Agent API Surface
- New asset type `BTC_cashu` alongside `BTC_simulated` and `BTC_lightning`
- Payment response includes: `rail_used` (`'cashu'` | `'lightning'`), `cashu_token_id` (proof reference, present for Cashu payments), `fee_msat`
- Deposits work the same as today — operator deposits to agent's ledger balance; Treasury internally mints Cashu tokens from the pool when Cashu payments are needed
- Payment status endpoint shows routing trace: `initial_rail`, `final_rail`, `fallback_occurred`

### Concurrency & Double-Spend Prevention
- PENDING lock in DB keyed by proof secret before submitting proofs to mint; second concurrent request sees the lock and is rejected immediately; lock released on settle or fail
- Mirrors the Lightning RESERVE pattern from Phase 2
- Global lock scope (not per-agent) — proof secrets are unique regardless of agent
- Crash recovery: on startup, find all PENDING Cashu operations and query the Nutshell mint for their actual status; settle or release accordingly (mirrors Lightning crash recovery)

### Claude's Discretion
- Nutshell REST API client implementation details
- Proof storage schema design
- Exact fallback retry logic and timeouts
- Config schema for routing threshold

</decisions>

<specifics>
## Specific Ideas

- Routing trace in status endpoint mirrors the existing `payment_hash` + `fee_msat` pattern from Lightning — consistent field naming across rails
- PENDING lock pattern should reuse the RESERVE/RELEASE ledger model from Phase 2 where possible
- Crash recovery should follow the same startup-check pattern as `initializeLightningBackend` from Phase 2

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-cashu-backend*
*Context gathered: 2026-02-26*
