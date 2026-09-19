# C3: JST 日時処理 (Cloudflare Workers UTC対応)

**問題**: Cloudflare Workers は **UTCで動く**（`new Date()` はUTC）。日本時間で表示するには変換が必要。

**特徴**:
- サーバー側は常にUTCで動く（保存もUTC）
- 表示時にJSTに変換
- 「今日」の判定もJST基準で行う

---

## 🎯 基本ヘルパー

```typescript
// src/lib/utils.ts

/** UTC Date → JST YYYY-MM-DD 形式 */
export function formatDateJST(d: Date = new Date()): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const y = jst.getUTCFullYear()
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(jst.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** UTC Date → JST YYYY-MM-DD HH:MM 形式 */
export function formatDateTimeJST(d: Date = new Date()): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const y = jst.getUTCFullYear()
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(jst.getUTCDate()).padStart(2, '0')
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mm = String(jst.getUTCMinutes()).padStart(2, '0')
  return `${y}-${m}-${dd} ${hh}:${mm}`
}

/** D1が返すISO文字列 (UTC想定) → JST表示 */
export function formatD1DateTime(iso: string): string {
  if (!iso) return '-'
  try {
    // D1は "2026-09-18 10:30:45" 形式なので、Zをつけて完全なUTC ISOにする
    const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'))
    return formatDateTimeJST(d)
  } catch {
    return iso
  }
}

/** JSTの今日の 00:00 UTC ISO文字列 (D1で >= 使う際に便利) */
export function jstTodayStartUTC(): string {
  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  // JST今日の0時 = UTC前日15時
  jst.setUTCHours(0, 0, 0, 0)
  const utc = new Date(jst.getTime() - 9 * 60 * 60 * 1000)
  return utc.toISOString().replace('T', ' ').substring(0, 19)
}
```

---

## 📝 使用例

```typescript
// DBに保存する時刻はUTC（D1のdatetime('now')が自動でUTC）
await db.prepare('INSERT INTO applications (..., created_at) VALUES (..., datetime("now"))').run()

// 表示するときJSTに変換
const app = await db.prepare('SELECT created_at FROM applications WHERE id = ?').bind(id).first()
const displayed = formatD1DateTime(app.created_at)  // 例: "2026-09-18 19:30"
```

---

## ⚠️ よくあるハマりどころ

### 1. `new Date().toISOString()` はUTC
```typescript
console.log(new Date().toISOString())
// "2026-09-18T10:30:00.000Z" ← UTC表記なので、日本人が期待する19:30ではない
```

**対策**: 常に `formatDateTimeJST()` を通す。

### 2. D1の `datetime('now')` はUTC
```sql
SELECT datetime('now')
-- 2026-09-18 10:30:00 (UTCタイムスタンプ・Zサフィックス無し・要注意)
```

**対策**: D1からの取得値は必ず `formatD1DateTime()` で表示。

### 3. `<input type="date">` の値はローカル(ブラウザ)のタイムゾーン
ユーザーがフォームで「2026-09-18」と入力した場合、それはJSTの「9/18」を意味する。DB保存時にそのまま文字列で保存すればOK。

```typescript
// フォームで受け取った日付は文字列としてそのまま保存
const startDate = body.start_date  // "2026-09-18"
await db.prepare('INSERT INTO ... (start_date) VALUES (?)').bind(startDate).run()
```

### 4. Cron trigger の時刻もUTC
```jsonc
"crons": ["0 0 * * *"]  // ← UTC 0時 = JST 9時
```

---

## 🎨 「相対時間」表示（〜分前 / 〜時間前）

```typescript
export function formatRelativeTime(iso: string): string {
  const now = Date.now()
  const then = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).getTime()
  const diff = now - then
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'たった今'
  if (minutes < 60) return `${minutes}分前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}時間前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}日前`
  return formatD1DateTime(iso)
}
```

---

## 📚 rental-circulation-app での実装

- `src/lib/drive-sync.ts` の `formatDateJST()`
- `src/routes/drive.ts` の `formatDate()`
- `src/lib/backup.ts` の `formatJstDateTime()`
