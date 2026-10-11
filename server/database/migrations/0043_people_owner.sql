ALTER TABLE `people` ADD `owner_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_people_name` ON `people` (`name`);
