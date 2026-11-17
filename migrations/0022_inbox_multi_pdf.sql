-- 請求書受付: PDFを最大3つまで（1つ目=attachment_key は請求書、2つ目・3つ目はその他資料として回覧申請へ引き継ぐ）
ALTER TABLE invoice_inbox ADD COLUMN attachment2_key TEXT;
ALTER TABLE invoice_inbox ADD COLUMN attachment2_name TEXT;
ALTER TABLE invoice_inbox ADD COLUMN attachment3_key TEXT;
ALTER TABLE invoice_inbox ADD COLUMN attachment3_name TEXT;
