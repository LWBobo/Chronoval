CREATE TABLE `photo_face_scans` (
	`photo_id` text PRIMARY KEY NOT NULL,
	`face_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
