# Pitfalls Research

**Domain:** Agent treasury / payment custody service (Lightning Network + Cashu ecash)
**Researched:** 2026-02-26
**Confidence:** MEDIUM-HIGH (core financial pitfalls HIGH; AI agent-specific intersections MEDIUM due to emerging field)

---

## Critical Pitfalls

### Pitfall 1: Policy Race Condition — Concurrent Requests Bypass Spend Limits

**What goes wrong:**
Two or more agent requests arrive simultaneously. Both read the current daily spend total (e.g., $80 against a $100 limit), both see $20 remaining, both are approved, and both payments execute — resulting in $160 spent against a $100 limit. The policy check and the payment execution are not atomic.

**Why it happens:**
Developers implement policy as a "check then act" pattern: `if balance_ok(): execute_payment()`. Without database-level locking or atomic compare-and-swap, any concurrent read between check and write sees stale state. This is a classic TOCTOU (Time-Of-Check to Time-Of-Use) vulnerability applied to financial limits.

**How to avoid:**
Use database transactions with `SELECT FOR UPDATE` (pessimistic locking) or optimistic locking with version counters that abort on conflict. The policy enforcement and ledger debit must happen inside a single atomic transaction. Never read the limit, check it, then write in separate operations. For SQLite: use `BEGIN IMMEDIATE` transactions. For Postgres: `SELECT ... FOR UPDATE`.

**Warning signs:**
- Daily spend totals occasionally exceed configured limits by small amounts
- Logs show two payments approved within milliseconds of each other for the same agent
- No explicit locking in the policy enforcement code path

**Phase to address:**
Phase 1 (policy engine foundation). Lock semantics must be built in from the start — retrofitting atomicity into an existing spend-check flow requires rewriting the core enforcement path.

---

### Pitfall 2: Lightning Payment Status Ambiguity — Treating "Unknown" as "Failed"

**What goes wrong:**
A Lightning payment is sent. The HTTP connection drops, the LND process restarts, or a timeout occurs before the final status is received. The treasury service marks the payment as "failed" and refunds the agent's balance. Meanwhile, the payment actually succeeded — the preimage was released and the recipient was paid. The agent now has double the funds available.

