ALTER TABLE `ledger_entries` ADD `payment_hash` text;--> statement-breakpoint
ALTER TABLE `ledger_entries` ADD `mode` text DEFAULT 'simulated';--> statement-breakpoint
ALTER TABLE `policies` ADD `max_fee_msat` integer DEFAULT 1000;