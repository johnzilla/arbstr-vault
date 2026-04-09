import 'dotenv/config';
import { z } from 'zod/v4';

const configSchema = z
  .object({
    VAULT_ADMIN_TOKEN: z.string().min(32),
    DATABASE_PATH: z.string().default('./arbstr-vault.db'),
    PORT: z.coerce.number().default(3000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    WALLET_BACKEND: z.enum(['simulated', 'lightning', 'cashu', 'auto']).default('simulated'),
    LND_HOST: z.string().optional(),
    LND_PORT: z.coerce.number().default(10009),
    LND_CERT_BASE64: z.string().optional(),
    LND_MACAROON_BASE64: z.string().optional(),
    CASHU_MINT_URL: z.string().url().optional(),
    CASHU_THRESHOLD_MSAT: z.coerce.number().default(1_000_000),
    OPERATOR_WEBHOOK_URL: z.string().url().optional(),
    OPERATOR_WEBHOOK_SECRET: z.string().min(16).optional(),
    VAULT_INTERNAL_TOKEN: z.string().min(32).optional(),
  })
  .refine(
    (data) => {
      if (data.WALLET_BACKEND === 'lightning' || data.WALLET_BACKEND === 'auto') {
        return Boolean(data.LND_HOST && data.LND_CERT_BASE64 && data.LND_MACAROON_BASE64);
      }
      return true;
    },
    {
      message:
        'LND_HOST, LND_CERT_BASE64, and LND_MACAROON_BASE64 are required when WALLET_BACKEND=lightning or WALLET_BACKEND=auto',
    },
  )
  .refine(
    (data) => {
      if (data.WALLET_BACKEND === 'cashu' || data.WALLET_BACKEND === 'auto') {
        return Boolean(data.CASHU_MINT_URL);
      }
      return true;
    },
    {
      message: 'CASHU_MINT_URL is required when WALLET_BACKEND=cashu or WALLET_BACKEND=auto',
    },
  );

export const config = configSchema.parse(process.env);
