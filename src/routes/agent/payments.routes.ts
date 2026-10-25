import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { agentAuth } from '../../middleware/agentAuth.js';
import { checkInvoice, invoiceError400 } from '../../lib/lightning/bolt11.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';

type DB = BetterSQLite3Database<typeof schema>;

export const agentPaymentRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply agent auth to all routes in this scope
  app.addHook('onRequest', agentAuth);

  // POST /agents/:id/pay — submit a payment request
  app.post(
    '/agents/:id/pay',
    {
      schema: {
        params: z.object({
          id: z.string().startsWith('ag_'),
        }),
        body: z.object({
          amount_msat: z.number().int().positive(),
          asset: z.enum(['BTC_simulated', 'BTC_lightning', 'BTC_cashu']),
          purpose: z.string().min(1).max(200),
          destination_type: z.enum(['lightning_invoice', 'cashu_token', 'internal']),
          destination: z.string().min(1).max(2000),
          /** Optional hint to prefer a specific payment rail; overrides automatic threshold routing */
          preferred_rail: z.enum(['lightning', 'cashu']).optional(),
        }),
        response: {
          200: z.object({
            transaction_id: z.string(),
            policy_decision: z.enum(['ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL']),
            reason: z.string().optional(),
            mode: z.string(),
            status: z.enum(['SETTLED', 'PENDING', 'FAILED', 'PENDING_APPROVAL']),
            payment_hash: z.string().optional(),
            fee_msat: z.number().optional(),
            cashu_token_id: z.string().optional(),
            rail_used: z.enum(['lightning', 'cashu']).optional(),
            initial_rail: z.enum(['lightning', 'cashu']).optional(),
            final_rail: z.enum(['lightning', 'cashu']).optional(),
            fallback_occurred: z.boolean().optional(),
          }),
          400: invoiceError400,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const db = app.db as unknown as DB;

      // Lightning and Cashu rails can only pay a BOLT11 invoice; any other destination
      // would fail at the wallet, after policy evaluation and the RESERVE
      if (body.destination_type !== 'lightning_invoice' && app.paymentsService.hasRealRail) {
        return reply.status(400).send({
          error: {
            code: 'unsupported_destination_type',
            message: `destination_type '${body.destination_type}' is only payable with WALLET_BACKEND=simulated; ` +
              `the Lightning and Cashu rails pay BOLT11 invoices (destination_type 'lightning_invoice')`,
          },
        });
      }

      // Reject unusable invoices before policy evaluation, so nothing is reserved or audited
      if (body.destination_type === 'lightning_invoice') {
        const check = checkInvoice(body.destination, body.amount_msat);
        if (!check.ok) {
          return reply.status(400).send({
            error: { code: check.code, message: check.message },
            invoice_amount_msat: check.invoice_amount_msat,
          });
        }
      }

      // Process payment — always returns 200 regardless of policy decision.
      // HTTP status reflects request processing success; policy_decision reflects outcome.
      // Use app.paymentsService (bound to the wallet configured at startup)
      // rather than a hardcoded import, so the Lightning/Cashu wallet is used in production.
      const result = await app.paymentsService.processPayment(db, id, {
        ...body,
        preferred_rail: body.preferred_rail,
      });

      return reply.send({
        ...result,
      });
    },
  );
};
