CREATE TABLE `scan_runs` (
	`owner_id` text NOT NULL,
	`run_id` text NOT NULL,
	`source_id` text NOT NULL,
	`checked_at` text NOT NULL,
	`recorded_at` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`owner_id`, `run_id`, `source_id`),
	CONSTRAINT "scan_runs_data_json" CHECK(json_valid("scan_runs"."data"))
);
--> statement-breakpoint
CREATE INDEX `scan_runs_latest` ON `scan_runs` (`owner_id`,`source_id`,`checked_at`,`recorded_at`,`run_id`);