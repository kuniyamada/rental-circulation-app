-- Google Drive 自動保存の記録テーブル
-- 業務管理課(Step2)承認時に添付ファイルをGoogle Driveへ自動保存した記録を保持
CREATE TABLE IF NOT EXISTS drive_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT UNIQUE NOT NULL,           -- 二重保存防止 例: 'app:123:invoice1'
  application_id INTEGER NOT NULL,           -- 対象申請
  attachment_id INTEGER,                     -- attachments.id (再試行時にR2キーを再取得できる)
  file_type TEXT NOT NULL,                   -- invoice1/invoice2/.../other1/other2/estimate/kumiai_invoice
  r2_key TEXT,                               -- R2の保存キー(再試行用)
  file_name TEXT NOT NULL,                   -- Drive上のファイル名
  folder_path TEXT NOT NULL,                 -- Drive上のフォルダパス(表示用) 例: '2026年/09月/558-ブレスド高輪'
  drive_file_id TEXT,                        -- 成功時のDrive上のファイルID
  drive_file_url TEXT,                       -- 成功時のDrive閲覧URL
  status TEXT NOT NULL DEFAULT 'pending',    -- pending / success / failed
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (application_id) REFERENCES applications(id),
  FOREIGN KEY (attachment_id) REFERENCES attachments(id)
);

CREATE INDEX IF NOT EXISTS idx_drive_uploads_status ON drive_uploads(status);
CREATE INDEX IF NOT EXISTS idx_drive_uploads_application_id ON drive_uploads(application_id);
CREATE INDEX IF NOT EXISTS idx_drive_uploads_created_at ON drive_uploads(created_at DESC);
