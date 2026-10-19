ALTER TABLE `people` ADD `visibility` text DEFAULT 'public' NOT NULL;
--> statement-breakpoint
UPDATE `people` SET `visibility` = 'admin' WHERE `is_hidden` = 1;
