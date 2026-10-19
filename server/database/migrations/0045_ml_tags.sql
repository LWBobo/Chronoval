CREATE TABLE `ml_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`prompt` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ml_tags_name_key_unique` ON `ml_tags` (`name_key`);
--> statement-breakpoint
CREATE TABLE `ml_tag_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tag_id` integer NOT NULL,
	`alias` text NOT NULL,
	`alias_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `ml_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ml_tag_aliases_alias_key_unique` ON `ml_tag_aliases` (`alias_key`);
--> statement-breakpoint
CREATE INDEX `idx_ml_tag_aliases_tag` ON `ml_tag_aliases` (`tag_id`);
--> statement-breakpoint
CREATE TABLE `ml_tag_vectors` (
	`tag_id` integer PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`prompt` text NOT NULL,
	`embedding` blob NOT NULL,
	`dim` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `ml_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `photo_ml_tags` (
	`photo_id` text NOT NULL,
	`tag_id` integer NOT NULL,
	`source` text NOT NULL,
	`decision` text NOT NULL,
	`score` real,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`photo_id`, `tag_id`),
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `ml_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_photo_ml_tags_tag` ON `photo_ml_tags` (`tag_id`);
