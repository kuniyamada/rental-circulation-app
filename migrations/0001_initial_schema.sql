-- ユーザーテーブル
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_number TEXT UNIQUE NOT NULL,       -- 社員番号
  name TEXT NOT NULL,                          -- 氏名
  email TEXT NOT NULL,                         -- メールアドレス
  department TEXT,                             -- 部署
  role TEXT NOT NULL DEFAULT 'front',          -- front / manager / operations / accounting / honsha / admin
  is_admin INTEGER NOT NULL DEFAULT 0,         -- 管理者フラグ
  supervisor_id INTEGER,                       -- 直属上長ID
  is_active INTEGER NOT NULL DEFAULT 1,        -- 有効フラグ
  password_hash TEXT NOT NULL,                 -- パスワードハッシュ
  must_change_password INTEGER NOT NULL DEFAULT 1, -- 初回PW変更フラグ
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supervisor_id) REFERENCES users(id)
);

-- マンションテーブル
CREATE TABLE IF NOT EXISTS mansions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                          -- マンション名
  front_user_id INTEGER,                       -- 担当フロントID
  accounting_user_id INTEGER,                  -- 管理組合会計担当者ID
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (front_user_id) REFERENCES users(id),
  FOREIGN KEY (accounting_user_id) REFERENCES users(id)
);

-- 申請テーブル
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_number TEXT UNIQUE NOT NULL,     -- 申請番号（年度+連番）
  title TEXT NOT NULL,                         -- 標題（マンション名）
  mansion_id INTEGER,                          -- マンションID
  applicant_id INTEGER NOT NULL,               -- 申請者ID
  circulation_start_date DATE NOT NULL,        -- 回覧開始日
  payment_target TEXT NOT NULL,                -- 支払先: 'kumiai' or 'td'
  account_item TEXT,                           -- 勘定科目（支払先=組合の場合）
  td_type TEXT,                                -- TDの場合: 'ittaku' or 'motouke'
  kumiai_amount INTEGER,                       -- 管理組合への請求金額（元請の場合）
  budget_amount INTEGER NOT NULL,              -- 予算料（円）
  commission_rate REAL,                        -- 手数料（%）キックバック
  remarks TEXT,                                -- 備考
  status TEXT NOT NULL DEFAULT 'draft',        -- draft/circulating/approved/rejected/on_hold/completed
  current_step INTEGER NOT NULL DEFAULT 1,     -- 現在のステップ（1〜4）
  resubmit_count INTEGER NOT NULL DEFAULT 0,   -- 再提出回数
  original_application_id INTEGER,             -- 元申請ID（再提出の場合）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (applicant_id) REFERENCES users(id),
  FOREIGN KEY (mansion_id) REFERENCES mansions(id),
  FOREIGN KEY (original_application_id) REFERENCES applications(id)
);

-- 添付ファイルテーブル
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  file_type TEXT NOT NULL,                     -- 'invoice1','invoice2','other1','other2'
  file_name TEXT NOT NULL,
  file_key TEXT NOT NULL,                      -- R2のオブジェクトキー
  file_size INTEGER,
  mime_type TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (application_id) REFERENCES applications(id)
);

-- 回覧ステップテーブル
CREATE TABLE IF NOT EXISTS circulation_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  step_number INTEGER NOT NULL,                -- 1:上長, 2:業務管理課, 3:組合会計/本社経理
  reviewer_id INTEGER NOT NULL,                -- レビュー担当者ID
  status TEXT NOT NULL DEFAULT 'pending',      -- pending/approved/rejected/on_hold
  action_comment TEXT,                         -- 差し戻し理由・保留質問
  hold_answer TEXT,                            -- 保留の回答
  acted_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (application_id) REFERENCES applications(id),
  FOREIGN KEY (reviewer_id) REFERENCES users(id)
);

-- 通知ログテーブル
CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  notification_type TEXT NOT NULL,             -- 'review_request','rejected','approved','on_hold','answered','completed'
  email_to TEXT NOT NULL,
  subject TEXT NOT NULL,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'sent',         -- sent/failed
  error_message TEXT,
  FOREIGN KEY (application_id) REFERENCES applications(id),
  FOREIGN KEY (recipient_id) REFERENCES users(id)
);

-- SMTP設定テーブル
CREATE TABLE IF NOT EXISTS smtp_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 587,
  username TEXT,
  password TEXT,
  from_email TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '請求書回覧システム',
  use_tls INTEGER NOT NULL DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- セッションテーブル
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                         -- セッションID（UUID）
  user_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_applications_applicant ON applications(applicant_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_mansion ON applications(mansion_id);
CREATE INDEX IF NOT EXISTS idx_circulation_steps_application ON circulation_steps(application_id);
CREATE INDEX IF NOT EXISTS idx_circulation_steps_reviewer ON circulation_steps(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 業務管理課設定テーブル（担当1名＋予備1名）
CREATE TABLE IF NOT EXISTS operations_staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  is_primary INTEGER NOT NULL DEFAULT 1,       -- 1:担当, 0:予備
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 本社経理設定テーブル（1名）
CREATE TABLE IF NOT EXISTS honsha_staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
