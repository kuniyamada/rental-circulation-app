-- 0012_test_mode.sql
-- テストモード機能: 管理者が自分の申請だけをテストモードで実行できる

-- users テーブル: テストモード有効フラグ（0=通常, 1=テスト中）
ALTER TABLE users ADD COLUMN test_mode INTEGER NOT NULL DEFAULT 0;

-- applications テーブル: テスト申請フラグ（申請作成時のユーザーのtest_modeを引き継ぐ）
ALTER TABLE applications ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
