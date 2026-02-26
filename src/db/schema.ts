import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { ulid } from 'ulidx';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey().$defaultFn(() => `ag_${ulid()}`),
  name: text('name').notNull(),
  token_hash: text('token_hash').notNull(),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, string>>(),
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
});

export const policies = sqliteTable('policies', {
  id: text('id').primaryKey().$defaultFn(() => `pl_${ulid()}`),
  agent_id: text('agent_id')
    .notNull()
    .references(() => agents.id)
    .unique(),
  max_transaction_msat: integer('max_transaction_msat').notNull().default(0),
  daily_limit_msat: integer('daily_limit_msat').notNull().default(0),
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
});

export const ledgerEntries = sqliteTable('ledger_entries', {
  id: text('id').primaryKey().$defaultFn(() => `tx_${ulid()}`),
  agent_id: text('agent_id')
    .notNull()
    .references(() => agents.id),
  amount_msat: integer('amount_msat').notNull(),
  entry_type: text('entry_type', { enum: ['DEPOSIT', 'PAYMENT', 'REFUND'] }).notNull(),
  ref_id: text('ref_id'),
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
});

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  agent_id: text('agent_id').notNull(),
  action: text('action', {
    enum: [
      'AGENT_REGISTERED',
      'POLICY_UPDATED',
      'PAYMENT_REQUEST',
      'PAYMENT_SETTLED',
      'PAYMENT_FAILED',
      'DEPOSIT',
    ],
  }).notNull(),
  policy_decision: text('policy_decision', {
    enum: ['ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL'],
  }),
  policy_reason: text('policy_reason'),
  amount_msat: integer('amount_msat'),
  ref_id: text('ref_id'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
});
