CREATE TABLE `listings` (
	`owner_id` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`data` text NOT NULL,
	`field_times` text DEFAULT '{}' NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	`storage_version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`owner_id`, `source_id`, `external_id`),
	CONSTRAINT "listings_data_json" CHECK(json_valid("listings"."data"))
);
--> statement-breakpoint
CREATE TABLE `review_events` (
	`owner_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`action` text NOT NULL,
	`at` text NOT NULL,
	`data` text NOT NULL,
	`request_hash` text NOT NULL,
	PRIMARY KEY(`owner_id`, `operation_id`),
	CONSTRAINT "review_events_data_json" CHECK(json_valid("review_events"."data"))
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`owner_id` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`data` text NOT NULL,
	`storage_version` integer DEFAULT 1 NOT NULL,
	`last_operation` text NOT NULL,
	PRIMARY KEY(`owner_id`, `source_id`, `external_id`),
	FOREIGN KEY (`owner_id`,`source_id`,`external_id`) REFERENCES `listings`(`owner_id`,`source_id`,`external_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reviews_data_json" CHECK(json_valid("reviews"."data"))
);
