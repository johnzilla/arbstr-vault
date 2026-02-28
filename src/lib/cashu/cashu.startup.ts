import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { CashuClient } from './cashu.client.js';
import { CashuWalletBackend } from '../../modules/payments/wallet/cashu.wallet.js';
import { cashuRepo } from '../../modules/cashu/cashu.repo.js';
import { auditRepo } from '../../modules/audit/audit.repo.js';
import { config } from '../../config.js';
import type { WalletBackend } from '../../modules/payments/wallet/wallet.interface.js';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * Initialize the Cashu ecash backend.
 *
 * Mirrors the initializeLightningBackend pattern from lnd.startup.ts.
 * Must be called before buildApp() so the wallet is ready before serving requests.
 *
 * Steps:
 * 1. Create and initialize CashuClient (loadMint — required before any operation)
 * 2. Crash recovery — process all PENDING Cashu operations from previous run
 * 3. Keyset rotation — swap proofs from inactive keysets for active-keyset proofs
 * 4. Create and return CashuWalletBackend
 *
 * @param db - Database connection (narrow type — only uses cashu and audit repos)
 * @returns Ready CashuWalletBackend implementing WalletBackend
 */
export async function initializeCashuBackend(db: Db): Promise<WalletBackend> {
  // ---------------------------------------------------------------------------
  // Step 1: Create and initialize CashuClient
  // loadMint() makes the initial network call to fetch mint info, keysets, and keys.
  // MUST be called before any other operation (Pitfall 5: constructor makes no network calls).
  // ---------------------------------------------------------------------------
  const client = new CashuClient(config.CASHU_MINT_URL!);
  await client.initialize();
  console.info('[Cashu startup] Connected to mint:', config.CASHU_MINT_URL);

  // ---------------------------------------------------------------------------
  // Step 2: Crash recovery — process all PENDING Cashu operations
  //
  // PENDING entries in cashu_pending represent proof locks from a previous run
  // that may not have been resolved (crash between lock and melt, or melt result unknown).
  //
  // For each PENDING operation:
  // - If it has a melt_quote_id: check the mint for actual melt status via checkMeltQuote
  //   - PAID: melt succeeded, proofs were spent — release the lock
  //   - UNPAID: melt did not complete — release the lock (proofs may be lost if deleted before crash)
  //   - PENDING at mint: leave our lock for next startup retry
  // - If it has no melt_quote_id: crashed before the melt call — release the lock
  // ---------------------------------------------------------------------------
  const pending = cashuRepo.getPendingOperations(db);
  if (pending.length > 0) {
    console.info(`[Cashu startup] Crash recovery: ${pending.length} PENDING operation(s) found`);
  }

  for (const op of pending) {
    try {
      if (op.melt_quote_id) {
        // Has melt quote — check with mint for actual melt status
        const quoteStatus = await client.checkMeltQuote(op.melt_quote_id);

        if (quoteStatus.state === 'PAID') {
          // Melt succeeded — proofs were spent. Release the PENDING lock.
          cashuRepo.releaseProofs(db, [op.secret]);
          console.info(
            `[Cashu startup] Crash recovery: melt ${op.melt_quote_id} confirmed PAID — released lock for ${op.tx_id}`,
          );
        } else if (quoteStatus.state === 'UNPAID') {
          // Melt did not go through — proofs NOT spent by the mint.
          // Release the PENDING lock. The proofs may have been deleted from the pool
          // before the crash (step 3 of CashuWalletBackend.pay deletes proofs before melt).
          // A more robust implementation would also restore the proofs here using NUT-07,
          // but for now we release the lock and log the situation.
          cashuRepo.releaseProofs(db, [op.secret]);
          console.warn(
            `[Cashu startup] Crash recovery: melt ${op.melt_quote_id} UNPAID — releasing lock for ${op.tx_id}`,
          );
        } else {
          // PENDING state at mint — leave our lock, will retry next startup
          console.info(
            `[Cashu startup] Crash recovery: melt ${op.melt_quote_id} still PENDING at mint — skipping ${op.tx_id}`,
          );
        }
      } else {
        // No melt_quote_id — crashed before the melt call was made.
        // The proofs were locked but melt was never initiated — safe to release.
        cashuRepo.releaseProofs(db, [op.secret]);
        console.warn(
          `[Cashu startup] Crash recovery: no melt_quote_id for ${op.tx_id} — releasing lock (crashed before melt)`,
        );
      }
    } catch (err) {
      console.error(`[Cashu startup] Crash recovery error for ${op.tx_id}:`, err);
      // Leave PENDING — will retry next startup (mint may be temporarily unavailable)
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3: Keyset rotation — swap proofs from inactive keysets
  //
  // The mint may rotate its keysets (retire old keys, introduce new ones).
  // Proofs with inactive keyset IDs can still be spent as inputs to a swap,
  // but should be swapped for new active-keyset proofs proactively.
  //
  // Process:
  // 1. Get current keysets from the client (loaded during initialize())
  // 2. Find proofs in our pool with keyset IDs NOT in the active set
  // 3. Swap them for new proofs from active keysets
  // 4. Delete old proofs and insert new proofs (in a single transaction)
  // 5. Write CASHU_KEYSET_SWAP audit entry
  //
  // Non-fatal: if rotation fails, old keyset proofs still work as melt inputs for now.
  // ---------------------------------------------------------------------------
  try {
    const keysets = client.getKeysets();
    const activeKeysetIds = new Set(
      keysets.filter((k) => k.isActive && k.unit === 'sat').map((k) => k.id),
    );
    const allProofs = cashuRepo.getAllProofs(db);

    // Find proofs with inactive keyset IDs
    const inactiveProofs = allProofs.filter((p) => !activeKeysetIds.has(p.keyset_id));

    if (inactiveProofs.length > 0) {
      console.info(
        `[Cashu startup] Keyset rotation: ${inactiveProofs.length} proof(s) from inactive keysets — swapping`,
      );

      // Convert to cashu-ts Proof format for the swap call
      const cashuTsProofs = inactiveProofs.map((p) => ({
        id: p.keyset_id,
        amount: p.amount,
        secret: p.secret,
        C: p.C,
      }));

      const newProofs = await client.swapProofs(cashuTsProofs);

      // Delete old proofs and insert new ones atomically
      db.transaction((tx) => {
        const tdb = tx as unknown as Db;

        cashuRepo.deleteProofs(tdb, inactiveProofs.map((p) => p.secret));
        cashuRepo.insertProofs(
          tdb,
          newProofs.map((p) => ({
            keyset_id: p.id,
            amount: p.amount,
            secret: p.secret,
            C: p.C,
          })),
          'keyset_rotation',
        );

        auditRepo.insert(tdb, {
          agent_id: 'system',
          action: 'CASHU_KEYSET_SWAP',
          metadata: {
            old_keyset_ids: [...new Set(inactiveProofs.map((p) => p.keyset_id))],
            new_keyset_id: newProofs[0]?.id,
            proof_count: inactiveProofs.length,
          },
        });
      }, { behavior: 'immediate' });

      console.info(
        `[Cashu startup] Keyset rotation: swapped ${inactiveProofs.length} proof(s) to ${newProofs.length} new proof(s)`,
      );
    } else {
      console.info('[Cashu startup] Keyset rotation: all proofs are on active keysets — no rotation needed');
    }
  } catch (err) {
    console.error('[Cashu startup] Keyset rotation check failed:', err);
    // Non-fatal — old keyset proofs still work as melt inputs; swap will be retried next startup
  }

  // ---------------------------------------------------------------------------
  // Step 4: Create and return CashuWalletBackend
  // ---------------------------------------------------------------------------
  return new CashuWalletBackend(client, db);
}
