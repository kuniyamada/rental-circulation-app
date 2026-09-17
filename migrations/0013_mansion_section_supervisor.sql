-- マンションマスタに「課」「上長」を追加
--   section:            物件が所属する課（"1課" / "2課" / "3課" の enum文字列）
--   supervisor_user_id: 上長（front_supervisor ロールのユーザーID）
--
-- 既存レコードはいずれも NULL 許容で追加し、Excel取り込みで埋める
ALTER TABLE mansions ADD COLUMN section TEXT;
ALTER TABLE mansions ADD COLUMN supervisor_user_id INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_mansions_section ON mansions(section);
CREATE INDEX IF NOT EXISTS idx_mansions_supervisor ON mansions(supervisor_user_id);
