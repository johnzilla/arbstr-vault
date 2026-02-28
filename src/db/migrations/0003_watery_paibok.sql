CREATE TABLE `pending_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`type` text NOT NULL,
	`transaction_id` text NOT NULL,
	`amount_msat` integer NOT NULL,
	`destination` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `policy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`version` integer NOT NULL,
	`max_transaction_msat` integer DEFAULT 0 NOT NULL,
	`daily_limit_msat` integer DEFAULT 0 NOT NULL,
	`max_fee_msat` integer DEFAULT 1000,
	`approval_timeout_ms` integer DEFAULT 300000,
	`alert_floor_msat` integer DEFAULT 0,
	`alert_cooldown_ms` integer DEFAULT 3600000,
	`effective_from` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
