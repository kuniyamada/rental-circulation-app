-- 通知履歴（メール / LINE WORKS の送信結果）
-- 申請・受付を削除しても壊れないよう外部キーは付けない
CREATE TABLE IF NOT EXISTS notify_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notification_type TEXT NOT NULL,
  channel TEXT NOT NULL,              -- email / lineworks
  recipient_id INTEGER,
  recipient_name TEXT,
  to_address TEXT,
  subject TEXT,
  status TEXT NOT NULL,               -- sent / failed / skipped
  error TEXT,
  application_id INTEGER,
  inbox_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notify_logs_inbox ON notify_logs(inbox_id);
CREATE INDEX IF NOT EXISTS idx_notify_logs_app ON notify_logs(application_id);
CREATE INDEX IF NOT EXISTS idx_notify_logs_created ON notify_logs(created_at);
