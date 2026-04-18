---
id: 260418-nt5
slug: finish-vaultwarden-rename-webhook-header
description: finish vaultwarden rename — webhook header + active docs
date: 2026-04-18
status: complete
commits:
  - f3284a2 (webhook header)
  - deeb981 (PROJECT + ROADMAP titles)
  - d0764fa (research docs)
---

# Quick Task 260418-nt5: Finish Vaultwarden → arbstr-vault Rename — Summary

## What Shipped

Closed out the residue from prior rename commits (98025ef, 9c0b6aa):

1. **Webhook header renamed** — `src/modules/webhook/webhook.service.ts:18`:
   `X-Vaultwarden-Signature` → `X-ArbstrVault-Signature`. Breaking change for
   any webhook consumer asserting on the header name.
2. **Active planning doc titles** — `.planning/PROJECT.md` and
   `.planning/ROADMAP.md` H1s updated to `(arbstr-vault)`.
3. **Research docs** — `.planning/research/SUMMARY.md`, `STACK.md`,
   `ARCHITECTURE.md`, `FEATURES.md` — 6 prose/footer references updated.

## Verification

- `grep -ri "vaultwarden" src/ .planning/*.md .planning/research/` → 0 matches
- `npm test` → 144 passed, 1 skipped (no regressions)

## Out of Scope (preserved)

- `.planning/milestones/**` — 30+ archived files from shipped v1.0 and v1.1
  milestones. Intentionally left as historical record per locked decision.

## Locked Decisions

- Webhook header rename accepted as breaking change (no deployed consumers).
- Archives preserved — rewriting history would falsify what was actually
  written at the time.
