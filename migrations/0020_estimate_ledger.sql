-- 見積書・請求書作成 管理簿
--   元請（会社(TD)元請）の回覧で、業務管理課(Step2)承認時に見積書を指定のGoogleドライブへ自動保存し、1行追加する
--   状態: saved(見積保存済・請求書未作成) → invoiced(請求書作成済) → sent(登録・送信済)
CREATE TABLE IF NOT EXISTS estimate_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,         -- 最新の申請（差し戻し再申請で同じ見積書なら付け替え）
  attachment_id INTEGER,
  r2_key TEXT UNIQUE NOT NULL,             -- 見積書のR2キー（同じ見積書の二重登録防止）
  mansion_id INTEGER,
  mansion_number INTEGER,
  mansion_name TEXT,
  applicant_id INTEGER,
  original_file_name TEXT,
  drive_file_name TEXT,
  drive_file_id TEXT,
  drive_file_url TEXT,
  drive_status TEXT NOT NULL DEFAULT 'pending',  -- pending / success / failed / skipped
  drive_error TEXT,
  status TEXT NOT NULL DEFAULT 'saved',          -- saved / invoiced / sent
  invoiced_at DATETIME,
  invoiced_by INTEGER,
  inbox_id INTEGER,                              -- 請求書登録（invoice_inbox）との紐付け
  sent_at DATETIME,
  is_test INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_estimate_ledger_status ON estimate_ledger(status);
CREATE INDEX IF NOT EXISTS idx_estimate_ledger_app ON estimate_ledger(application_id);
CREATE INDEX IF NOT EXISTS idx_estimate_ledger_inbox ON estimate_ledger(inbox_id);
