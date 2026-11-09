CREATE TABLE `delivery_events` (
	`owner_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`version` integer NOT NULL,
	`action` text NOT NULL,
	`at` text NOT NULL,
	`data` text NOT NULL,
	`request_hash` text NOT NULL,
	PRIMARY KEY(`owner_id`, `operation_id`),
	CONSTRAINT "delivery_events_data_json" CHECK(json_valid("delivery_events"."data"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_events_version` ON `delivery_events` (`owner_id`,`source_id`,`external_id`,`version`);--> statement-breakpoint
CREATE TABLE `delivery_records` (
	`owner_id` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`version` integer NOT NULL,
	`data` text NOT NULL,
	`last_operation` text NOT NULL,
	PRIMARY KEY(`owner_id`, `source_id`, `external_id`),
	CONSTRAINT "delivery_records_data_json" CHECK(json_valid("delivery_records"."data"))
);
