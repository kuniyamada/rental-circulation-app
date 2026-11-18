-- 申請者による引き戻し（回覧中の申請を申請者が自分の手元に戻す）
ALTER TABLE applications ADD COLUMN recalled_at TEXT;
