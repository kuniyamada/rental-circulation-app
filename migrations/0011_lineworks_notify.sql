-- LINE WORKS通知機能用カラム追加
ALTER TABLE users ADD COLUMN lineworks_user_id TEXT;
ALTER TABLE users ADD COLUMN notify_method TEXT NOT NULL DEFAULT 'email';
-- notify_method: 'email' | 'lineworks' | 'both'

-- LINE WORKS設定テーブル
CREATE TABLE IF NOT EXISTS lineworks_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  service_account TEXT NOT NULL,
  private_key TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
