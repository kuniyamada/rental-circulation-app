-- ログイン履歴（ログイン / ログアウト / ログイン失敗 / 時間切れ）
CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,          -- login / logout / failed / expired
  user_id INTEGER,                   -- 失敗時（社員番号不明）は NULL
  employee_number TEXT,
  user_name TEXT,
  failure_reason TEXT,
  ip_address TEXT,
  user_agent TEXT,
  device TEXT,                       -- 例: Windows / Edge
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP  -- UTC
);

CREATE INDEX IF NOT EXISTS idx_login_logs_created_at ON login_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_login_logs_event_type ON login_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_login_logs_employee_number ON login_logs(employee_number);

-- 既存の期限切れセッションは履歴に載せずに整理
DELETE FROM sessions WHERE expires_at <= datetime('now');
