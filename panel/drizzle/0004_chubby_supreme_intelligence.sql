CREATE TABLE `delivery_attempts` (
	`owner_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`revision` integer NOT NULL,
	`preflight_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`owner_id`, `operation_id`),
	CONSTRAINT "delivery_attempts_data_json" CHECK(json_valid("delivery_attempts"."data"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_attempt_order_revision` ON `delivery_attempts` (`owner_id`,`source_id`,`external_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_attempt_preflight` ON `delivery_attempts` (`owner_id`,`preflight_id`);--> statement-breakpoint
CREATE TABLE `delivery_preflights` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`revision` integer NOT NULL,
	`storage_version` integer NOT NULL,
	`data` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_by` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `id`),
	CONSTRAINT "delivery_preflights_data_json" CHECK(json_valid("delivery_preflights"."data"))
);
--> statement-breakpoint
CREATE TABLE `inbox_sync_state` (
	`owner_id` text NOT NULL,
	`channel` text NOT NULL,
	`config_fingerprint` text NOT NULL,
	`mailbox` text NOT NULL,
	`page_cursor` text,
	`initial_complete` integer DEFAULT 0 NOT NULL,
	`lease_id` text,
	`lease_until` text,
	`status` text NOT NULL,
	`last_attempt` text,
	`last_success` text,
	`error_code` text,
	`retry_after_seconds` integer,
	`imported` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`skip_reasons` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`owner_id`, `channel`),
	CONSTRAINT "inbox_sync_initial_complete" CHECK("inbox_sync_state"."initial_complete" IN (0,1)),
	CONSTRAINT "inbox_sync_retry_after" CHECK("inbox_sync_state"."retry_after_seconds" IS NULL OR "inbox_sync_state"."retry_after_seconds" BETWEEN 0 AND 86400),
	CONSTRAINT "inbox_sync_skip_reasons_json" CHECK(json_valid("inbox_sync_state"."skip_reasons"))
);
--> statement-breakpoint
CREATE TABLE `mail_provider_provenance` (
	`owner_id` text NOT NULL,
	`mailbox` text NOT NULL,
	`message_id` text NOT NULL,
	`verified_at` text NOT NULL,
	`receipt_to_storage_ms` integer,
	PRIMARY KEY(`owner_id`, `mailbox`, `message_id`),
	CONSTRAINT "mail_provider_latency_nonnegative" CHECK("mail_provider_provenance"."receipt_to_storage_ms" IS NULL OR "mail_provider_provenance"."receipt_to_storage_ms">=0)
);
--> statement-breakpoint
CREATE TABLE `platform_messages` (
	`owner_id` text NOT NULL,
	`source_id` text NOT NULL,
	`account_id` text NOT NULL,
	`message_id` text NOT NULL,
	`received_at` text NOT NULL,
	`recorded_at` text NOT NULL,
	`data` text NOT NULL,
	`external_id` text NOT NULL,
	`panel_viewed_at` text,
	PRIMARY KEY(`owner_id`, `source_id`, `account_id`, `message_id`),
	CONSTRAINT "platform_messages_data_json" CHECK(json_valid("platform_messages"."data"))
);
--> statement-breakpoint
CREATE INDEX `platform_messages_recent` ON `platform_messages` (`owner_id`,`received_at`,`source_id`,`account_id`,`message_id`);