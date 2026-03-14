-- Gmail SMTP設定に更新
UPDATE smtp_settings
SET
  host       = 'smtp.gmail.com',
  port       = 587,
  username   = 'tokyo.defense.mail@gmail.com',
  password   = 'Td57421114',
  from_email = 'tokyo.defense.mail@gmail.com',
  from_name  = '請求書回覧システム（東京デファンス）',
  use_tls    = 1,
  updated_at = datetime('now')
WHERE id = 1;

-- レコードがない場合はINSERT
INSERT OR IGNORE INTO smtp_settings (host, port, username, password, from_email, from_name, use_tls)
VALUES (
  'smtp.gmail.com',
  587,
  'tokyo.defense.mail@gmail.com',
  'Td57421114',
  'tokyo.defense.mail@gmail.com',
  '請求書回覧システム（東京デファンス）',
  1
);
