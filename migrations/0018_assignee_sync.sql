-- 物件担当マスタ（一元管理システム）からの担当者同期の状態
CREATE TABLE IF NOT EXISTS assignee_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_status TEXT,          -- 'ok' | 'error'
  last_message TEXT,
  master_updated_at TEXT,
  last_changed_count INTEGER DEFAULT 0,
  last_warnings TEXT         -- JSON配列
);
INSERT OR IGNORE INTO assignee_sync_state (id) VALUES (1);

-- 同期で実際に変わった担当者の履歴
CREATE TABLE IF NOT EXISTS assignee_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at TEXT DEFAULT (datetime('now')),
  mansion_id INTEGER,
  mansion_number INTEGER,
  field TEXT,
  old_user_id INTEGER,
  new_user_id INTEGER,
  old_name TEXT,
  new_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_assignee_sync_log_at ON assignee_sync_log(synced_at);
