import 'dotenv/config';
import { z } from 'zod/v4';

const configSchema = z.object({
  VAULTWARDEN_ADMIN_TOKEN: z.string().min(32),
  DATABASE_PATH: z.string().default('./vaultwarden.db'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export const config = configSchema.parse(process.env);
