CREATE TABLE `access_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` integer NOT NULL,
	`audience` text NOT NULL,
	`user_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "access_grants_user_scope_check" CHECK("access_grants"."audience" = 'user' OR "access_grants"."user_id" IS NULL),
	CONSTRAINT "access_grants_audience_check" CHECK("access_grants"."audience" IN ('public', 'login', 'admin', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_grants_principal_unique` ON `access_grants` (`collection_id`,`audience`,`user_id`) WHERE "access_grants"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `access_grants_scope_unique` ON `access_grants` (`collection_id`,`audience`) WHERE "access_grants"."user_id" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_access_grants_collection` ON `access_grants` (`collection_id`);--> statement-breakpoint
CREATE INDEX `idx_access_grants_user` ON `access_grants` (`user_id`);--> statement-breakpoint
CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
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
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_asset_faces_photo` ON `asset_faces` (`photo_id`);--> statement-breakpoint
CREATE INDEX `idx_asset_faces_person` ON `asset_faces` (`person_id`);--> statement-breakpoint
CREATE TABLE `collection_photos` (
	`collection_id` integer NOT NULL,
	`photo_id` text NOT NULL,
	`position` real DEFAULT 1000000 NOT NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`collection_id`, `photo_id`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_collection_photos_photo` ON `collection_photos` (`photo_id`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`parent_id` integer,
	`library_id` integer,
	`rel_path` text DEFAULT '' NOT NULL,
	`title` text,
	`description` text,
	`cover_photo_id` text,
	`bgm_music_id` integer,
	`uid` text,
	`slug` text,
	`url_key` text,
	`layout` text DEFAULT 'waterfall' NOT NULL,
	`show_on_gallery` integer DEFAULT true NOT NULL,
	`show_on_albums` integer DEFAULT true NOT NULL,
	`child_in_parent` integer DEFAULT true NOT NULL,
	`child_position` text DEFAULT 'start' NOT NULL,
	`random_animation` text DEFAULT 'default' NOT NULL,
	`random_quotes_enabled` integer DEFAULT true NOT NULL,
	`random_quotes` text,
	`random_quotes_tag` text,
	`password_hash` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cover_photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`bgm_music_id`) REFERENCES `music`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "collections_kind_scope_check" CHECK(("collections"."kind" = 'folder' AND "collections"."library_id" IS NOT NULL) OR ("collections"."kind" IN ('manual', 'person') AND "collections"."library_id" IS NULL)),
	CONSTRAINT "collections_manual_identity_check" CHECK("collections"."kind" != 'manual' OR ("collections"."title" IS NOT NULL AND "collections"."uid" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_uid_unique` ON `collections` (`uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `collections_slug_unique` ON `collections` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `collections_url_key_unique` ON `collections` (`url_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `collections_folder_path_unique` ON `collections` (`library_id`,`rel_path`) WHERE "collections"."kind" = 'folder';--> statement-breakpoint
CREATE INDEX `idx_collections_library_parent` ON `collections` (`library_id`,`parent_id`);--> statement-breakpoint
CREATE TABLE `face_embeddings` (
	`face_id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`embedding` blob NOT NULL,
	`dim` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`face_id`) REFERENCES `asset_faces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `geocode_places` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_en` text,
	`aliases` text,
	`pinyin` text,
	`pinyin_abbr` text,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`country` text,
	`province` text,
	`city` text,
	`district` text,
	`place_type` text,
	`admin_code` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "geocode_places_latitude_check" CHECK("geocode_places"."latitude" >= -90 AND "geocode_places"."latitude" <= 90),
	CONSTRAINT "geocode_places_longitude_check" CHECK("geocode_places"."longitude" >= -180 AND "geocode_places"."longitude" <= 180)
);
--> statement-breakpoint
CREATE INDEX `idx_geocode_places_enabled_priority` ON `geocode_places` (`enabled`,`priority`);--> statement-breakpoint
CREATE INDEX `idx_geocode_places_name` ON `geocode_places` (`name`);--> statement-breakpoint
CREATE INDEX `idx_geocode_places_city` ON `geocode_places` (`city`);--> statement-breakpoint
CREATE INDEX `idx_geocode_places_province` ON `geocode_places` (`province`);--> statement-breakpoint
CREATE INDEX `idx_geocode_places_district` ON `geocode_places` (`district`);--> statement-breakpoint
CREATE INDEX `idx_geocode_places_place_type` ON `geocode_places` (`place_type`);--> statement-breakpoint
CREATE TABLE `libraries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url_key` text,
	`root_path` text NOT NULL,
	`provider` text DEFAULT 'local' NOT NULL,
	`display_mode` text DEFAULT 'gallery' NOT NULL,
	`child_in_parent` integer DEFAULT true NOT NULL,
	`child_position` text DEFAULT 'start' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`watch_interval_ms` integer DEFAULT 60000 NOT NULL,
	`last_scan_at` integer,
	`last_scan_result` text,
	`disabled_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_url_key_unique` ON `libraries` (`url_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_root_path_unique` ON `libraries` (`root_path`);--> statement-breakpoint
CREATE TABLE `login_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`email` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`country` text,
	`region` text,
	`city` text,
	`method` text DEFAULT 'password' NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_login_logs_user_created` ON `login_logs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_login_logs_email_created` ON `login_logs` (`email`,`created_at`);--> statement-breakpoint
CREATE TABLE `ml_tag_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tag_id` integer NOT NULL,
	`alias` text NOT NULL,
	`alias_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `ml_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ml_tag_aliases_alias_key_unique` ON `ml_tag_aliases` (`alias_key`);--> statement-breakpoint
CREATE INDEX `idx_ml_tag_aliases_tag` ON `ml_tag_aliases` (`tag_id`);--> statement-breakpoint
CREATE TABLE `ml_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`prompt` text NOT NULL,
	`vector_model` text,
	`vector_prompt` text,
	`embedding` blob,
	`dim` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ml_tags_name_key_unique` ON `ml_tags` (`name_key`);--> statement-breakpoint
CREATE TABLE `music` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`filename` text NOT NULL,
	`storage_key` text NOT NULL,
	`mime_type` text DEFAULT 'audio/mpeg' NOT NULL,
	`duration` real,
	`file_size` integer DEFAULT 0 NOT NULL,
	`lyrics` text,
	`cover_key` text,
	`cover_url` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `music_storage_key_unique` ON `music` (`storage_key`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`owner_id` text,
	`collection_id` integer,
	`origin` text DEFAULT 'ml' NOT NULL,
	`thumbnail_face_id` text,
	`face_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_collection_id_unique` ON `people` (`collection_id`);--> statement-breakpoint
CREATE INDEX `idx_people_name` ON `people` (`name`);--> statement-breakpoint
CREATE TABLE `photo_embeddings` (
	`photo_id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`embedding` blob NOT NULL,
	`dim` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_photo_embeddings_model` ON `photo_embeddings` (`model`);--> statement-breakpoint
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
CREATE INDEX `idx_photo_ml_tags_tag` ON `photo_ml_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `photo_ocr` (
	`photo_id` text PRIMARY KEY NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `photo_ocr_fts` USING fts5(
	`photo_id` UNINDEXED,
	`text`
);
--> statement-breakpoint
CREATE TABLE `photo_reactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` text NOT NULL,
	`reaction_type` text NOT NULL,
	`fingerprint` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photo_reactions_photo_fingerprint_unique` ON `photo_reactions` (`photo_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_photo_reactions_photo_type` ON `photo_reactions` (`photo_id`,`reaction_type`);--> statement-breakpoint
CREATE INDEX `idx_photo_reactions_fingerprint_created` ON `photo_reactions` (`fingerprint`,`created_at`);--> statement-breakpoint
CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`description` text,
	`width` integer,
	`height` integer,
	`aspect_ratio` real,
	`date_taken` text,
	`storage_key` text,
	`thumbnail_key` text,
	`file_size` integer,
	`last_modified` text,
	`original_url` text,
	`thumbnail_url` text,
	`thumbnail_hash` text,
	`tags` text,
	`exif` text,
	`latitude` real,
	`longitude` real,
	`country` text,
	`city` text,
	`location_name` text,
	`is_live_photo` integer DEFAULT 0 NOT NULL,
	`live_photo_video_url` text,
	`live_photo_video_key` text,
	`is_panorama` integer,
	`pano_yaw` real,
	`pano_pitch` real,
	`type` text DEFAULT 'image' NOT NULL,
	`source` text DEFAULT 'upload' NOT NULL,
	`library_mount` text,
	`library_id` integer,
	`face_scanned_at` integer,
	`library_path` text,
	`deleted_at` integer,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "photos_latitude_check" CHECK("photos"."latitude" IS NULL OR ("photos"."latitude" >= -90 AND "photos"."latitude" <= 90)),
	CONSTRAINT "photos_longitude_check" CHECK("photos"."longitude" IS NULL OR ("photos"."longitude" >= -180 AND "photos"."longitude" <= 180))
);
--> statement-breakpoint
CREATE INDEX `idx_photos_gallery_order` ON `photos` ("date_taken" DESC,"id" ASC) WHERE "photos"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_photos_geo_timeline` ON `photos` ("date_taken" ASC,"id" ASC) WHERE "photos"."deleted_at" IS NULL AND "photos"."latitude" IS NOT NULL AND "photos"."longitude" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_photos_library_path` ON `photos` (`library_id`,`library_path`);--> statement-breakpoint
CREATE INDEX `idx_photos_library_deleted` ON `photos` (`library_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_photos_mount_path` ON `photos` (`library_mount`,`library_path`);--> statement-breakpoint
CREATE TABLE `pipeline_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payload` text DEFAULT '{"type":"photo","storageKey":""}' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_stage` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_queue_pending` ON `pipeline_queue` (`status`,"priority" DESC,"created_at" ASC);--> statement-breakpoint
CREATE INDEX `idx_pipeline_queue_status_completed` ON `pipeline_queue` (`status`,`completed_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`namespace` text DEFAULT 'common' NOT NULL,
	`key` text NOT NULL,
	`type` text NOT NULL,
	`value` text,
	`default_value` text,
	`label` text,
	`description` text,
	`is_public` integer DEFAULT false NOT NULL,
	`is_readonly` integer DEFAULT false NOT NULL,
	`is_secret` integer DEFAULT false NOT NULL,
	`enum` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_by` integer,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_namespace_key` ON `settings` (`namespace`,`key`);--> statement-breakpoint
CREATE TABLE `settings_storage_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password` text,
	`avatar` text,
	`created_at` integer NOT NULL,
	`is_admin` integer DEFAULT 0 NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`totp_secret` text,
	`totp_enabled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_name_unique` ON `users` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);