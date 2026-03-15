-- mansionsテーブルに管理組合番号カラムを追加
ALTER TABLE mansions ADD COLUMN mansion_number INTEGER;

-- 既存データ：idの値をmansion_numberにコピー
UPDATE mansions SET mansion_number = id;
