-- マンションマスタに「一覧表示/非表示」フラグを追加
--   is_visible = 1: 通常表示 (default)
--   is_visible = 0: 一覧から非表示 (使わなくなった物件の煩雑さ回避用)
--
-- 「非表示」は物理削除の代替:
--   - 過去申請と紐づいた物件を安全に一覧から消せる
--   - 復元も可能 (/admin/mansions/hidden から)
--   - 履歴データは完全に保持
--
-- 「無効化 (is_active=0)」との違い:
--   - 無効化: 一覧に残る、使用停止マーカー、業務的一時休止
--   - 非表示: 一覧から消える、使わないマスタを隠す
ALTER TABLE mansions ADD COLUMN is_visible INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_mansions_is_visible ON mansions(is_visible);
