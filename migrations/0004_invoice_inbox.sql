-- ============================================================
-- 請求書受付テーブル（業務管理課が業者からの請求書を登録）
-- ============================================================
CREATE TABLE IF NOT EXISTS invoice_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mansion_id INTEGER NOT NULL,               -- マンションID
  front_user_id INTEGER NOT NULL,            -- 担当フロントID
  registered_by INTEGER NOT NULL,            -- 登録者（業務管理課）
  attachment_key TEXT,                        -- R2ファイルキー
  attachment_name TEXT,                       -- 元ファイル名
  note TEXT,                                  -- 備考
  status TEXT NOT NULL DEFAULT 'pending',     -- pending / applied / cancelled
  application_id INTEGER,                     -- 回覧申請ID（申請後に紐付け）
  notified_at DATETIME,                       -- 初回通知日時
  remind_count INTEGER NOT NULL DEFAULT 0,    -- リマインド送信回数
  last_reminded_at DATETIME,                  -- 最後にリマインドした日時
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mansion_id) REFERENCES mansions(id),
  FOREIGN KEY (front_user_id) REFERENCES users(id),
  FOREIGN KEY (registered_by) REFERENCES users(id)
);

-- ============================================================
-- リマインダー設定テーブル（管理者が日数・回数を設定）
-- ============================================================
CREATE TABLE IF NOT EXISTS reminder_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  remind_interval_days INTEGER NOT NULL DEFAULT 3,  -- 何日ごとにリマインド
  remind_max_count INTEGER NOT NULL DEFAULT 3,       -- 最大リマインド回数
  is_active INTEGER NOT NULL DEFAULT 1,              -- 有効/無効
  updated_by INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- デフォルト設定を挿入
INSERT OR IGNORE INTO reminder_settings (id, remind_interval_days, remind_max_count, is_active)
VALUES (1, 3, 3, 1);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_invoice_inbox_status ON invoice_inbox(status);
CREATE INDEX IF NOT EXISTS idx_invoice_inbox_front_user ON invoice_inbox(front_user_id);
CREATE INDEX IF NOT EXISTS idx_invoice_inbox_mansion ON invoice_inbox(mansion_id);
