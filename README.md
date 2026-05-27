# Rental Circulation App

賃貸物件管理・回覧承認システム（社内向け業務アプリ）

## プロジェクト概要

- **名称**: rental-circulation-app
- **目的**: 賃貸物件に関する申請・回覧・承認・通知フローのデジタル化
- **技術スタック**: Hono + TypeScript + Cloudflare Pages + D1 + R2 + LINE WORKS / SMTP通知

## URL

- **本番環境**: https://webapp-production-exu.pages.dev
- **管理画面（ユーザー管理例）**: https://webapp-production-exu.pages.dev/admin/users
- **バックアップ管理画面**: https://webapp-production-exu.pages.dev/admin/backup
- **自動バックアップWorker**: https://webapp-backup-worker.kunihiro72.workers.dev
- **GitHub**: https://github.com/kuniyamada/rental-circulation-app
- **Cloudflare Dashboard**: https://dash.cloudflare.com/c6906c5ad653b9d7add12b9906a5d713/pages/view/webapp-production

## データアーキテクチャ

- **データストア**: Cloudflare D1 (`webapp-production`, ID: `721e8a4d-a790-4a5d-aeb0-dfc8dd09fec8`)
- **添付ファイル**: Cloudflare R2 (`webapp-attachments`)
- **主要テーブル（15テーブル）**: `users`, `mansions`, `applications`, `attachments`, `circulation_steps`, `notification_logs`, `smtp_settings`, `sessions`, `operations_staff`, `honsha_staff`, `invoice_inbox`, `reminder_settings`, `roles`, `lineworks_config`, `d1_migrations`
- **認証**: セッションベース（`sessions` テーブル）
- **通知**: LINE WORKS Bot + SMTP メール

## デプロイ

```bash
npm run build
npx wrangler pages deploy dist --project-name webapp-production
```

ブランチ: `main`（production branch）

---

## 🗄️ バックアップ & 復元

### 自動バックアップ（運用中）

| 項目 | 設定 |
|---|---|
| **実行スケジュール** | 毎日 AM 2:00 (JST) |
| **実行担当** | `webapp-backup-worker` (Cloudflare Worker, Cron Trigger) |
| **保存先** | R2バケット `webapp-attachments/backups/` |
| **保持件数** | 最新 **30件**（古い自動バックアップは自動削除） |
| **ファイル名** | `backup_YYYY-MM-DD_HH-MM_cron_auto.sql` |
| **管理UI** | https://webapp-production-exu.pages.dev/admin/backup |

### バックアップ画面でできること

管理者ユーザーで `/admin/backup` にアクセスすると、以下が可能です：

- 📥 **今すぐバックアップ**: 手動でバックアップを作成（種別: 手動）
- 💾 **DL**: バックアップSQLファイルをローカルにダウンロード
- 🔄 **復元**: 選択したバックアップでDBを上書き復元（復元前に自動で `pre_restore` バックアップ作成）
- 🗑️ **削除**: 不要なバックアップを削除

### 補足: 旧バックアップ手順（CSV/JSON/AI Drive）

下記は補助的なバックアップ手段です。日常運用は上記の自動バックアップで完結します。

| バックアップ対象 | 頻度 | 保存先 |
|---|---|---|
| **D1データベース（SQL）** | 自動（毎日 AM 2:00 JST） | R2 (`webapp-attachments/backups/`) |
| **CSV/JSONエクスポート** | 随時 | `/admin/backup/csv` からDL |
| **プロジェクト全体（コード）** | 週1回 or 大規模変更前 | GitHub（自動push） + AI Drive |

---

### 1. D1データベースのバックアップ

#### 通常運用（推奨）

Web UIから操作してください：

1. https://webapp-production-exu.pages.dev/admin/backup にアクセス
2. 管理者ログイン
3. 「今すぐバックアップ」または自動生成された一覧から「DL」をクリック

#### CLIで取得する場合（バックアップが必要なとき）

```bash
cd /home/user/webapp

# 本番DBをSQL形式でエクスポート（--remote が必須）
npx wrangler d1 export webapp-production \
  --output="/tmp/d1_backup_$(date +%Y-%m-%d).sql" \
  --remote

# 確認
ls -lh /tmp/d1_backup_*.sql
grep -c "CREATE TABLE" /tmp/d1_backup_$(date +%Y-%m-%d).sql  # テーブル数
grep -c "^INSERT INTO" /tmp/d1_backup_$(date +%Y-%m-%d).sql  # レコード数
```

