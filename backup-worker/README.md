# webapp-backup-worker

請求書回覧システム（webapp-production）の **自動バックアップ専用** Cloudflare Worker。

## 概要

| 項目 | 内容 |
|---|---|
| 実行スケジュール | 毎日 17:00 UTC (=02:00 JST) |
| バックアップ対象 | D1 `webapp-production` の全テーブル（sessions除く） |
| 保存先 | R2 `webapp-attachments` の `backups/` 配下 |
| ファイル名形式 | `backup_YYYY-MM-DD_HH-MM_cron_auto.sql` |
| 保持件数 | 最新30件（古い `cron_auto` のみ自動削除） |

本体アプリ `webapp-production` (Cloudflare Pages) は Cron Triggers をサポートしないため、別Workerとして切り出しています。手動バックアップ・復元・DL・削除のUIは本体側 `/admin/backup` から操作します。

## デプロイ

```bash
cd /home/user/webapp/backup-worker
npm install
npx wrangler deploy
```

Cron Trigger は `wrangler deploy` 時に `wrangler.jsonc` の `triggers.crons` から自動登録されます。

## 手動テスト

CRON_TOKEN を設定すると、GETリクエストで手動実行できます。

```bash
# トークン設定
npx wrangler secret put CRON_TOKEN
# → 任意の長いランダム文字列を入力

# 手動実行
curl "https://webapp-backup-worker.<account>.workers.dev/?token=YOUR_TOKEN"
```

レスポンス例:
```json
{ "ok": true, "filename": "backup_2026-05-27_10-00_cron_auto.sql", "rowCount": 1546, "pruned": 0 }
```

## ログ確認

```bash
npx wrangler tail
```

## 関連ファイル

- `src/index.ts` — Worker本体（scheduled + fetch）
- `wrangler.jsonc` — Cron設定・D1/R2バインディング
- 本体アプリ: `../src/lib/backup.ts` — 同じSQL生成ロジックを共有
