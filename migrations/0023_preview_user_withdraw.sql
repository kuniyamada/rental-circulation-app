-- 個人名プレビュー（管理者が特定の人として画面を見る・見るだけ）
ALTER TABLE sessions ADD COLUMN preview_user_id INTEGER;
-- 申請の取り下げ（差し戻し・否決のまま再申請しない申請を、申請者本人が取り下げる）
ALTER TABLE applications ADD COLUMN withdrawn_at DATETIME;
ALTER TABLE applications ADD COLUMN withdrawn_by INTEGER;