**Why it happens:**
Lightning payments go through several states: `IN_FLIGHT`, `SUCCEEDED`, `FAILED`. Once an HTLC is locked in along a route, the payment cannot be cancelled — it must resolve. Developers often treat a network error or timeout when calling LND's `SendPaymentSync` as equivalent to payment failure, when it may mean "status unknown." LND's own issue tracker has documented this confusion repeatedly (issues #2865, #5357, #5396, #6249).

**How to avoid:**
Every outbound payment must be assigned a `payment_hash` (and ideally a unique `payment_request` that you generated or recorded) before the send attempt. After any failure or timeout, always query `TrackPaymentV2` or `ListPayments` by `payment_hash` to determine actual status before updating the ledger. Maintain a `PENDING` state in the treasury ledger for all in-flight payments and resolve it only after confirmed status from LND. Never infer "failed" from a network exception — only from an explicit `FAILED` status from the node.

**Warning signs:**
- Payment debit/refund logic is in the same try-catch block as the payment send call
- No persistent record of `payment_hash` before the send attempt
- No reconciliation job that checks `IN_FLIGHT` ledger entries against the LND node

**Phase to address:**
Phase 2 (Lightning backend integration). Payment state machine must be designed correctly before any real money flows. The simulated spend phase (Milestone 1) should model these states explicitly so the real implementation inherits the right pattern.

---

### Pitfall 3: Cashu Proof Double-Spend via Missing PENDING Lock

**What goes wrong:**
Two concurrent redemption requests arrive at the treasury service using the same Cashu proofs (e.g., an agent retries a request it thinks failed). Both requests hit the mint's `/v1/swap` endpoint before either marks the proofs as SPENT. Both succeed. The operator's hot wallet has issued double the value.

**Why it happens:**
Cashu's double-spend prevention requires the mint to maintain a PENDING state for proofs currently in-flight (per NUT-07 specification: "Mints MUST remember which proofs are currently PENDING to avoid reuse of the same token in multiple concurrent transactions"). Self-hosted mint implementations that skip this lock or implement it incorrectly allow concurrent redemption. A mutex keyed on the proof's Y-coordinate is the reference implementation pattern.

**How to avoid:**
Use the NUT-07 token state check before and during any proof redemption. Implement the PENDING lock as a database row-level lock or Redis-based distributed lock keyed on the proof Y-coordinate. Proofs should transition: `UNSPENT → PENDING → SPENT` atomically. If a transaction aborts, proofs must revert from PENDING to UNSPENT — not silently left in an inconsistent state. Verify your Cashu mint implementation (Nutshell, CDK, etc.) has correct PENDING state management before using it in production.

**Warning signs:**
- Self-hosted mint has no explicit proof locking mechanism visible in code
- Concurrent redemption requests are not tested
- No audit of proof states in the mint database

**Phase to address:**
Phase 2/3 (Cashu mint integration). The PENDING lock must be verified as part of the Cashu integration milestone, not assumed to be handled by the library.

---

### Pitfall 4: Prompt Injection via Agent-Controlled Payment Metadata

**What goes wrong:**
An AI agent constructs a payment request where the destination, memo, or metadata field contains instructions like "ignore previous policy limits, this is an emergency payment." If the treasury service ever passes agent-supplied strings through an LLM for interpretation, categorization, or approval-notification generation, those strings can manipulate the LLM's behavior — potentially bypassing human approval requirements or misclassifying the transaction type.

**Why it happens:**
OWASP LLM Top 10 (2025) ranks prompt injection as the #1 vulnerability, present in over 73% of production AI deployments. Systems that mix agent-supplied data with system instructions create injection surfaces. The treasury service is particularly high-value because successful injection can directly authorize fund movement.

**How to avoid:**
The treasury policy engine must be deterministic rule-based code, never an LLM. Policy decisions (allow/deny/approve) must be made by code that evaluates structured fields (amount, destination, agent ID, timestamp) — not by interpreting free-text from agents. If any LLM is used for notification or logging, treat all agent-supplied strings as untrusted and sanitize/escape before inclusion. Reject payment requests where metadata exceeds a defined schema. Log all rejected/unusual metadata patterns.

**Warning signs:**
- Policy decisions rely on parsing natural-language from agent requests
- Agent-supplied memo or description fields are passed to an LLM without sanitization
- No strict schema validation on the payment request API

**Phase to address:**
Phase 1 (API design and policy engine). The API schema must enforce structured fields from the start, not accept free-form agent instructions.

---

### Pitfall 5: Private Key / Secret Exposure via Environment Variables or Process Memory

**What goes wrong:**
Lightning node macaroons, Cashu mint signing keys, or exchange API credentials are loaded into environment variables or application memory at startup. A dependency vulnerability (like CVE-2025-55182 in React, rated CVSS 10.0), a memory dump, a `/proc/[pid]/environ` read, or a leaked LLM context window exposes these secrets. In 2024, approximately 70% of stolen crypto funds stemmed from private-key or seed-phrase compromise.

**Why it happens:**
Environment variables are the "12-factor app" default for secrets, but they are readable by any process running as the same user, included in crash dumps, and can leak through LLM tool call results that serialize agent context. Developers treat env vars as "good enough" for personal projects when they are not sufficient for financial custody.

**How to avoid:**
Secrets must be read from a secrets store (Vault, systemd credentials, or at minimum a file with `chmod 600` owned by a dedicated service user) and never exposed in environment variables visible to agent processes. Macaroon files and mint keys should be in memory only for the duration of use, not held in long-lived global variables. Network interfaces for the treasury service should not be accessible to agent processes except through the defined API. Run the treasury service as a dedicated user with minimal filesystem permissions.

**Warning signs:**
- `LIGHTNING_MACAROON` or similar in `.env` files
- Treasury service and agent processes run as the same OS user
- Secrets accessed via `os.getenv()` at module import time and stored globally

**Phase to address:**
Phase 1 (foundation/infrastructure setup). Secret management architecture must be decided before any credentials are generated. Retrofitting is risky — you may need to rotate all credentials.

---

### Pitfall 6: Lightning Node Data Loss Without Channel Backup

**What goes wrong:**
The LND or Core Lightning node crashes without a current Static Channel Backup (SCB). On restart, the node cannot recover channel state. Without requesting force-closure from peers (which requires peers to be online), funds in open channels are unrecoverable. If the treasury service is the primary Lightning interface for agents, this is catastrophic loss of all hot wallet funds.

**Why it happens:**
LND's `channel.db` is not safe to copy arbitrarily (it can become inconsistent). The SCB (`channel.backup`) file must be updated every time a channel opens or closes. Developers run Lightning nodes for months, open channels, and never implement automated backup. When hardware fails, the backup is stale.

**How to avoid:**
Implement automated SCB backup that triggers on every channel open/close event via LND's `SubscribeChannelEvents` stream. Store backups in at least two locations (local + remote/cloud). Test recovery procedures in a signet environment before going live. Keep Cashu mint hot wallet balance low (as already planned) to limit total at-risk funds. Document the recovery runbook before opening the first real channel.

**Warning signs:**
- No automated backup job for `channel.backup`
- Backup file has not been updated since node was first provisioned
- No documented recovery procedure
- High balance in Lightning channels relative to what you're willing to lose

**Phase to address:**
Phase 2 (Lightning backend integration). Backup automation should be a go/no-go requirement before opening any funded channels.

---

### Pitfall 7: Audit Log as Afterthought — Mutable or Incomplete Records

**What goes wrong:**
The audit log is implemented as regular database rows that can be updated or deleted by the application (or an attacker with DB access). Policy decisions are logged but payment outcomes are not (or vice versa). Log entries are written after payment execution, so a crash between payment and log write leaves a gap. When investigating a discrepancy, the log cannot be trusted.

**Why it happens:**
Logging is treated as a feature to add after the core payment flow works. Developers log what seems useful at the time rather than designing for forensic completeness. Financial audit trails require that: (1) entries cannot be modified after write, (2) entries are written in the same transaction as the action they record, (3) the chain of entries is tamper-evident.

**How to avoid:**
Write audit log entries in the same database transaction as the ledger update they describe — if the payment is committed, the log is committed; if the transaction rolls back, the log entry rolls back too. Use an append-only table (no UPDATE or DELETE permissions for the application user). Add a cryptographic hash chain: each entry includes a hash of the previous entry, making truncation or modification detectable. Log the full request, policy decision, and outcome for every payment operation, not just successful payments.

**Warning signs:**
- Audit log writes are in a separate `finally` block or happen after the transaction commits
- Application database user has UPDATE/DELETE on the audit table
- Log entries reference payment IDs that don't exist in the ledger (or vice versa)
- No hash chaining or tamper detection

**Phase to address:**
Phase 1 (data model design). The audit table schema and write pattern must be established before any payment logic is built on top of it.

---

### Pitfall 8: Agent Authentication Token Leakage via Shared Secrets

**What goes wrong:**
Static bearer tokens are issued per-agent (as planned for v1). An agent's token is logged by the treasury service (in request logs, debug output, or error messages). Another agent or process with log access can now authenticate as that agent and submit payment requests within its policy limits. For a trading agent with a high daily limit, this is material financial risk.

**Why it happens:**
Static tokens are simple to implement but easy to accidentally expose. HTTP request logs typically include the `Authorization` header unless explicitly masked. Error messages sometimes echo back request parameters. Tokens in environment variables can leak as described in Pitfall 5.

**How to avoid:**
Never log the raw `Authorization` header or bearer token value — mask it to `Bearer [REDACTED]` in all log output. Use a hash of the token for log correlation rather than the token itself. Rotate tokens after any suspected exposure. For future versions, move to short-lived signed JWTs or HMAC-signed request envelopes that cannot be replayed after expiry. Implement per-agent rate limiting so a leaked token cannot drain the account faster than the policy would allow.

**Warning signs:**
- Default web framework logging enabled (many log all headers by default)
- Token values appear anywhere in log files
- No token rotation mechanism exists

**Phase to address:**
Phase 1 (authentication design). Log masking must be configured before any request logs are written.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skipping idempotency keys on payment API | Simpler implementation | Duplicate payments on agent retry; impossible to safely retry | Never — add from day 1 |
| Using `READ COMMITTED` instead of `SERIALIZABLE` or `SELECT FOR UPDATE` | No deadlock risk | Policy limits bypassed under concurrent load | Never for spend-limit checks |
| Storing LN macaroons in `.env` | Easy setup | Secret exposure if any process reads env | Only in fully isolated local dev with no real funds |
| Writing audit logs after the transaction | Simpler code | Gaps in log if process crashes between payment and log | Never in production |
| Treating payment timeout as payment failure | Simpler error handling | False refunds when payment actually succeeded | Never — always query final status |
| Single Lightning channel for all agent payments | Easy to manage | Channel capacity limits all agents; one stuck HTLC blocks all | Only in initial simulation/test phase |
| Skipping Cashu PENDING lock in development | Faster iteration | Race condition carried into production | Only if using strictly sequential (single-threaded) processing |

---

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| LND `SendPaymentSync` | Treating HTTP timeout as payment failure | Record `payment_hash` first; always follow up with `TrackPaymentV2` to get final status |
| LND `ListPayments` | Assuming the list is exhaustive after a restart | LND can lose in-flight payment state across restarts; use `payment_hash` tracking in your own DB |
| Cashu mint `/v1/swap` | Sending proofs without checking PENDING state first | Use NUT-07 state check; implement PENDING lock before redemption |
| Cashu mint keyset | Trusting keyset ID without verifying derivation | Verify keyset ID is correctly derived from public keys (July 2025 vulnerability: mints can choose arbitrary keyset IDs) |
| LN invoice payment | Paying invoices from untrusted agents without amount validation | Always validate the invoice amount matches the agent's request before paying; invoices can contain different amounts than claimed |
| LN channel liquidity | No pre-flight channel balance check | Query channel liquidity before routing; LN pathfinding may silently fail at large amounts; use `QueryRoutes` to validate |
| Agent token auth | Logging full Authorization header | Mask all credential values in log middleware before any log output is written |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Per-request DB lock on spend-limit check | Serialized payment processing; agents queue up | Use row-level locks scoped to the agent's account row, not table-level | At ~5+ concurrent agents making rapid payments |
| Synchronous Lightning payment in request handler | Slow API responses; timeouts when LN is congested | Use async job queue for payment execution; return a `payment_id` immediately | When LN route finding takes >5s |
| Polling LND for payment status | High RPC overhead; misses rapid state changes | Subscribe to `TrackPaymentV2` stream for state updates | At ~10+ concurrent in-flight payments |
| Unbounded audit log queries | Balance history queries slow down over time | Paginate all log queries; add index on `(agent_id, created_at)` from the start | After ~100K log entries |
| Full Cashu proof scan for double-spend check | O(n) on proof database size | Index spent proofs by Y-coordinate; use the mint's built-in PENDING mechanism | After ~10K proofs |

---

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Cashu mint keyset ID not verified on receipt | Malicious mint collision enables proof reuse across mints | Verify keyset ID matches hash of public keys per Cashu spec (see July 2025 disclosure) |
| Agent can query other agents' balances | Information leak between agents | Enforce agent_id scoping at the query layer; never trust agent-supplied agent_id parameter |
| No rate limit on payment submission | Rogue/compromised agent drains balance faster than daily limit | Per-agent request rate limit independent of policy engine |
| Lightning macaroon has admin permissions | If macaroon leaks, attacker has full node control | Use the most restrictive macaroon possible (invoice-only or limited send macaroon) |
| Policy decisions logged but not the raw request | Cannot audit what an agent actually requested vs. what was approved | Log both the raw request and the policy decision in the same log entry |
| No check that invoice destination is in whitelist before paying | Agent tricks treasury into paying arbitrary Lightning destinations | Validate decoded invoice `destination` pubkey against per-agent whitelist before paying |
| Cashu mint accepts Lightning invoices from agents directly | Agent can drain mint by routing payments to themselves | Restrict which Lightning invoices the mint will settle; validate invoice destination |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Payment flow:** The happy path works — verify what happens when the LND node is unreachable, the payment times out, and the agent retries. Does the agent get double-credited?
- [ ] **Spend limit enforcement:** Works sequentially — verify with 10 concurrent requests at the limit boundary. Does any request exceed the limit?
- [ ] **Audit log:** Entries are written — verify a simulated crash between payment commit and log write leaves no gap. Is the log truly in the same transaction?
- [ ] **Cashu proof redemption:** Single redemptions work — verify simultaneous redemption of identical proofs. Does the mint issue double value?
- [ ] **Secret management:** Works in dev — verify secrets are not readable by processes running as a different user. Is the macaroon file `chmod 600` owned by the service user?
- [ ] **Channel backup:** LND is running — verify the `channel.backup` file is current and the recovery procedure works in a test environment.
- [ ] **Token auth:** Requests are authenticated — verify that the raw token value does not appear anywhere in application logs.
- [ ] **Lightning invoice validation:** Treasury can pay invoices — verify that the decoded invoice amount and destination match the agent's request before execution.

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Policy race condition (over-limit spend) | MEDIUM | Audit log analysis to find excess payments; manual balance adjustment; tighten locking |
| Lightning payment status ambiguity | MEDIUM | Query LND for all payments by hash; reconcile treasury ledger against LND state; adjust balances |
| Cashu double-spend (proof reused) | HIGH | Cannot recover issued tokens; must fund the mint from reserves; identify and ban abusing agent |
| Prompt injection policy bypass | HIGH | Review all recent payments from affected agent; contact any human-approval-bypassed recipients; rotate agent token |
| Private key exposure | CRITICAL | Immediately rotate all exposed credentials; sweep Lightning channels to a new wallet; generate new Cashu mint keys and re-issue tokens; treat all outstanding balances as compromised |
| LND data loss (no current backup) | HIGH | Use most recent SCB to request peer force-closure; recover what peers cooperate on; accept loss of channels with offline peers |
| Audit log gaps | MEDIUM | Reconcile against LND/Cashu external state; document gaps in audit trail; cannot retroactively fill |
| Agent token leaked | LOW-MEDIUM | Rotate token immediately; audit log for payments made during exposure window; check for policy violations |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Policy race condition (TOCTOU) | Phase 1: Data model & policy engine | Concurrent load test at limit boundary before any real funds |
| Lightning payment status ambiguity | Phase 2: Lightning backend integration | Chaos test: kill LND mid-payment; verify ledger reconciles correctly |
| Cashu proof double-spend | Phase 2/3: Cashu mint integration | Concurrent proof redemption test with identical proofs |
| Prompt injection via metadata | Phase 1: API design | Schema validation test; reject free-text policy-affecting fields |
| Secret exposure | Phase 1: Infrastructure setup | Filesystem permission audit; verify secrets not in env vars |
| Lightning node data loss | Phase 2: Lightning backend integration | SCB backup test: restore from backup on clean node |
| Audit log integrity | Phase 1: Data model | Verify log entry in same transaction as payment; hash chain validation test |
| Agent token leakage | Phase 1: Authentication | Log scrub test: verify no token values appear in any log output |

---

## Sources

- LND payment documentation: https://docs.lightning.engineering/lightning-network-tools/lnd/payments (MEDIUM confidence — official, current)
- LND stuck payment issues: https://github.com/lightningnetwork/lnd/issues/5357, #5396, #6249 (HIGH confidence — official issue tracker)
- Cashu NUT-07 (token state check): https://cashubtc.github.io/nuts/07/ (HIGH confidence — official protocol spec)
- Cashu keyset ID vulnerability disclosure: https://conduition.io/code/cashu-disclosure/ (MEDIUM confidence — security researcher, July 2025)
- OWASP LLM Top 10 2025 — Prompt Injection: https://genai.owasp.org/llmrisk/llm01-prompt-injection/ (HIGH confidence — official)
- LDK v0.1.1 HTLC force-close vulnerability: https://www.nobsbitcoin.com/lightning-dev-kit-v0-1-1/ (MEDIUM confidence — reported)
- Storing crypto keys in env variables danger: https://xes.software/resources/blog/storing-crypto-private-keys-in-environment-variables-is-dangerous-use-a-tee/ (MEDIUM confidence — practitioner writeup)
- CVE-2025-55182 (env var leak via React): MEDIUM confidence — reported vulnerability, CVSS 10.0
- Race condition in financial systems (Sourcery): https://www.sourcery.ai/vulnerabilities/race-condition-financial-transactions (MEDIUM confidence — aggregated)
- LND disaster recovery: https://docs.lightning.engineering/lightning-network-tools/lnd/disaster-recovery (HIGH confidence — official)
- Prompt injection to RCE in AI agents: https://blog.trailofbits.com/2025/10/22/prompt-injection-to-rce-in-ai-agents/ (MEDIUM confidence — Trail of Bits, Oct 2025)
- Agentic AI security guide 2025: https://www.rippling.com/blog/agentic-ai-security (LOW confidence — industry blog)
- Cashu protocol overview: https://docs.cashu.space/protocol (HIGH confidence — official)
- Crypto key management statistics 2024: https://coinlaw.io/self-custody-wallet-statistics/ (LOW confidence — aggregated stats)
- Payout races and congested channels formal analysis: https://arxiv.org/html/2405.02147v1 (MEDIUM confidence — academic)

---
*Pitfalls research for: Agent treasury / payment custody service (Lightning + Cashu)*
*Researched: 2026-02-26*
