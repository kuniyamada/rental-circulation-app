-- 差し戻し機能追加マイグレーション

-- applications テーブルに差し戻し関連カラム追加
ALTER TABLE applications ADD COLUMN returned_reason TEXT;        -- 差し戻し理由
ALTER TABLE applications ADD COLUMN reapply_reason TEXT;         -- 再申請理由
ALTER TABLE applications ADD COLUMN returned_from_step INTEGER;  -- どのステップから差し戻されたか
ALTER TABLE applications ADD COLUMN returned_by_id INTEGER;      -- 差し戻した人のID

-- circulation_steps の status に 'returned' を追加（SQLiteはCHECK制約の変更不可のため、既存データはそのまま）
-- status: pending / approved / on_hold / rejected / returned

-- notification_logs の notification_type に 'returned' / 'reapplied' を追加（同上）
