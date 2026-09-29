ALTER TABLE `scan_libraries` ADD `show_in_gallery` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE `scan_libraries` SET `show_in_gallery` = 0 WHERE `as_album` = 1;
