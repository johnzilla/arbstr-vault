# Phase 6: Settle, Release, and Verification - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-02
**Phase:** 06-settle-release-and-verification
**Areas discussed:** Reservation lookup, Idempotency check, Metadata storage, Settle response shape

---

## Reservation Lookup

| Option | Description | Selected |
|--------|-------------|----------|
| Lookup by id | Find RESERVE where id = reservation_id. Direct PK lookup, guaranteed unique. | ✓ |
| Lookup by ref_id | Find RESERVE where ref_id = reservation_id. Would require changing Phase 5. | |

**User's choice:** Lookup by id
**Notes:** reservation_id IS the ledger entry PK (tx_ ULID)

---

## Idempotency Check

| Option | Description | Selected |
|--------|-------------|----------|
| Check RELEASE exists with ref_id=reservation_id | Query for existing RELEASE entry. No schema changes needed. | ✓ |
| Add status column to ledger_entries | Requires schema migration. | |

**User's choice:** Check RELEASE exists with ref_id=reservation_id
**Notes:** Adapts the existing pattern from getPendingLightningPayments()

---

## Metadata Storage

| Option | Description | Selected |
|--------|-------------|----------|
| Audit log entry | Use auditRepo.insert() with PAYMENT_SETTLED action and metadata JSON. | ✓ |
| Add metadata column to ledger_entries | Requires schema migration. | |
| Repurpose payment_hash column | Hacky, avoids migration. | |

**User's choice:** Audit log entry
**Notes:** Audit module already supports metadata: Record<string, unknown> and PAYMENT_SETTLED action

---

## Settle Response Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Rich response | {settled, refunded_msats, actual_msats, remaining_balance_msats} | ✓ |
| Minimal response | {settled, refunded_msats} — matches original spec | |

**User's choice:** Rich response
**Notes:** Caller gets full picture without extra API call, consistent with Phase 5 reserve response including remaining_balance_msats

---

## Claude's Discretion

- Transaction wrapper implementation (Drizzle's db.transaction() or manual)
- Exact Zod schema structure for settle/release request/response
- How to extract reserved_amount from RESERVE entry for RELEASE credit
- Whether to add findById to ledgerRepo or query inline

## Deferred Ideas

None — discussion stayed within phase scope
