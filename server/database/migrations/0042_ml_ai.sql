CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`is_hidden` integer DEFAULT false NOT NULL,
	`thumbnail_face_id` text,
	`face_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `photo_embeddings` (
	`photo_id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`embedding` blob NOT NULL,
	`dim` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `asset_faces` (
	`id` text PRIMARY KEY NOT NULL,
	`photo_id` text NOT NULL,
	`person_id` text,
	`x1` real NOT NULL,
	`y1` real NOT NULL,
	`x2` real NOT NULL,
	`y2` real NOT NULL,
	`image_width` integer NOT NULL,
	`image_height` integer NOT NULL,
	`score` real NOT NULL,
	`source` text DEFAULT 'ml' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_asset_faces_photo` ON `asset_faces` (`photo_id`);
--> statement-breakpoint
CREATE INDEX `idx_asset_faces_person` ON `asset_faces` (`person_id`);
--> statement-breakpoint
CREATE TABLE `face_embeddings` (
	`face_id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`embedding` blob NOT NULL,
	`dim` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`face_id`) REFERENCES `asset_faces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `photo_ocr` (
	`photo_id` text PRIMARY KEY NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ml_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `photo_ocr_fts` USING fts5(
	`photo_id` UNINDEXED,
	`text`
);
