-- 管理者の「役割プレビュー」用: セッションごとにプレビュー中の役割を保持（NULL=通常）
ALTER TABLE sessions ADD COLUMN preview_role TEXT;
