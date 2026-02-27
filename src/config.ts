import 'dotenv/config';
import { z } from 'zod/v4';

const configSchema = z
  .object({
    VAULTWARDEN_ADMIN_TOKEN: z.string().min(32),
    DATABASE_PATH: z.string().default('./vaultwarden.db'),
    PORT: z.coerce.number().default(3000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    WALLET_BACKEND: z.enum(['simulated', 'lightning']).default('simulated'),
    LND_HOST: z.string().optional(),
    LND_PORT: z.coerce.number().default(10009),
    LND_CERT_BASE64: z.string().optional(),
    LND_MACAROON_BASE64: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.WALLET_BACKEND === 'lightning') {
        return Boolean(data.LND_HOST && data.LND_CERT_BASE64 && data.LND_MACAROON_BASE64);
      }
      return true;
    },
    {
      message:
        'LND_HOST, LND_CERT_BASE64, and LND_MACAROON_BASE64 are required when WALLET_BACKEND=lightning',
    },
  );

export const config = configSchema.parse(process.env);
