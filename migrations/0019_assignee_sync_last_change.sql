-- 担当者が実際に変わった直近の反映（自動／手動）を画面に出すための項目
ALTER TABLE assignee_sync_state ADD COLUMN last_change_at TEXT;
ALTER TABLE assignee_sync_state ADD COLUMN last_change_count INTEGER DEFAULT 0;
ALTER TABLE assignee_sync_state ADD COLUMN last_change_trigger TEXT; -- 'auto' | 'manual'
-- 既存の履歴から初期値を補完（1回目の反映: 画面表示時の自動反映）
UPDATE assignee_sync_state SET
  last_change_at = (SELECT replace(MAX(synced_at), ' ', 'T') || 'Z' FROM assignee_sync_log),
  last_change_count = (SELECT COUNT(*) FROM assignee_sync_log),
  last_change_trigger = 'auto'
WHERE id = 1 AND EXISTS (SELECT 1 FROM assignee_sync_log);
