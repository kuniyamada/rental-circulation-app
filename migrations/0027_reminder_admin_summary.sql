-- 自動リマインドの後、管理者へまとめを送る
ALTER TABLE reminder_settings ADD COLUMN admin_summary_active INTEGER DEFAULT 1;
ALTER TABLE reminder_settings ADD COLUMN admin_summary_ids TEXT;   -- 送り先（ユーザーIDのJSON配列）。未設定なら管理者全員
