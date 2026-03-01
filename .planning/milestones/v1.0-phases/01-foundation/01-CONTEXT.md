# Phase 1: Foundation - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Data model, auth, policy engine, audit log, and simulated wallet — the entire API contract with no real funds. Operators can register agents, configure per-agent policies, and simulate the full payment lifecycle end-to-end. Lightning and Cashu backends are separate phases; this phase delivers the interface they will plug into.

</domain>

<decisions>
## Implementation Decisions

### Technology stack
- TypeScript (Node.js 24.x LTS) + Fastify 5.7.x — as specified in STACK.md
- SQLite via Drizzle ORM for Phase 1 (PostgreSQL deferred to Phase 2+)
- Zod v4 for all request/response validation
- Pino for structured JSON logging
- Vitest for unit + integration testing
- **Guiding principle: use best available SDKs and libraries from dependencies. No DIY rewrites or heavy customization — lean into ecosystem support.**

### API shape and conventions
- Flat response format — success returns top-level fields, errors return `{"error": {"code": "...", "message": "...", "details": {...}}}`
- Cursor-based pagination on all list endpoints — `?cursor=xxx&limit=50`, response includes `next_cursor` and `has_more`
- Prefixed ULIDs for all identifiers — `ag_` for agents, `tx_` for transactions, `pl_` for policies, `vtk_` for tokens
- All monetary amounts in millisatoshis as integers — `amount_msat`, `balance_msat`, `daily_limit_msat`

### Authentication model
- Single static admin token for operator (set via env var `VAULTWARDEN_ADMIN_TOKEN`) — all management endpoints require it
- Per-agent static bearer tokens generated at registration — agents authenticate with `Authorization: Bearer vtk_...`
- Two auth scopes: operator (admin) and agent (own sub-account only)

### Policy configuration
- API-only policy management — `PUT /agents/{id}/policy` with JSON body
- Deny-all default policy on agent registration — new agents cannot spend until operator explicitly sets a policy
- Rolling 24h window for daily spend limits — no midnight reset edge, smooth and predictable
- Fail-closed: any policy engine error produces DENY, never ALLOW

### Simulated payment behavior
- Deterministic success — sim always succeeds if policy allows. No randomized failures in Phase 1.
- Transparent mode — responses include `"mode": "simulated"` field. When Lightning is live, it will say `"mode": "lightning"`.
- Operator-funded deposits — `POST /agents/{id}/deposit` with `amount_msat`. Real balance tracking, just no real money.
- Full payment state machine — PENDING -> SETTLED or FAILED. Same states Lightning will use. Sim transitions instantly but goes through the same FSM.

### Claude's Discretion
- URL path structure and resource naming conventions
- Exact Drizzle schema design and migration strategy
- Error code taxonomy (specific error codes within the error envelope)
- Testing strategy (unit vs integration test boundaries)
- Project directory structure (adapting ARCHITECTURE.md's `.rs` structure to TypeScript modules)
- Exact structured logging field names and formats

</decisions>

<specifics>
## Specific Ideas

- Amounts in millisatoshis (not satoshis) because that's Lightning-native precision — avoids conversion at the LND boundary in Phase 2
- Prefixed ULIDs make logs scannable: "Policy pl_01HY9 denied tx_01HY1 for agent ag_01HX"
- The deposit endpoint in sim mode establishes the funding pattern that real inbound Lightning payments will use later
- STACK.md recommends `@fastify/type-provider-zod` as single source of truth: Zod schema -> TypeScript type -> runtime validation

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-02-26*
