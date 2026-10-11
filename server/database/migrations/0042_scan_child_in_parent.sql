ALTER TABLE `scan_libraries` ADD `child_in_parent` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `scan_libraries` ADD `child_position` text DEFAULT 'start' NOT NULL;