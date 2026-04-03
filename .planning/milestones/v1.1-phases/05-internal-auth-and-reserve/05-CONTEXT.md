# Phase 5: Internal Auth and Reserve - Context

**Gathered:** 2026-04-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Arbstr core can authenticate as an internal service and reserve funds against an agent's balance before an LLM call. Delivers: internal auth middleware (`X-Internal-Token`), `POST /internal/reserve` route, and env config for `VAULT_INTERNAL_TOKEN`. Settle and release are Phase 6.

</domain>

<decisions>
## Implementation Decisions

### Auth Middleware
- **D-01:** Constant-time comparison (timingSafeEqual) for `X-Internal-Token` header, same pattern as `adminAuth.ts`
- **D-02:** `VAULT_INTERNAL_TOKEN` is optional in config schema — internal routes only register when set
- **D-03:** Minimum 32 characters for `VAULT_INTERNAL_TOKEN`, matching `VAULTWARDEN_ADMIN_TOKEN` constraint
- **D-04:** New file: `src/middleware/internalAuth.ts` — validates `X-Internal-Token` header against env var

### Request Schema
- **D-05:** All reserve body fields required: `agent_token` (string), `amount_msats` (positive integer), `correlation_id` (string), `model` (string)
- **D-06:** `amount_msats` validated as `z.number().int().positive()` — no zero or negative reserves

### Error Responses
- **D-07:** 402 response includes balance info: `{error: {code, message}, current_balance_msats, requested_msats}`
- **D-08:** Success response includes remaining balance: `{reservation_id, remaining_balance_msats}`
- **D-09:** Reuse existing error shape `{error: {code, message}}` for 401/403/500

### Policy Check
- **D-10:** Skip policy checks for v1.1 — balance check is sufficient for trusted internal caller. Policy enforcement on billing reserves is a future consideration.

### Claude's Discretion
- Exact Zod schema structure for request/response types
- Where to place shared types (inline vs extracted)
- Conditional route registration pattern when `VAULT_INTERNAL_TOKEN` is unset

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Auth pattern
- `src/middleware/adminAuth.ts` — Reference implementation for constant-time token comparison
- `src/middleware/agentAuth.ts` — Agent token resolution via hashToken + findByTokenHash

### Ledger operations
- `src/modules/ledger/ledger.repo.ts` — `insert()` for RESERVE entry, `getBalance()` for balance check
- `src/types.ts` — `generateTransactionId()` for tx_id generation

### Token handling
- `src/modules/tokens/tokens.service.ts` — `hashToken()` for agent_token resolution
- `src/modules/agents/agents.repo.ts` — `findByTokenHash()` for agent lookup

### Config and registration
- `src/config.ts` — Zod config schema, add `VAULT_INTERNAL_TOKEN` here
- `src/app.ts` — Route registration pattern, Fastify plugin registration

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `adminAuth.ts`: Near-identical pattern for internalAuth — constant-time compare against env var
- `ledgerRepo.insert()`: Direct reuse for RESERVE entry insertion
- `ledgerRepo.getBalance()`: Direct reuse for balance check
- `hashToken()` + `agentsRepo.findByTokenHash()`: Direct reuse for agent token resolution
- `generateTransactionId()`: Direct reuse for reservation_id generation

### Established Patterns
- Fastify plugin pattern: routes export an `async function(app)` registered via `app.register()`
- Auth as `onRequest` hook: middleware returns 401 via `reply.status(401).send()`
- Zod validation: `fastify-type-provider-zod` with `validatorCompiler`/`serializerCompiler`
- DB access: `request.server.db` decorator injected by `buildApp()`
- Error shape: `{error: {code: string, message: string}}`

### Integration Points
- `src/app.ts`: Register `internalBillingRoutes` alongside existing admin/agent routes
- `src/config.ts`: Add `VAULT_INTERNAL_TOKEN` to Zod schema (optional, min 32 chars)
- `.env.example`: Add `VAULT_INTERNAL_TOKEN` documentation

</code_context>

<specifics>
## Specific Ideas

- Internal auth is deliberately simpler than agent auth — no hash lookup, just string comparison
- Reserve uses `mode: 'simulated'` since no real wallet call happens (billing is a ledger-only operation)
- The `correlation_id` ties back to the arbstr request for end-to-end tracing
- Route prefix is `/internal/*` to clearly separate from `/admin/*` and `/agent/*` namespaces

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 05-internal-auth-and-reserve*
*Context gathered: 2026-04-02*
