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
CREATE INDEX `idx_asset_faces_photo` ON `asset_faces` (`photo_id`);
--> statement-breakpoint
CREATE INDEX `idx_asset_faces_person` ON `asset_faces` (`person_id`);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_user_id` integer NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`owner_user_id` integer,
	`reason` text,
	`request_id` text,
	`before_json` text,
	`after_json` text,
	`ip` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);

--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_logs` (`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_audit_owner_created` ON `audit_logs` (`owner_user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `auth_challenge_uses` (
	`nonce` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);

--> statement-breakpoint
CREATE TABLE `collection_password_exemptions` (
	`collection_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`granted_by` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`collection_id`, `user_id`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);

--> statement-breakpoint
CREATE INDEX `idx_collection_exempt_user` ON `collection_password_exemptions` (`user_id`,`collection_id`);
--> statement-breakpoint
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
CREATE INDEX `idx_collection_photos_photo` ON `collection_photos` (`photo_id`);
--> statement-breakpoint
CREATE TABLE `collection_viewers` (
	`collection_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`granted_by` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`collection_id`, `user_id`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);

--> statement-breakpoint
CREATE INDEX `idx_collection_viewers_user` ON `collection_viewers` (`user_id`,`collection_id`);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`ownership_type` text DEFAULT 'site' NOT NULL,
	`owner_id` integer,
	`visibility` text DEFAULT 'public' NOT NULL,
	`acl_version` integer DEFAULT 1 NOT NULL,
	`password_version` integer DEFAULT 1 NOT NULL,
	`password_exempt_mode` text DEFAULT 'none' NOT NULL,
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
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cover_photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`bgm_music_id`) REFERENCES `music`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "collections_visibility_check" CHECK("collections"."visibility" IN ('public','login','selected','admin')),
	CONSTRAINT "collections_exempt_check" CHECK("collections"."password_exempt_mode" IN ('none','logged_in','selected')),
	CONSTRAINT "collections_ownership_check" CHECK(("collections"."ownership_type"='site' AND "collections"."owner_id" IS NULL) OR ("collections"."ownership_type"='user' AND "collections"."owner_id" IS NOT NULL AND "collections"."kind"='person' AND "collections"."visibility"='admin')),
	CONSTRAINT "collections_versions_check" CHECK("collections"."acl_version">=1 AND "collections"."password_version">=1),
	CONSTRAINT "collections_kind_scope_check" CHECK(("collections"."kind" = 'folder' AND "collections"."library_id" IS NOT NULL) OR ("collections"."kind" IN ('manual', 'person') AND "collections"."library_id" IS NULL)),
	CONSTRAINT "collections_manual_identity_check" CHECK("collections"."kind" != 'manual' OR ("collections"."title" IS NOT NULL AND "collections"."uid" IS NOT NULL))
);

--> statement-breakpoint
CREATE UNIQUE INDEX `collections_uid_unique` ON `collections` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_slug_unique` ON `collections` (`slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_url_key_unique` ON `collections` (`url_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_folder_path_unique` ON `collections` (`library_id`,`rel_path`) WHERE "collections"."kind" = 'folder';
--> statement-breakpoint
CREATE INDEX `idx_collections_library_parent` ON `collections` (`library_id`,`parent_id`);
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
CREATE INDEX `idx_geocode_places_enabled_priority` ON `geocode_places` (`enabled`,`priority`);
--> statement-breakpoint
CREATE INDEX `idx_geocode_places_name` ON `geocode_places` (`name`);
--> statement-breakpoint
CREATE INDEX `idx_geocode_places_city` ON `geocode_places` (`city`);
--> statement-breakpoint
CREATE INDEX `idx_geocode_places_province` ON `geocode_places` (`province`);
--> statement-breakpoint
CREATE INDEX `idx_geocode_places_district` ON `geocode_places` (`district`);
--> statement-breakpoint
CREATE INDEX `idx_geocode_places_place_type` ON `geocode_places` (`place_type`);
--> statement-breakpoint
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
	`deleting` integer DEFAULT false NOT NULL,
	`watch_interval_ms` integer DEFAULT 60000 NOT NULL,
	`last_scan_at` integer,
	`last_scan_result` text,
	`disabled_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_url_key_unique` ON `libraries` (`url_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_root_path_unique` ON `libraries` (`root_path`);
--> statement-breakpoint
CREATE TABLE `login_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`account_email_snapshot` text,
	`login_identifier` text NOT NULL,
	`identifier_type` text NOT NULL,
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
CREATE INDEX `idx_login_logs_user_created` ON `login_logs` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_login_logs_identifier_created` ON `login_logs` (`login_identifier`,`created_at`);
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
CREATE UNIQUE INDEX `ml_tags_name_key_unique` ON `ml_tags` (`name_key`);
--> statement-breakpoint
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
CREATE UNIQUE INDEX `music_storage_key_unique` ON `music` (`storage_key`);
--> statement-breakpoint
CREATE TABLE `mutation_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` integer NOT NULL,
	`operation_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);

--> statement-breakpoint
CREATE UNIQUE INDEX `mutation_receipt_key_unique` ON `mutation_receipts` (`actor_user_id`,`operation_key`);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`owner_id` integer,
	`ownership_type` text DEFAULT 'site' NOT NULL,
	`collection_id` integer,
	`origin` text DEFAULT 'ml' NOT NULL,
	`thumbnail_face_id` text,
	`face_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "people_ownership_check" CHECK(("people"."ownership_type"='site' AND "people"."owner_id" IS NULL) OR ("people"."ownership_type"='user' AND "people"."owner_id" IS NOT NULL)),
	CONSTRAINT "people_count_check" CHECK("people"."face_count">=0)
);

--> statement-breakpoint
CREATE UNIQUE INDEX `people_collection_id_unique` ON `people` (`collection_id`);
--> statement-breakpoint
CREATE INDEX `idx_people_name` ON `people` (`name`);
--> statement-breakpoint
CREATE INDEX `idx_people_partition` ON `people` (`ownership_type`,`owner_id`);
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
CREATE INDEX `idx_photo_embeddings_model` ON `photo_embeddings` (`model`);
--> statement-breakpoint
CREATE TABLE `photo_files` (
	`id` text PRIMARY KEY NOT NULL,
	`photo_id` text NOT NULL,
	`role` text NOT NULL,
	`original_filename` text,
	`upload_relative_path` text,
	`locator_type` text NOT NULL,
	`storage_provider_id` integer,
	`storage_key` text,
	`library_id` integer,
	`library_path` text,
	`parent_file_id` text,
	`byte_offset` integer,
	`byte_length` integer,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`checksum_sha256` text,
	`is_billable_original` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'ready' NOT NULL,
	`content_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`storage_provider_id`) REFERENCES `settings_storage_providers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_file_id`) REFERENCES `photo_files`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "photo_files_id_check" CHECK(length("photo_files"."id")=32 AND "photo_files"."id" NOT GLOB '*[^a-f0-9]*'),
	CONSTRAINT "photo_files_checksum_check" CHECK("photo_files"."checksum_sha256" IS NULL OR (length("photo_files"."checksum_sha256")=64 AND "photo_files"."checksum_sha256" NOT GLOB '*[^a-f0-9]*')),
	CONSTRAINT "photo_files_billable_check" CHECK("photo_files"."is_billable_original"=0 OR ("photo_files"."locator_type"='provider' AND "photo_files"."role" IN ('original','live_video') AND "photo_files"."upload_relative_path" IS NOT NULL AND "photo_files"."checksum_sha256" IS NOT NULL)),
	CONSTRAINT "photo_files_role_check" CHECK("photo_files"."role" IN ('original','preview','thumbnail','live_video','poster','sanitized_download')),
	CONSTRAINT "photo_files_state_check" CHECK("photo_files"."state" IN ('staging','ready','deleting','deleted')),
	CONSTRAINT "photo_files_size_check" CHECK("photo_files"."byte_size">=0 AND "photo_files"."content_version">=1),
	CONSTRAINT "photo_files_locator_check" CHECK(("photo_files"."locator_type"='provider' AND "photo_files"."storage_provider_id" IS NOT NULL AND "photo_files"."storage_key" IS NOT NULL AND "photo_files"."library_id" IS NULL AND "photo_files"."library_path" IS NULL AND "photo_files"."parent_file_id" IS NULL AND "photo_files"."byte_offset" IS NULL AND "photo_files"."byte_length" IS NULL) OR ("photo_files"."locator_type"='library' AND "photo_files"."library_id" IS NOT NULL AND "photo_files"."library_path" IS NOT NULL AND "photo_files"."storage_provider_id" IS NULL AND "photo_files"."storage_key" IS NULL AND "photo_files"."parent_file_id" IS NULL AND "photo_files"."byte_offset" IS NULL AND "photo_files"."byte_length" IS NULL) OR ("photo_files"."locator_type"='embedded' AND "photo_files"."parent_file_id" IS NOT NULL AND "photo_files"."byte_offset" IS NOT NULL AND "photo_files"."byte_length" IS NOT NULL AND "photo_files"."byte_offset">=0 AND "photo_files"."byte_length">0 AND "photo_files"."storage_provider_id" IS NULL AND "photo_files"."storage_key" IS NULL AND "photo_files"."library_id" IS NULL AND "photo_files"."library_path" IS NULL))
);

--> statement-breakpoint
CREATE UNIQUE INDEX `photo_files_role_unique` ON `photo_files` (`photo_id`,`role`);
--> statement-breakpoint
CREATE UNIQUE INDEX `photo_files_provider_key_unique` ON `photo_files` (`storage_provider_id`,`storage_key`) WHERE "photo_files"."locator_type"='provider' AND "photo_files"."state"!='deleted';
--> statement-breakpoint
CREATE UNIQUE INDEX `photo_files_library_path_unique` ON `photo_files` (`library_id`,`library_path`) WHERE "photo_files"."locator_type"='library' AND "photo_files"."state"!='deleted';
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
--> statement-breakpoint
CREATE TABLE `photo_ocr` (
	`photo_id` text PRIMARY KEY NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
CREATE TABLE `photo_ownership_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`photo_id` text,
	`photo_id_snapshot` text NOT NULL,
	`from_owner_id` integer NOT NULL,
	`to_owner_id` integer NOT NULL,
	`actor_user_id` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`source_acl_version` integer NOT NULL,
	`source_metadata_version` integer NOT NULL,
	`state` text DEFAULT 'preparing' NOT NULL,
	`reason` text NOT NULL,
	`original_acl_json` text NOT NULL,
	`expected_original_bytes` integer NOT NULL,
	`target_reserved_bytes` integer NOT NULL,
	`lease_token` text,
	`lease_epoch` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`error_code` text,
	`cutover_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`from_owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`to_owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "transfer_state_check" CHECK("photo_ownership_transfers"."state" IN ('preparing','copying','cutover','cleanup_pending','completed','rolling_back','failed')),
	CONSTRAINT "transfer_parties_check" CHECK("photo_ownership_transfers"."from_owner_id"!="photo_ownership_transfers"."to_owner_id"),
	CONSTRAINT "transfer_bytes_epoch_check" CHECK("photo_ownership_transfers"."expected_original_bytes">=0 AND "photo_ownership_transfers"."target_reserved_bytes">=0 AND "photo_ownership_transfers"."lease_epoch">=0)
);

--> statement-breakpoint
CREATE UNIQUE INDEX `ownership_transfer_idempotency_unique` ON `photo_ownership_transfers` (`actor_user_id`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ownership_transfer_active_unique` ON `photo_ownership_transfers` (`photo_id`) WHERE "photo_ownership_transfers"."state" NOT IN ('completed','failed');
--> statement-breakpoint
CREATE INDEX `idx_transfer_state` ON `photo_ownership_transfers` (`state`,`updated_at`);
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
CREATE UNIQUE INDEX `photo_reactions_photo_fingerprint_unique` ON `photo_reactions` (`photo_id`,`fingerprint`);
--> statement-breakpoint
CREATE INDEX `idx_photo_reactions_photo_type` ON `photo_reactions` (`photo_id`,`reaction_type`);
--> statement-breakpoint
CREATE INDEX `idx_photo_reactions_fingerprint_created` ON `photo_reactions` (`fingerprint`,`created_at`);
--> statement-breakpoint
CREATE TABLE `photo_shares` (
	`photo_id` text NOT NULL,
	`recipient_user_id` integer NOT NULL,
	`granted_by` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`photo_id`, `recipient_user_id`),
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);

--> statement-breakpoint
CREATE INDEX `idx_shares_recipient` ON `photo_shares` (`recipient_user_id`,`photo_id`);
--> statement-breakpoint
CREATE TABLE `photo_transfer_files` (
	`id` text PRIMARY KEY NOT NULL,
	`transfer_id` text NOT NULL,
	`file_id` text NOT NULL,
	`role` text NOT NULL,
	`source_content_version` integer NOT NULL,
	`locator_type` text NOT NULL,
	`storage_provider_id` integer,
	`source_key` text,
	`target_key` text,
	`parent_file_id` text,
	`byte_offset` integer,
	`byte_length` integer,
	`byte_size` integer NOT NULL,
	`checksum_sha256` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`source_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `photo_ownership_transfers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`storage_provider_id`) REFERENCES `settings_storage_providers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "transfer_file_locator_check" CHECK(("photo_transfer_files"."locator_type"='provider' AND "photo_transfer_files"."storage_provider_id" IS NOT NULL AND "photo_transfer_files"."source_key" IS NOT NULL AND "photo_transfer_files"."target_key" IS NOT NULL AND "photo_transfer_files"."parent_file_id" IS NULL) OR ("photo_transfer_files"."locator_type"='embedded' AND "photo_transfer_files"."storage_provider_id" IS NULL AND "photo_transfer_files"."source_key" IS NULL AND "photo_transfer_files"."target_key" IS NULL AND "photo_transfer_files"."parent_file_id" IS NOT NULL AND "photo_transfer_files"."byte_offset" IS NOT NULL AND "photo_transfer_files"."byte_length" IS NOT NULL AND "photo_transfer_files"."byte_offset">=0 AND "photo_transfer_files"."byte_length">0))
);

--> statement-breakpoint
CREATE UNIQUE INDEX `transfer_file_unique` ON `photo_transfer_files` (`transfer_id`,`file_id`);
--> statement-breakpoint
CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`ownership_type` text DEFAULT 'site' NOT NULL,
	`owner_id` integer,
	`uploaded_by` integer,
	`visibility` text DEFAULT 'inherit' NOT NULL,
	`processing_status` text DEFAULT 'ready' NOT NULL,
	`processing_error_code` text,
	`transfer_state` text DEFAULT 'idle' NOT NULL,
	`active_transfer_id` text,
	`moderation_status` text DEFAULT 'visible' NOT NULL,
	`moderation_reason` text,
	`acl_version` integer DEFAULT 1 NOT NULL,
	`metadata_version` integer DEFAULT 1 NOT NULL,
	`original_filename` text,
	`upload_relative_path` text,
	`storage_relative_path` text,
	`preserve_original` integer DEFAULT true NOT NULL,
	`strip_location` integer DEFAULT false NOT NULL,
	`original_bytes` integer DEFAULT 0 NOT NULL,
	`content_checksum` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`title` text,
	`description` text,
	`width` integer,
	`height` integer,
	`aspect_ratio` real,
	`date_taken` text,
	`file_size` integer,
	`last_modified` text,
	`thumbnail_hash` text,
	`tags` text,
	`exif` text,
	`latitude` real,
	`longitude` real,
	`country` text,
	`city` text,
	`location_name` text,
	`is_live_photo` integer DEFAULT 0 NOT NULL,
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
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "photos_ownership_check" CHECK(("photos"."ownership_type"='site' AND "photos"."owner_id" IS NULL AND "photos"."visibility"='inherit') OR ("photos"."ownership_type"='user' AND "photos"."owner_id" IS NOT NULL AND "photos"."visibility" IN ('private','public','shared'))),
	CONSTRAINT "photos_personal_source_check" CHECK("photos"."ownership_type"!='user' OR ("photos"."source"='upload' AND "photos"."library_id" IS NULL AND "photos"."library_mount" IS NULL AND "photos"."library_path" IS NULL AND "photos"."preserve_original"=1)),
	CONSTRAINT "photos_processing_check" CHECK("photos"."processing_status" IN ('uploading','processing','ready','failed','purging')),
	CONSTRAINT "photos_transfer_check" CHECK("photos"."transfer_state" IN ('idle','moving','cleanup_pending')),
	CONSTRAINT "photos_moderation_check" CHECK("photos"."moderation_status" IN ('visible','blocked')),
	CONSTRAINT "photos_versions_bytes_check" CHECK("photos"."original_bytes" >= 0 AND "photos"."acl_version" >= 1 AND "photos"."metadata_version" >= 1),
	CONSTRAINT "photos_latitude_check" CHECK("photos"."latitude" IS NULL OR ("photos"."latitude" >= -90 AND "photos"."latitude" <= 90)),
	CONSTRAINT "photos_longitude_check" CHECK("photos"."longitude" IS NULL OR ("photos"."longitude" >= -180 AND "photos"."longitude" <= 180))
);

--> statement-breakpoint
CREATE INDEX `idx_photos_owner_created` ON `photos` (`owner_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_photos_owner_deleted` ON `photos` (`owner_id`,`deleted_at`);
--> statement-breakpoint
CREATE INDEX `idx_photos_gallery_order` ON `photos` ("date_taken" DESC,"id" ASC) WHERE "photos"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_photos_geo_timeline` ON `photos` ("date_taken" ASC,"id" ASC) WHERE "photos"."deleted_at" IS NULL AND "photos"."latitude" IS NOT NULL AND "photos"."longitude" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_photos_library_path` ON `photos` (`library_id`,`library_path`);
--> statement-breakpoint
CREATE INDEX `idx_photos_library_deleted` ON `photos` (`library_id`,`deleted_at`);
--> statement-breakpoint
CREATE INDEX `idx_photos_mount_path` ON `photos` (`library_mount`,`library_path`);
--> statement-breakpoint
CREATE TABLE `pipeline_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payload` text DEFAULT '{"type":"photo","photoId":""}' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`photo_id` text,
	`upload_session_id` text,
	`dedupe_key` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_stage` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`upload_session_id`) REFERENCES `upload_sessions`(`id`) ON UPDATE no action ON DELETE set null
);

--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pipeline_active_dedupe` ON `pipeline_queue` (`dedupe_key`) WHERE "pipeline_queue"."status" IN ('pending','in-stages');
--> statement-breakpoint
CREATE INDEX `idx_pipeline_queue_pending` ON `pipeline_queue` (`status`,"priority" DESC,"created_at" ASC);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_queue_photo_status` ON `pipeline_queue` (`photo_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_queue_upload_status` ON `pipeline_queue` (`upload_session_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_queue_status_completed` ON `pipeline_queue` (`status`,`completed_at`);
--> statement-breakpoint
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
CREATE UNIQUE INDEX `idx_namespace_key` ON `settings` (`namespace`,`key`);
--> statement-breakpoint
CREATE TABLE `settings_storage_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);

--> statement-breakpoint
CREATE TABLE `storage_path_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`storage_provider_id` integer NOT NULL,
	`storage_key_normalized` text NOT NULL,
	`holder_type` text NOT NULL,
	`holder_id` text NOT NULL,
	FOREIGN KEY (`storage_provider_id`) REFERENCES `settings_storage_providers`(`id`) ON UPDATE no action ON DELETE restrict
);

--> statement-breakpoint
CREATE UNIQUE INDEX `storage_claim_key_unique` ON `storage_path_claims` (`storage_provider_id`,`storage_key_normalized`);
--> statement-breakpoint
CREATE INDEX `idx_storage_claim_holder` ON `storage_path_claims` (`holder_type`,`holder_id`);
--> statement-breakpoint
CREATE TABLE `upload_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`original_filename` text NOT NULL,
	`upload_relative_path` text NOT NULL,
	`declared_mime` text NOT NULL,
	`expected_bytes` integer NOT NULL,
	`received_bytes` integer DEFAULT 0 NOT NULL,
	`staging_key` text NOT NULL,
	`final_key` text NOT NULL,
	`detected_mime` text,
	`checksum_sha256` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `upload_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "upload_parts_role_check" CHECK("upload_parts"."role" IN ('original','live_video')),
	CONSTRAINT "upload_parts_state_check" CHECK("upload_parts"."state" IN ('pending','receiving','uploaded','validated','promoted','rejected','deleted')),
	CONSTRAINT "upload_parts_size_check" CHECK("upload_parts"."expected_bytes">0 AND "upload_parts"."received_bytes">=0)
);

--> statement-breakpoint
CREATE UNIQUE INDEX `upload_parts_role_unique` ON `upload_parts` (`session_id`,`role`);
--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` integer NOT NULL,
	`owner_user_id` integer,
	`photo_id` text,
	`photo_id_snapshot` text NOT NULL,
	`storage_provider_id` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`state` text DEFAULT 'created' NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`commit_task_id` integer,
	`staging_cleaned_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`storage_provider_id`) REFERENCES `settings_storage_providers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "upload_sessions_state_check" CHECK("upload_sessions"."state" IN ('created','uploading','finalizing','committed','cancelled','expired')),
	CONSTRAINT "upload_sessions_reserved_check" CHECK("upload_sessions"."reserved_bytes">=0)
);

--> statement-breakpoint
CREATE UNIQUE INDEX `upload_sessions_photo_id_unique` ON `upload_sessions` (`photo_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `upload_sessions_photo_id_snapshot_unique` ON `upload_sessions` (`photo_id_snapshot`);
--> statement-breakpoint
CREATE UNIQUE INDEX `upload_sessions_idempotency_unique` ON `upload_sessions` (`actor_user_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_upload_sessions_expiry` ON `upload_sessions` (`state`,`expires_at`);
--> statement-breakpoint
CREATE TABLE `user_deletion_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`actor_user_id` integer NOT NULL,
	`mode` text NOT NULL,
	`target_user_id` integer,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`reason` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`error_code` text,
	`lease_token` text,
	`lease_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "user_deletion_state_check" CHECK("user_deletion_tasks"."state" IN ('pending','running','failed','completed')),
	CONSTRAINT "user_deletion_mode_check" CHECK(("user_deletion_tasks"."mode"='purge' AND "user_deletion_tasks"."target_user_id" IS NULL) OR ("user_deletion_tasks"."mode"='transfer' AND "user_deletion_tasks"."target_user_id" IS NOT NULL AND "user_deletion_tasks"."target_user_id"!="user_deletion_tasks"."user_id"))
);

--> statement-breakpoint
CREATE UNIQUE INDEX `user_deletion_idempotency_unique` ON `user_deletion_tasks` (`actor_user_id`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_deletion_active_unique` ON `user_deletion_tasks` (`user_id`) WHERE "user_deletion_tasks"."state"!='completed';
--> statement-breakpoint
CREATE TABLE `user_storage_usage` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`used_bytes` integer DEFAULT 0 NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "usage_nonnegative_check" CHECK("user_storage_usage"."used_bytes" >= 0 AND "user_storage_usage"."reserved_bytes" >= 0)
);

--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`username_key` text NOT NULL,
	`display_name` text NOT NULL,
	`email` text NOT NULL,
	`email_key` text NOT NULL,
	`password_hash` text,
	`avatar` text,
	`created_at` integer NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`can_upload` integer DEFAULT true NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`auth_version` integer DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`storage_quota_bytes` integer DEFAULT 21474836480,
	`created_by` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`disabled_at` integer,
	`deleted_at` integer,
	`totp_secret` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "users_identity_check" CHECK("users"."username" = "users"."username_key" AND "users"."email" = "users"."email_key"),
	CONSTRAINT "users_username_check" CHECK(length("users"."username") BETWEEN 3 AND 32 AND "users"."username" GLOB '[a-z]*' AND "users"."username" NOT GLOB '*[^a-z0-9_-]*' AND "users"."username" NOT IN ('con','prn','aux','nul','com1','com2','com3','com4','com5','com6','com7','com8','com9','lpt1','lpt2','lpt3','lpt4','lpt5','lpt6','lpt7','lpt8','lpt9')),
	CONSTRAINT "users_email_normalized_check" CHECK("users"."email"=lower(trim("users"."email"))),
	CONSTRAINT "users_role_check" CHECK("users"."role" IN ('admin','user')),
	CONSTRAINT "users_status_check" CHECK("users"."status" IN ('active','disabled','deleting','deleted')),
	CONSTRAINT "users_versions_check" CHECK("users"."auth_version" >= 1 AND "users"."version" >= 1),
	CONSTRAINT "users_quota_check" CHECK("users"."storage_quota_bytes" IS NULL OR "users"."storage_quota_bytes" >= 0)
);

--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_key_unique` ON `users` (`username_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_key_unique` ON `users` (`email_key`);
--> statement-breakpoint
CREATE INDEX `idx_users_status_role` ON `users` (`status`,`role`);
--> statement-breakpoint
-- Drizzle does not model FTS virtual tables or cross-table constraints.
CREATE VIRTUAL TABLE IF NOT EXISTS photo_ocr_fts USING fts5(photo_id UNINDEXED, text);
--> statement-breakpoint
CREATE TRIGGER users_username_immutable BEFORE UPDATE OF username,username_key ON users
WHEN NEW.username<>OLD.username OR NEW.username_key<>OLD.username_key
BEGIN SELECT RAISE(ABORT,'Username is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER faces_partition_insert BEFORE INSERT ON asset_faces
WHEN NEW.person_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM photos a JOIN people p ON p.id=NEW.person_id
  WHERE a.id=NEW.photo_id AND a.ownership_type=p.ownership_type AND a.owner_id IS p.owner_id
)
BEGIN SELECT RAISE(ABORT,'Face partition mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER faces_partition_update BEFORE UPDATE OF person_id,photo_id ON asset_faces
WHEN NEW.person_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM photos a JOIN people p ON p.id=NEW.person_id
  WHERE a.id=NEW.photo_id AND a.ownership_type=p.ownership_type AND a.owner_id IS p.owner_id
)
BEGIN SELECT RAISE(ABORT,'Face partition mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER photos_partition_update BEFORE UPDATE OF owner_id,ownership_type ON photos
WHEN EXISTS (SELECT 1 FROM asset_faces f JOIN people p ON p.id=f.person_id
  WHERE f.photo_id=NEW.id AND (p.ownership_type<>NEW.ownership_type OR p.owner_id IS NOT NEW.owner_id))
BEGIN SELECT RAISE(ABORT,'Remove previous face associations before transferring ownership'); END;
--> statement-breakpoint
CREATE TRIGGER people_collection_insert BEFORE INSERT ON people
WHEN NEW.collection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM collections c
  WHERE c.id=NEW.collection_id AND c.kind='person' AND c.ownership_type=NEW.ownership_type AND c.owner_id IS NEW.owner_id)
BEGIN SELECT RAISE(ABORT,'Person collection partition mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER people_collection_update BEFORE UPDATE OF collection_id,owner_id,ownership_type ON people
WHEN (NEW.collection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM collections c
  WHERE c.id=NEW.collection_id AND c.kind='person' AND c.ownership_type=NEW.ownership_type AND c.owner_id IS NEW.owner_id))
  OR EXISTS (SELECT 1 FROM asset_faces f JOIN photos a ON a.id=f.photo_id
    WHERE f.person_id=NEW.id AND (a.ownership_type<>NEW.ownership_type OR a.owner_id IS NOT NEW.owner_id))
BEGIN SELECT RAISE(ABORT,'Person partition mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER embedded_file_insert BEFORE INSERT ON photo_files
WHEN NEW.locator_type='embedded' AND NOT EXISTS(SELECT 1 FROM photo_files p
  WHERE p.id=NEW.parent_file_id AND p.photo_id=NEW.photo_id AND p.role='original' AND p.locator_type<>'embedded'
    AND NEW.byte_offset+NEW.byte_length<=p.byte_size)
BEGIN SELECT RAISE(ABORT,'Invalid embedded file parent or bounds'); END;
--> statement-breakpoint
CREATE TRIGGER embedded_file_update BEFORE UPDATE OF locator_type,parent_file_id,byte_offset,byte_length,photo_id ON photo_files
WHEN NEW.locator_type='embedded' AND NOT EXISTS(SELECT 1 FROM photo_files p
  WHERE p.id=NEW.parent_file_id AND p.photo_id=NEW.photo_id AND p.role='original' AND p.locator_type<>'embedded'
    AND NEW.byte_offset+NEW.byte_length<=p.byte_size)
BEGIN SELECT RAISE(ABORT,'Invalid embedded file parent or bounds'); END;
--> statement-breakpoint
CREATE TRIGGER manual_membership_insert BEFORE INSERT ON collection_photos
WHEN NOT EXISTS(SELECT 1 FROM collections c WHERE c.id=NEW.collection_id AND c.kind='manual')
BEGIN SELECT RAISE(ABORT,'Only manual albums use explicit membership'); END;
--> statement-breakpoint
CREATE TRIGGER manual_membership_added AFTER INSERT ON collection_photos
BEGIN UPDATE collections SET acl_version=acl_version+1,updated_at=unixepoch() WHERE id=NEW.collection_id; END;
--> statement-breakpoint
CREATE TRIGGER manual_membership_removed AFTER DELETE ON collection_photos
BEGIN UPDATE collections SET acl_version=acl_version+1,updated_at=unixepoch() WHERE id=OLD.collection_id; END;
--> statement-breakpoint
CREATE TRIGGER face_membership_added AFTER INSERT ON asset_faces WHEN NEW.person_id IS NOT NULL
BEGIN UPDATE collections SET acl_version=acl_version+1,updated_at=unixepoch() WHERE id=(SELECT collection_id FROM people WHERE id=NEW.person_id); END;
--> statement-breakpoint
CREATE TRIGGER face_membership_removed AFTER DELETE ON asset_faces WHEN OLD.person_id IS NOT NULL
BEGIN UPDATE collections SET acl_version=acl_version+1,updated_at=unixepoch() WHERE id=(SELECT collection_id FROM people WHERE id=OLD.person_id); END;
--> statement-breakpoint
CREATE TRIGGER face_membership_changed AFTER UPDATE OF person_id ON asset_faces WHEN NEW.person_id IS NOT OLD.person_id
BEGIN UPDATE collections SET acl_version=acl_version+1,updated_at=unixepoch() WHERE id IN(SELECT collection_id FROM people WHERE id IN(NEW.person_id,OLD.person_id)); END;
--> statement-breakpoint
CREATE TRIGGER folder_hierarchy_changed AFTER UPDATE OF parent_id,rel_path ON collections
WHEN NEW.parent_id IS NOT OLD.parent_id OR NEW.rel_path<>OLD.rel_path
BEGIN UPDATE collections SET acl_version=acl_version+1,updated_at=unixepoch() WHERE id=NEW.id; END;
