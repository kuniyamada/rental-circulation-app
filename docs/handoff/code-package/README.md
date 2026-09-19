# コードファイル抽出パッケージ

**元システム**: rental-circulation-app (賃貸物件回覧承認システム)
**このパッケージ**: 送金依頼管理システムなど、他のCloudflare Workers + Hono + TypeScriptシステムへコピー可能なコアファイル

---

## 📁 ファイル構成

```
code-package/
├── src/
│   ├── lib/
│   │   ├── drive-client.ts      ⭐ 汎用モジュール（改変不要でコピー可）
│   │   ├── drive-sync.ts        システム固有ロジック（ドメイン置換で流用）
│   │   ├── auth.ts              セッション認証・パスワードハッシュ
│   │   ├── mail.ts              SMTP送信（MailChannels）
│   │   ├── lineworks.ts         LINE WORKS API v2 + JWT
│   │   └── backup.ts            D1バックアップ・復元
│   └── routes/
│       ├── layout.ts            共通レイアウト（サイドバー含む）
│       ├── auth.ts              ログイン・ログアウト・パスワード変更
│       └── drive.ts             Drive自動保存 管理画面 + API
├── migrations/
│   └── 0015_drive_uploads.sql   Drive保存記録テーブル
└── public/
    └── static/
        ├── favicon.svg          メインファビコン
        └── apple-touch-icon.svg iOS用ファビコン
```

---

## 🎯 各ファイルの流用度

### ⭐ 改変不要（そのままコピーOK）
- `src/lib/drive-client.ts` — Drive API 呼び出しの本体
- `src/lib/backup.ts` — バックアップヘルパー
- `src/lib/mail.ts` — MailChannels経由のSMTP
- `src/lib/lineworks.ts` — LINE WORKS API + JWT
- `public/static/favicon.svg` — ファビコン (デザイン変更したい場合のみ差し替え)
- `public/static/apple-touch-icon.svg` — 同上

### 🔧 軽微な修正でコピー可（ドメイン名置換など）
- `src/lib/auth.ts` — テーブル名・カラム名が一致していれば流用可
- `src/lib/drive-sync.ts` — file_type 一覧、フォルダ命名を送金依頼版に調整
- `src/routes/drive.ts` — application_id → request_id 等の置換
- `src/routes/layout.ts` — サイドバーメニュー項目を送金依頼版に置換
- `src/routes/auth.ts` — システム名（"請求書回覧システム"→"送金依頼管理システム"）を置換
- `migrations/0015_drive_uploads.sql` — application_id → request_id 等（またはそのまま application_id で使う）

---

## 🚀 使い方

1. **このディレクトリを送金依頼システムに配置**（例: `src/lib/`, `src/routes/`, `migrations/`, `public/static/`）
2. **`docs/handoff/A1〜C4.md` の各資料に従って組み込み**
3. **必要な設定** (Cloudflare Secret, wrangler.jsonc等) を行う
4. **ビルド・デプロイ**

---

## 📚 詳細な組み込み手順

`docs/handoff/` の各Markdownを参照。特に以下は必読：

- **A1_GoogleDrive自動保存.md** — Drive自動保存の完全な組み込み手順
- **A2_通知バックグラウンド化.md** — `runInBackground` の使い方（drive-sync.ts の呼び出しに必要）
- **A4_共通レイアウト設計.md** — layout.ts の使い方
- **B2_回覧承認フロー.md** — 承認フロー全体像（Drive保存の呼び出しタイミング）
- **B5_メール_LINEWORKS統合通知.md** — mail.ts / lineworks.ts の使い方

---

## ⚠️ 依存関係

各ファイルが依存するパッケージ：

```json
{
  "dependencies": {
    "hono": "^4.0.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.0.0",
    "@hono/vite-cloudflare-pages": "^0.4.2",
    "vite": "^5.0.0",
    "wrangler": "^3.78.0",
    "typescript": "^5.0.0"
  }
}
```

`exceljs` を使う場合（Excel一括インポート = C1）は別途 `npm install exceljs` が必要。

---

## 🔑 必要な Cloudflare Secret（Drive自動保存を使う場合）

```bash
printf '%s' "<CLIENT_ID>"     | npx wrangler pages secret put GOOGLE_OAUTH_CLIENT_ID     --project-name <PROJECT>
printf '%s' "<CLIENT_SECRET>" | npx wrangler pages secret put GOOGLE_OAUTH_CLIENT_SECRET --project-name <PROJECT>
printf '%s' "<REFRESH_TOKEN>" | npx wrangler pages secret put GOOGLE_OAUTH_REFRESH_TOKEN --project-name <PROJECT>
printf '%s' "<FOLDER_ID>"     | npx wrangler pages secret put DRIVE_ROOT_FOLDER_ID       --project-name <PROJECT>
```

---

## 🎯 動作確認

1. マイグレーション適用: `npx wrangler d1 migrations apply <DB> --remote`
2. デプロイ: `npm run build && npx wrangler pages deploy dist --project-name <PROJECT>`
3. 管理画面 → Drive自動保存 → 接続テスト → ✅ 成功なら OK

---

Happy Coding! 🚀