#### 復元手順

⚠️ **本番DBへの復元は破壊的操作です。必ず事前確認すること。**

```bash
# ① ローカルD1へリストア（テスト用）
npx wrangler d1 execute webapp-production --local \
  --file=/tmp/d1_backup_2026-05-27.sql

# ② 本番D1へリストア（緊急時のみ）
# 既存データが消えるため、必要に応じて事前に新DBへ流し込んで切替を検討
npx wrangler d1 execute webapp-production --remote \
  --file=/tmp/d1_backup_2026-05-27.sql
```

#### 個別テーブルだけ復元したい場合

```bash
# 該当テーブルのCREATE TABLEとINSERT行だけ抽出
grep -A 100000 "CREATE TABLE users" /tmp/d1_backup_2026-05-27.sql \
  | grep -B 100000 -m1 "CREATE TABLE " > /tmp/users_only.sql

# 個別適用
npx wrangler d1 execute webapp-production --remote --file=/tmp/users_only.sql
```

---

### 2. プロジェクト全体のバックアップ

#### 取得手順

```bash
cd /home/user

# node_modules等を除外してtar.gz化
tar --exclude='webapp/node_modules' \
    --exclude='webapp/.wrangler' \
    --exclude='webapp/dist' \
    -czf "/tmp/rental-circulation-app_$(date +%Y-%m-%d).tar.gz" \
    webapp/

ls -lh /tmp/rental-circulation-app_*.tar.gz
```

その後、AI Drive または外部ストレージへアップロードしてください。

#### 復元手順

```bash
# サンドボックスを再構築する場合
cd /home/user
tar -xzf rental-circulation-app_2026-05-27.tar.gz
cd webapp
npm install
npm run build

# もしくはGitHubから（最新コードが必要なとき）
git clone https://github.com/kuniyamada/rental-circulation-app.git webapp
cd webapp && npm install && npm run build
```

---

### 3. 最新バックアップ（2026-05-27時点）

| 種別 | ファイル名 | サイズ | 保存先 |
|---|---|---|---|
| プロジェクト | `rental-circulation-app_2026-05-27.tar.gz` | 1.2 MB | ProjectBackup（CDN） |
| D1データベース | `d1_backup_2026-05-27.sql` | 71.45 KB | FileWrapper（CDN） |

- **テーブル数**: 15
- **レコード件数（INSERT行数）**: 279

---

### 4. 緊急時の連絡先・復旧手順

1. **コードが消えた** → GitHub から `git clone` で完全復旧可能
2. **データが消えた** → `/admin/backup` 画面から最新の自動バックアップを「復元」ボタンで適用
3. **Cloudflareプロジェクトごと消えた** → `wrangler pages project create` で再作成 → `wrangler pages deploy dist` → D1再作成 → R2の `backups/` からSQLを取得して `wrangler d1 execute ... --file=` で復元 → backup-worker も再デプロイ

### 5. backup-worker の運用

別Worker として `webapp-backup-worker/` ディレクトリに配置されています。

```bash
# 再デプロイ
cd /home/user/webapp/backup-worker
npx wrangler deploy

# ログ確認
npx wrangler tail

# 手動実行（CRON_TOKEN設定済の場合）
curl "https://webapp-backup-worker.kunihiro72.workers.dev/?token=YOUR_TOKEN"

# Cron設定変更（毎日2:00JST = 17:00 UTC）
# wrangler.jsonc の triggers.crons を編集して再デプロイ
```

---

## 主な機能

- ✅ ユーザー管理（ロール: admin / honsha / operations / front / front_supervisor 等）
- ✅ マンション物件管理
- ✅ 申請作成・回覧・承認フロー
- ✅ 添付ファイル管理（R2）
- ✅ LINE WORKS通知（Bot Push / Button Template）
- ✅ SMTPメール通知
- ✅ 請求書受付管理（invoice_inbox）
- ✅ PDF プレビューモーダル
- ✅ 業者支払金額・利益額・利益率の自動計算

## 開発

```bash
npm install
npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000
```

## ライセンス

社内利用限定 / Private
