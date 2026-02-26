# Stack Research

**Domain:** Agent Treasury Service — centralized payment/custody service for AI agents with Lightning Network and Cashu ecash rails
**Researched:** 2026-02-26
**Confidence:** MEDIUM-HIGH (core framework HIGH; Lightning/Cashu integration MEDIUM due to fast-moving ecosystem)

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 24.x LTS ("Krypton") | Runtime | Current Active LTS through Apr 2028; OpenSSL 3.5 with stricter crypto defaults (no keys <2048-bit RSA) — important for payment security. Fastify 5 requires >=20. |
| TypeScript | 5.x (5.7+) | Language | De facto standard for Node.js payment services; strict mode eliminates entire classes of money-handling bugs. Fastify, Drizzle, Zod all offer first-class TS generics. |
| Fastify | 5.7.x | HTTP API framework | Built-in JSON schema validation, first-class TypeScript generics, 3x faster than Express. Critical for a payment API where data integrity matters. Fastify v5 targets Node 20+. |
| Drizzle ORM | 0.45.x | Database access | SQL-like TypeScript API, ~7.4kb bundle, no binary dependency (Prisma's Rust engine is gone in v7 but Drizzle was always lighter). Fintech recommendation: you write real SQL predicates, not ORM magic. |
| PostgreSQL | 16.x | Primary datastore | ACID transactions required for ledger operations. Row-level locking for atomic balance updates. Trigger-enforced append-only audit table is idiomatic PostgreSQL. |
| Zod | 4.3.x | Request/response validation | 14x faster string parsing than Zod 3. Fastify accepts Zod schemas via `@fastify/type-provider-zod`. Single source of truth: Zod schema → TypeScript type → runtime validation. |

### Lightning Network Layer

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| `lightning` (npm) | latest | LND gRPC client (TypeScript-first) | Explicit recommendation from ln-service docs for TypeScript projects. 200+ LND methods as typed async functions. Handles cert/macaroon auth. |
| LND | 0.20.x | Lightning node daemon | Most mature implementation; largest ecosystem of tools; REST + gRPC APIs; remote-signer architecture keeps keys isolated from Treasury Service. |

**LND vs CLN decision:** Use LND. Reason: `lightning` npm package is the standard TypeScript binding for LND. CLN has a plugin system but lacks polished TypeScript tooling. For a custody service, LND's payment reliability focus (shortest path, highest success rate) matters more than CLN's privacy routing. LND's baked-macaroon system for least-privilege access (pay-only, invoice-only, read-only) is a direct fit for agent policy scoping.

### Cashu Layer

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| `@cashu/cashu-ts` | 3.5.x | Cashu wallet client (TypeScript) | Official cashu-ts library, maintained by cashubtc org. 90% test coverage. Wraps the NUT protocol (mint, melt, swap tokens). Stateless — your service manages state in PostgreSQL. |
| Nutshell mint | 0.19.x | Self-hosted Cashu mint | Reference implementation (Python/FastAPI), runs in Docker on port 3338. Exposes standard NUT REST API. Treasury communicates with it over HTTP. |

**Nutshell vs CDK-Rust decision:** Use Nutshell. CDK (Rust) is explicitly marked "early development, API will change." Nutshell is stable (0.19.2), has PostgreSQL backend support, and Docker images. Run it as a sidecar container; communicate via NUT REST endpoints.

**Cashu integration pattern:** Treasury Service acts as the *wallet client* talking to a separate Nutshell mint container. Do not embed the mint in the Treasury process. This matches the PROJECT.md constraint: "Lightning node and Cashu mint run on separate hosts/containers."

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pino` | 10.3.x | Structured JSON logging | Every service log call. Machine-readable JSON; pipes to Loki/ELK. 10x faster than Winston. Financial audit trail needs structured fields (agent_id, amount_sat, policy_decision). |
| `pino-http` | latest | HTTP request logging | Fastify plugin for automatic request/response logs with timing. |
| `pino-pretty` | latest | Dev-time log formatting | Dev only (never in production — adds overhead). |
| `@fastify/type-provider-zod` | latest | Zod + Fastify bridge | Lets Fastify infer TypeScript types from Zod schemas. Eliminates double-declaring request types. |
| `@fastify/jwt` | latest | JWT middleware | For future auth upgrades. V1 uses static tokens but JWT middleware also handles Bearer token extraction cleanly. |
| `drizzle-kit` | latest | Migrations CLI | `drizzle-kit generate` + `drizzle-kit migrate` — schema-as-code, SQL diffs checked into git. |
| `dotenv` / `@dotenvx/dotenvx` | latest | Environment config | Secrets (LND macaroon, Cashu mint key) via env vars with strict validation at startup via Zod. |
| `lsat-js` | latest | L402/LSAT macaroon utilities | When Treasury needs to *pay* L402-gated APIs on behalf of agents. Not needed for v1 (simulated spends). |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| Vitest | 4.0.x | Unit + integration testing | Current standard for TypeScript projects. 4.0 is stable. Jest-compatible API. Built-in coverage via v8. |
| `tsx` | latest | TypeScript execution in dev | Runs `.ts` files directly without compile step; faster DX than `ts-node`. |
| `drizzle-kit studio` | latest | Visual DB browser | Dev-time introspection of ledger tables. |
| Docker Compose | - | Local service orchestration | Run Treasury + PostgreSQL + LND (regtest) + Nutshell mint all locally. |
| `bitcoin-core` (regtest) | - | Local Bitcoin node for testing | Required to run LND in regtest mode for payment testing without real funds. |

---

## Installation

```bash
# Core service
npm install fastify @fastify/type-provider-zod zod pino pino-http

# Database
npm install drizzle-orm postgres

# Lightning (LND client)
npm install lightning

# Cashu wallet client
npm install @cashu/cashu-ts

# Auth & config
npm install @fastify/jwt dotenv

# Dev dependencies
npm install -D typescript vitest tsx drizzle-kit @types/node pino-pretty
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| LND + `lightning` npm | Core Lightning + `c-lightning-rest` | If you need CLN's plugin extensibility or BOLT12 offers natively (CLN has earlier BOLT12 support). Not recommended for TypeScript teams — CLN tooling is weaker. |
| Nutshell mint (Python/Docker) | CDK Rust mint | When CDK reaches 1.0 stability. CDK has better Rust performance and native mobile bindings, but "early development, API will change" is disqualifying for production custody. |
| Drizzle ORM | Prisma | If your team is unfamiliar with SQL and prefers schema-first DX. Prisma v7 removed the Rust engine so the bundle size gap narrowed, but Drizzle's SQL-literal control still wins for ledger work. |
| Fastify | Express | Only if you have existing Express middleware you can't replace. Express TypeScript support is retrofitted; Fastify's generics give real type safety on routes. |
| Fastify | Hono | Hono is excellent for edge/serverless. This service runs on a single server/container, so Fastify's maturity and plugin ecosystem win. |
| PostgreSQL | SQLite | SQLite is fine for Milestone 1 (simulated spends) if you want zero infra. Switch to PostgreSQL before real payments — row-level locking and WAL are not optional for concurrent agent balance updates. |
| Zod v4 | Zod v3 | Zod v3 if you have existing v3 codebase. New projects: always start with v4 (14x faster parsing, 57% smaller bundle). |
| Pino | Winston | Winston has more transports but 10x slower. Never use Winston for financial services where log volume is high. |
| Vitest | Jest | Jest if you need React component testing (not applicable here). Vitest 4.0 has stable browser mode now but pure Node.js API testing is Vitest's strongest use case. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| LNbits as Lightning backend | LNbits is an accounting layer on top of a node — it adds indirection and a dependency. You want direct LND gRPC control for a custody service. | LND directly via `lightning` npm |
| Alby Hub as Lightning backend | Alby Hub is a self-custodial wallet product, not an embeddable service library. It's designed for end-user wallet management, not programmatic agent treasury APIs. | LND directly |
| `ln-service` (older package) | `ln-service` is the JavaScript predecessor to `lightning`. The `lightning` npm package is the TypeScript-ready evolution — the ln-service README explicitly redirects TypeScript users to `lightning`. | `lightning` npm package |
| General-purpose rules engines (Trool, node-rules, GoRules) | External rules engines add complexity and a learning curve for a policy system that is fundamentally "per-agent static limits checked before each spend." Hand-written TypeScript policy evaluators are simpler, more auditable, and easier to unit test. | Custom TypeScript policy module with typed policy config per agent |
| Redis for session/state | No user sessions exist. Static token auth does not require Redis. Don't add Redis until you have a concrete need (e.g., rate limiting at high scale). | PostgreSQL for all persistent state |
| ORMs that hide SQL (Sequelize, TypeORM) | TypeORM and Sequelize use decorators and magic that obscure what SQL runs. For a financial ledger, you need to know exactly what queries execute and in what isolation level. | Drizzle ORM — explicit, SQL-like |
| Cashu CDK (Rust) as mint | Explicitly "early development, API will change" per maintainers. Cannot commit to this for production custody. | Nutshell 0.19.x in Docker |
| TypeScript `any` in payment paths | Type erasure in payment handling is how you get wrong amounts, wrong units, or undetected null values. | Strict TypeScript with Zod validation at all I/O boundaries |

---

## Stack Patterns by Variant

**For Milestone 1 (simulated spends, no real LN/Cashu):**
- Use SQLite via Drizzle instead of PostgreSQL to reduce local dev setup
- Mock the `lightning` and `@cashu/cashu-ts` clients with Vitest mocks
- Swap to PostgreSQL before Milestone 2 (real Lightning)
- Because: validates the full API contract and policy engine before any real funds are at risk

**For production Lightning payments (Milestone 2+):**
- LND in Docker with baked macaroons scoped to: `invoices:read invoices:write offchain:read offchain:write`
- Never use admin.macaroon in Treasury Service — bake a payment-only macaroon
- Connect via gRPC over TLS; mount macaroon from a secrets volume
- Because: least-privilege access is the #1 Lightning security principle

**For Cashu hot wallet:**
- Nutshell mint in separate container with PostgreSQL backend
- Treasury uses `@cashu/cashu-ts` Wallet class to mint (deposit via LN invoice), melt (withdraw via LN), and swap tokens
- Keep Cashu balance small (hot wallet limit) — large amounts stay on LN channel
- Because: Cashu tokens are bearer instruments; loss of private key = loss of funds

**For policy engine:**
- Implement as a pure TypeScript module (no external library)
- Policy config stored in PostgreSQL per agent; evaluated synchronously before every spend
- Pattern: `evaluatePolicy(agentId, spendRequest): PolicyDecision` returns `{allowed: boolean, reason: string}`
- Fail closed: any thrown error → DENY + log
- Because: a custom evaluator is 50 lines of TypeScript that is trivially unit-tested; a rules engine adds 200+ lines of config and a deployment dependency

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| Fastify 5.7.x | Node.js 20+ required | Do not use Node 18 with Fastify v5 |
| Drizzle ORM 0.45.x | PostgreSQL 14+ | Uses IDENTITY columns (PostgreSQL 10+ feature); Drizzle Kit migrations work with pg 14+ |
| `@cashu/cashu-ts` 3.5.x | Nutshell mint 0.19.x | Both follow Cashu NUT spec; cashu-ts 3.x aligned with current NUT-04/05/06 mandatory specs |
| `lightning` npm | LND 0.14.4-beta through 0.20.1-beta | Verify macaroon permissions match LND version; bakery API stable across these versions |
| Zod 4.x | `@fastify/type-provider-zod` latest | Check `@fastify/type-provider-zod` peer dep — ensure it specifies Zod 4 compatibility before installing |
| Vitest 4.x | Node.js 18+ | Vitest 4.0 supports Node 18+; no issue with Node 24 LTS |

---

## Sources

- [cashu-ts GitHub](https://github.com/cashubtc/cashu-ts) — version 3.5.0, confirmed Feb 18 2026 release (HIGH confidence — official repo)
- [Nutshell GitHub](https://github.com/cashubtc/nutshell) — version 0.19.2, confirmed Feb 19 2026 release (HIGH confidence — official repo)
- [ln-service GitHub](https://github.com/alexbosworth/ln-service) — explicitly redirects TypeScript users to `lightning` npm (HIGH confidence — official docs)
- [Lightning Labs Agent Tools blog post](https://lightning.engineering/posts/2026-02-11-ln-agent-tools/) — LND remote signer, macaroon scoping patterns (HIGH confidence — official)
- [Lightning Agent Tools GitHub](https://github.com/lightninglabs/lightning-agent-tools) — confirms Go + Docker architecture; confirms lnget/aperture L402 pattern (HIGH confidence — official)
- [Cashu NUT Specifications](https://cashubtc.github.io/nuts/) — mandatory NUT-03/04/05 for swap/mint/melt (HIGH confidence — official protocol spec)
- [LND v0.20 announcement](https://lightning.engineering/posts/2025-6-3-lnd-0.19-launch/) — v0.19/0.20 confirmed stable (MEDIUM confidence — official but links to 0.19 announcement)
- [Fastify npm](https://www.npmjs.com/package/fastify) — v5.7.4 current stable, Node 20+ required (HIGH confidence — npm registry)
- [Drizzle ORM npm](https://www.npmjs.com/package/drizzle-orm) — v0.45.1 current (MEDIUM confidence — WebSearch confirmed, npm registry)
- [Zod v4 InfoQ announcement](https://www.infoq.com/news/2025/08/zod-v4-available/) — v4 stable, 14x performance improvement (MEDIUM confidence — verified trade press)
- [Pino npm](https://www.npmjs.com/package/pino) — v10.3.1 current (HIGH confidence — npm registry)
- [Vitest 4.0 release](https://vitest.dev/blog/vitest-4) — v4.0.18 stable, browser mode graduated (HIGH confidence — official)
- [Node.js releases](https://nodejs.org/en/about/previous-releases) — Node 24 LTS ("Krypton"), active LTS through Apr 2028 (HIGH confidence — official)
- [Bytebase Drizzle vs Prisma 2026](https://www.bytebase.com/blog/drizzle-vs-prisma/) — Drizzle fintech recommendation, SQL control advantage (MEDIUM confidence — verified comparison article)
- [Cashu CDK GitHub](https://github.com/cashubtc/cdk) — "early development, API will change" warning; v0.12/v0.13 released in Q3 2025 (HIGH confidence — official repo warning)

---

*Stack research for: Agent Treasury Service (Vaultwarden) — Lightning/Cashu payment custody for AI agents*
*Researched: 2026-02-26*
