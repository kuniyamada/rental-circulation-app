-- 承認者リマインド機能追加

-- circulation_steps に リマインド管理カラムを追加
ALTER TABLE circulation_steps ADD COLUMN remind_count INTEGER DEFAULT 0;
ALTER TABLE circulation_steps ADD COLUMN last_reminded_at DATETIME;

-- reminder_settings に 承認リマインド設定カラムを追加
ALTER TABLE reminder_settings ADD COLUMN review_remind_interval_days INTEGER DEFAULT 2;
ALTER TABLE reminder_settings ADD COLUMN review_remind_max_count INTEGER DEFAULT 3;
ALTER TABLE reminder_settings ADD COLUMN review_remind_is_active INTEGER DEFAULT 1;
