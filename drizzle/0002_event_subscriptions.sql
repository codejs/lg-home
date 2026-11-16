CREATE TABLE `subscriptions` (
	`device_id` text PRIMARY KEY NOT NULL,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`last_state` text,
	`last_polled_at` integer,
	`last_change_at` integer,
	`last_error` text,
	`last_error_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `events_device_id_idx` ON `events` (`device_id`);--> statement-breakpoint
CREATE INDEX `events_kind_created_at_idx` ON `events` (`kind`,`created_at`);