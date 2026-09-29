ALTER TABLE `scan_libraries` ADD `show_in_gallery` integer DEFAULT 1 NOT NULL;
-- 旧数据 as_album=1 表示只在相册页展示、首页瀑布流隐藏
UPDATE `scan_libraries` SET `show_in_gallery` = 0 WHERE `as_album` = 1;