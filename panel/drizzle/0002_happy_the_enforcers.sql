CREATE TABLE `mail_notifications` (
	`owner_id` text NOT NULL,
	`mailbox` text NOT NULL,
	`message_id` text NOT NULL,
	`received_at` text NOT NULL,
	`recorded_at` text NOT NULL,
	`data` text NOT NULL,
	`source_id` text,
	`external_id` text,
	`link_status` text NOT NULL,
	`panel_viewed_at` text,
	PRIMARY KEY(`owner_id`, `mailbox`, `message_id`),
	CONSTRAINT "mail_data_json" CHECK(json_valid("mail_notifications"."data")),
	CONSTRAINT "mail_link_status" CHECK("mail_notifications"."link_status" IN ('exact_url','unresolved','unlinked')),
	CONSTRAINT "mail_link_pair" CHECK(("mail_notifications"."source_id" IS NULL AND "mail_notifications"."external_id" IS NULL AND "mail_notifications"."link_status"!='exact_url') OR ("mail_notifications"."source_id" IS NOT NULL AND "mail_notifications"."external_id" IS NOT NULL AND "mail_notifications"."link_status"='exact_url'))
);
--> statement-breakpoint
CREATE INDEX `mail_notifications_recent` ON `mail_notifications` (`owner_id`,`received_at`,`mailbox`,`message_id`);