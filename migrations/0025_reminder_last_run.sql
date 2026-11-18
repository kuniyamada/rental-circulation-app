-- 自動リマインド（毎朝8時）の最終実行結果を記録
ALTER TABLE reminder_settings ADD COLUMN last_run_at TEXT;
ALTER TABLE reminder_settings ADD COLUMN last_run_result TEXT;
