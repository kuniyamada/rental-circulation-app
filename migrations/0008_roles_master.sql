-- 役割マスタテーブル
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  value TEXT UNIQUE NOT NULL,         -- システム内部値（front, front_supervisor, operations, ...）
  label TEXT NOT NULL,                -- 表示名（担当者, 担当者/上司, 業務管理課, ...）
  color TEXT NOT NULL DEFAULT 'blue', -- バッジ色（blue/orange/yellow/green/red/purple/gray）
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- デフォルト役割を登録
INSERT OR IGNORE INTO roles (value, label, color, sort_order) VALUES
  ('front',            '担当者',        'blue',   10),
  ('front_supervisor', '担当者/上司',   'indigo', 20),
  ('operations',       '業務管理課',    'orange', 30),
  ('accounting',       '会計課',        'yellow', 40),
  ('honsha',           '本社経理',      'green',  50),
  ('admin',            '管理者',        'red',    60);

-- usersテーブルにis_supervisorカラム追加
ALTER TABLE users ADD COLUMN is_supervisor INTEGER NOT NULL DEFAULT 0;

-- 既存ユーザーのうちsupervisor_idを持っている人を「上司」として設定（被参照側=上司）
UPDATE users SET is_supervisor = 1
WHERE id IN (SELECT DISTINCT supervisor_id FROM users WHERE supervisor_id IS NOT NULL);
