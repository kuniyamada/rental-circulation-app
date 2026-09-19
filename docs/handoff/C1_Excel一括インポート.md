# C1: Excel/CSV 一括インポート (マスタデータ初期投入)

**用途**: 物件マスタ・ユーザーマスタ等のマスタデータを、Excelファイルから一括登録

**特徴**:
- ExcelJSライブラリで .xlsx 読み込み
- 事前バリデーション → プレビュー → 確定 の3ステップ
- エラーは行単位で表示

---

## 📦 依存パッケージ

```bash
npm install exceljs
```

⚠️ **Cloudflare Workers対応版を使用**（exceljs は Node.js API依存があるので、`compatibility_flags: ["nodejs_compat"]` が必要）

wrangler.jsonc:
```jsonc
{
  "compatibility_flags": ["nodejs_compat"]
}
```

---

## 📝 実装例

```typescript
// src/routes/admin.ts
import ExcelJS from 'exceljs'

admin.post('/mansions/import', async (c) => {
  const body = await c.req.parseBody() as any
  const file = body.file as File
  if (!file) return c.redirect('/admin/mansions?error=no_file')

  // Excelファイル読み込み
  const buffer = await file.arrayBuffer()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const sheet = workbook.worksheets[0]

  // ヘッダー行を取得
  const headerRow = sheet.getRow(1)
  const cols: Record<number, string> = {}
  headerRow.eachCell((cell, colNumber) => {
    cols[colNumber] = String(cell.value || '').trim()
  })

  // データ行を1行ずつ処理
  const results = { success: 0, failed: 0, errors: [] as string[] }
  for (let rowNum = 2; rowNum <= sheet.rowCount; rowNum++) {
    const row = sheet.getRow(rowNum)
    const record: Record<string, any> = {}
    row.eachCell((cell, colNumber) => {
      const colName = cols[colNumber]
      if (colName) record[colName] = cell.value
    })

    // バリデーション
    if (!record['マンション名']) {
      results.failed++
      results.errors.push(`行${rowNum}: マンション名が空です`)
      continue
    }

    try {
      // 既存チェック → INSERT or UPDATE
      const existing = await db.prepare('SELECT id FROM mansions WHERE mansion_number = ?').bind(record['物件№']).first()
      if (existing) {
        await db.prepare('UPDATE mansions SET name = ?, updated_at = datetime("now") WHERE id = ?')
          .bind(record['マンション名'], existing.id).run()
      } else {
        await db.prepare('INSERT INTO mansions (name, mansion_number) VALUES (?, ?)')
          .bind(record['マンション名'], record['物件№']).run()
      }
      results.success++
    } catch (e: any) {
      results.failed++
      results.errors.push(`行${rowNum}: ${e.message}`)
    }
  }

  return c.html(`
    <div>インポート結果: 成功 ${results.success} / 失敗 ${results.failed}</div>
    ${results.errors.map(e => `<div style="color:red">${e}</div>`).join('')}
    <a href="/admin/mansions">戻る</a>
  `)
})
```

---

## 🎨 アップロードフォーム

```html
<form method="POST" action="/admin/mansions/import" enctype="multipart/form-data">
  <input type="file" name="file" accept=".xlsx" required>
  <button type="submit" class="bg-[#396999] text-white px-4 py-2 rounded">インポート</button>
</form>

<p class="text-sm text-gray-500">
  Excelファイル (.xlsx) をアップロードしてください。<br>
  ヘッダー行: マンション名, 物件№, セクション, 主任者, etc.
</p>
```

---

## 💡 CSVインポート版（簡易）

Excel より軽い実装。ライブラリ不要（自前パース）：

```typescript
admin.post('/import-csv', async (c) => {
  const body = await c.req.parseBody() as any
  const file = body.file as File
  const text = await file.text()

  const lines = text.split(/\r?\n/).filter(l => l.trim())
  const headers = lines[0].split(',').map(h => h.trim())

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim())
    const record: Record<string, string> = {}
    headers.forEach((h, idx) => record[h] = values[idx] || '')

    // INSERT等
    await db.prepare('INSERT INTO ...').bind(...).run()
  }
})
```

⚠️ 上記は簡易実装。カンマを含む値やダブルクォート囲みには対応していないので、複雑なCSVには [Papa Parse](https://www.papaparse.com/) 等のライブラリを使う。

---

## 📚 rental-circulation-app での実装

- `src/routes/admin.ts` の `/admin/mansions/import` — 174件のマンション一括インポート実績あり
- ExcelJS + Cloudflare Workers の `nodejs_compat` フラグ使用
