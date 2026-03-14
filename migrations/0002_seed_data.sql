-- 初期管理者ユーザー（社員番号: admin, PW: admin → SHA256ハッシュ）
-- パスワード "admin" のSHA256: 8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918
INSERT OR IGNORE INTO users (employee_number, name, email, department, role, is_admin, password_hash, must_change_password)
VALUES 
  ('admin', 'システム管理者', 'admin@example.co.jp', '管理部', 'admin', 1, '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', 0),
  ('U001', '山田 太郎', 'yamada@example.co.jp', '業務管理課', 'operations', 0, '7c9e2e24cfce2e4b2f5ef9d30d68d5adaa2e70bc9e05b2efcf4e7d78a3d5e5a2', 1),
  ('U002', '鈴木 花子', 'suzuki@example.co.jp', '業務管理課', 'operations', 0, '7c9e2e24cfce2e4b2f5ef9d30d68d5adaa2e70bc9e05b2efcf4e7d78a3d5e5a2', 1),
  ('U003', '田中 一郎', 'tanaka@example.co.jp', '本社', 'honsha', 0, '7c9e2e24cfce2e4b2f5ef9d30d68d5adaa2e70bc9e05b2efcf4e7d78a3d5e5a2', 1);

-- SMTPデフォルト設定
INSERT OR IGNORE INTO smtp_settings (host, port, from_email, from_name, use_tls)
VALUES ('localhost', 587, 'noreply@example.co.jp', '請求書回覧システム', 1);
