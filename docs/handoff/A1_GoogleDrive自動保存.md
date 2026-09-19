# A1: Google Drive 自動保存 (OAuth+共有ドライブ方式)

**元システム**: 賃貸物件回覧承認システム (rental-circulation-app)
**方式**: OAuth 2.0 refresh_token + 共有ドライブ
**なぜこの方式か**: `tokyodefense.net` 組織ポリシー `iam.disableServiceAccountKeyCreation` によりサービスアカウント鍵が発行不可のため

---

## 🎯 何を実現するか

**業務管理課(Step2)承認時に、申請の全添付ファイルを Google 共有ドライブへ自動保存**する。
承認後、指定フォルダ配下に `YYYY年/MM月/{物件№-物件名}/{ファイル}` の階層で保存される。

---

## 📁 実装するファイル (4つ)

| ファイル | 役割 | 汎用性 |
|---|---|---|
| `src/lib/drive-client.ts` | ⭐**汎用モジュール**⭐ Drive API 呼び出しの本体 | 改変不要でコピー可 |
| `src/lib/drive-sync.ts` | システム固有ロジック（呼び出し・記録・再試行） | ドメイン置換で流用 |
| `src/routes/drive.ts` | 管理画面 + 接続テストAPI + 再試行API | ドメイン置換で流用 |
| `migrations/XXXX_drive_uploads.sql` | 保存記録テーブル | そのまま流用可 |

---

## 🚀 実装手順（8ステップ）

### Step 1: DB migration 作成

```sql
-- migrations/XXXX_drive_uploads.sql
CREATE TABLE IF NOT EXISTS drive_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT UNIQUE NOT NULL,           -- 二重保存防止 例: 'req:123:invoice1'
  request_id INTEGER NOT NULL,               -- 対象送金依頼(または申請)
  attachment_id INTEGER,                     -- attachments.id
  file_type TEXT NOT NULL,                   -- 送金依頼のファイル種別
  r2_key TEXT,                               -- R2の保存キー(再試行用)
  file_name TEXT NOT NULL,                   -- Drive上のファイル名
  folder_path TEXT NOT NULL,                 -- Drive上のフォルダパス(表示用)
  drive_file_id TEXT,                        -- 成功時のDrive上のファイルID
  drive_file_url TEXT,                       -- 成功時のDrive閲覧URL
  status TEXT NOT NULL DEFAULT 'pending',    -- pending / success / failed
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_drive_uploads_status ON drive_uploads(status);
CREATE INDEX IF NOT EXISTS idx_drive_uploads_request_id ON drive_uploads(request_id);
```

適用: `npx wrangler d1 migrations apply <DB名> --remote`

### Step 2: drive-client.ts をコピー配置

`code-package/src/lib/drive-client.ts` をそのままコピーして `src/lib/drive-client.ts` に配置。

**改変不要**。以下のノウハウが組み込み済み：
- 全API呼び出しに `supportsAllDrives=true` (共有ドライブ対応)
- 検索に `includeItemsFromAllDrives=true` + `corpora=allDrives`
- PDF等アップロード時はメタデータに `mimeType` を入れない (Docs変換防止)
- access_token は KV に1時間キャッシュ / 401時に自動リトライ
- 429/5xx は指数バックオフで最大3回リトライ
- 設定ミス系 (403 storageQuotaExceeded / 404) は即エラー
- 同名ファイルは PATCH で上書き

### Step 3: drive-sync.ts をシステム用にアレンジ

`code-package/src/lib/drive-sync.ts` をベースに、以下を送金依頼システム用に書き換える：

**フォルダパス生成**（`syncApplicationToDrive` 内）：
```typescript
// 引き継ぎ元 (rental)
const folderPath = [`${year}年`, `${month}月`, `${mansionNum}-${mansionName}`]

// 送金依頼版の例
const folderPath = [`${year}年`, `${month}月`, `${propertyNum}-${payeeName}`]
```

