-- 最終承認者（会計課・本社経理）の承認メモ（例：11月計上／12月払）
ALTER TABLE circulation_steps ADD COLUMN approval_memo TEXT;
ALTER TABLE circulation_steps ADD COLUMN memo_updated_at DATETIME;
