ALTER TABLE `albums` ADD `visibility` text DEFAULT 'public' NOT NULL;
--> statement-breakpoint
UPDATE `albums` SET `visibility` = 'login' WHERE `is_hidden` = 1;