**ファイル名生成**：
```typescript
// 引き継ぎ元 (rental)
const driveFileName = sanitizeFileName(`${mansionNum}-${label}-${savedAt}.${ext}`)

// 送金依頼版
const driveFileName = sanitizeFileName(`${propertyNum}-${label}-${savedAt}.${ext}`)
```

**FILE_TYPE_LABEL**: 送金依頼システムのファイル種別に置換
```typescript
const FILE_TYPE_LABEL: Record<string, string> = {
  invoice: '請求書',
  receipt: '領収書',
  contract: '契約書',
  // ... 送金依頼固有のもの
}
```

### Step 4: 承認時のフックを追加

送金依頼の承認処理（POST /:id/approve など）内で、`Step2承認完了時`に以下を追加：

```typescript
import { syncApplicationToDrive } from '../lib/drive-sync'

// 承認処理の中で...
if (step.step_number === 2) {  // または「業務管理課の承認」の判定
  const driveEnv = c.env as any
  if (driveEnv.GOOGLE_OAUTH_CLIENT_ID && driveEnv.DRIVE_ROOT_FOLDER_ID) {
    const reqId = Number(id)
    // waitUntil でバックグラウンド実行 (業務処理を止めないため)
    runInBackground(c, async () => {
      try {
        const r = await syncApplicationToDrive(driveEnv, reqId)
        console.log(`[drive-sync] req=${reqId} success=${r.success} failed=${r.failed}`)
      } catch (e) {
        console.error(`[drive-sync] req=${reqId} エラー:`, (e as any)?.message || e)
      }
    })
  }
}
```

`runInBackground` の実装は **A2_通知バックグラウンド化.md** 参照。

### Step 5: 管理画面ルート作成

`code-package/src/routes/drive.ts` をコピーして `src/routes/drive.ts` に配置。

**変更が必要な箇所**：
- application_id → request_id への置換（DBカラム名に合わせて）
- 「申請」→「送金依頼」等の表示テキスト置換

`admin.ts` に登録：
```typescript
import driveRoutes from './drive'
admin.route('/drive', driveRoutes)
```

### Step 6: サイドバーに「Drive自動保存」リンク追加

layout.ts の管理者メニュー内に追加：
```html
<a href="/admin/drive" class="sidebar-item ${title.includes('Drive') ? 'active' : ''}">
  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
      d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"/>
  </svg>
  Drive自動保存
</a>
```

（既にメニューがあるとのことなのでこのステップはスキップでもOK）

### Step 7: Google側の1回きり作業（OAuth設定）

**送金依頼システム専用の OAuthクライアントを新規作成**（推奨。障害切り分け・失効の影響範囲を限定するため）。

#### 7-1. GCP Console
1. https://console.cloud.google.com/
2. プロジェクト選択（新規作成なら「新しいプロジェクト」→ 名前入力）
3. 「APIとサービス」→「ライブラリ」→ **Google Drive API** を有効化
4. 「APIとサービス」→「認証情報」

#### 7-2. OAuth同意画面の構成（初回のみ）
- アプリ名: `Soukin Iraiseikyu System`（何でもOK）
- ユーザーサポートメール: 承認者アドレス
- User Type: **内部**（組織内利用のみなら）
- 連絡先: 承認者アドレス

#### 7-3. OAuthクライアントID作成
- 種類: **ウェブアプリケーション**
- 名前: `Soukin Drive Save Client`
- **承認済みリダイレクトURI**: `https://developers.google.com/oauthplayground`
- **作成** → クライアントID / シークレットをコピー

#### 7-4. refresh_token 取得
1. https://developers.google.com/oauthplayground/
2. 右上の歯車 ⚙️ →「Use your own OAuth credentials」にチェック → ID/Secret入力
3. 左のスコープ欄に `https://www.googleapis.com/auth/drive` を入力
4. 「Authorize APIs」→ Googleアカウントログイン → 承認
5. 「Exchange authorization code for tokens」ボタン
6. **refresh_token (`1//...`) をコピー**

