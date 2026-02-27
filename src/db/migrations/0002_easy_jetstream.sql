CREATE TABLE `cashu_pending` (
	`secret` text PRIMARY KEY NOT NULL,
	`tx_id` text NOT NULL,
	`melt_quote_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cashu_proofs` (
	`id` text PRIMARY KEY NOT NULL,
	`keyset_id` text NOT NULL,
	`amount` integer NOT NULL,
	`secret` text NOT NULL,
	`C` text NOT NULL,
	`source_tx_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cashu_proofs_secret_unique` ON `cashu_proofs` (`secret`);