#### 7-5. 共有ドライブのフォルダID取得
1. Google Drive の**共有ドライブ**内で保存先フォルダを開く
2. URLの `/folders/{ここ}` の部分がフォルダID
3. ⚠️ **必ず共有ドライブ内のフォルダ**（マイドライブは 403 storageQuotaExceeded で失敗）

### Step 8: Cloudflare Secret 4つ登録

```bash
printf '%s' "<CLIENT_ID>"     | npx wrangler pages secret put GOOGLE_OAUTH_CLIENT_ID --project-name <PROJECT>
printf '%s' "<CLIENT_SECRET>" | npx wrangler pages secret put GOOGLE_OAUTH_CLIENT_SECRET --project-name <PROJECT>
printf '%s' "<REFRESH_TOKEN>" | npx wrangler pages secret put GOOGLE_OAUTH_REFRESH_TOKEN --project-name <PROJECT>
printf '%s' "<FOLDER_ID>"     | npx wrangler pages secret put DRIVE_ROOT_FOLDER_ID --project-name <PROJECT>

# デプロイして反映
npm run build
npx wrangler pages deploy dist --project-name <PROJECT>
```

---

## ✅ 動作確認

### 接続テスト
1. 管理画面 → 「Drive自動保存」
2. 「🔌 接続テスト」ボタンをクリック
3. 期待結果: `✅ 接続OK / 保存先フォルダ: XXX / 共有ドライブID: XXX`

### 実運用テスト
1. テストモードで新規送金依頼を作成 → 添付追加
2. Step1承認 → Step2承認
3. 数秒待つ → 「Drive自動保存」画面に成功レコードが増える
4. Google Drive で `2026年/09月/{物件№-物件名}/` にファイル保存を確認

---

## 🐛 移行時の落とし穴チェックリスト

| # | 症状 | 原因 | 対策 |
|---|---|---|---|
| 1 | `403 storageQuotaExceeded` | マイドライブに保存しようとした | 必ず**共有ドライブ**を使用 |
| 2 | `404 File not found` | 承認アカウントが権限なし / ID誤り | 共有ドライブのメンバー追加（コンテンツ管理者以上） |
| 3 | フォルダ探索の不可解404 | `supportsAllDrives` 付け忘れ | drive-client.ts は対応済み。自前実装時は要注意 |
| 4 | PDFがDocsに変換される | メタデータに `mimeType` を入れた | メタデータ側は `mimeType` を省略（本モジュールは対応済み） |
| 5 | `invalid_grant` | refresh_token 失効 / 別クライアントのトークン使用 | 7-4を再実施 |
| 6 | `invalid_client` | クライアント作成直後 | 5分〜数時間待つ |
| 7 | 送信ボタンが数十秒固まる | Drive保存を `await` した | `waitUntil` で非同期化 |

---

## 📊 このシステムでの実運用データ（参考）

- **保存先フォルダ**: `■請求書回覧システム`
- **共有ドライブID**: `0AOReL6KSoax7Uk9PVA`
- **ファイル数**: 承認1件あたり通常1〜3個（多い場合は6個+管理組合宛請求書）
- **サイズ**: 通常 200KB〜2MB (PDF)、稀に10MB (画像)
- **Drive API制限**: 1日 1,000,000,000 クエリ (実運用ではまず届かない)

---

## 🔗 関連資料

- **横展開の詳細ガイド** (元Markdown): [組合員システムの GoogleDrive自動保存_横展開ガイド.md](https://www.genspark.ai/api/files/s/AlHHIHCh)
- **A2 通知バックグラウンド化.md**: `runInBackground` ヘルパーの実装
- **B1 添付ファイル管理.md**: R2+attachmentsテーブルの構造
