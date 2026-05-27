/**
 * D1 データベースの SQL バックアップユーティリティ
 *
 * - generateBackupSql: D1から全テーブルを読み出し、SQL文字列を生成
 * - listBackups:       R2の backups/ 配下のオブジェクトを一覧
 * - saveBackup:        R2にバックアップSQLを保存
 * - getBackup:         R2から指定キーのオブジェクトを取得
 * - deleteBackup:      R2から指定キーのオブジェクトを削除
 * - pruneOldBackups:   保持件数を超えた古い自動バックアップを削除
 * - restoreFromSql:    SQL文字列をパースしてD1へ流し込む
 */

export type BackupSource = 'manual' | 'auto' | 'pre_restore'

export interface BackupMeta {
  key: string            // R2 object key (e.g. backups/backup_2026-05-27_02-00_cron_auto.sql)
  filename: string       // ベースファイル名
  size: number           // バイト数
  uploaded: Date         // 作成日時
  source: BackupSource   // 種別
  rowCount?: number      // 行数（カスタムメタデータから）
}

// バックアップ対象テーブル（usersはパスワードハッシュも含めて完全バックアップ＝復元可能にする）
const BACKUP_TABLES = [
  'users',
  'mansions',
  'applications',
  'attachments',
  'circulation_steps',
  'notification_logs',
  'smtp_settings',
  'operations_staff',
  'honsha_staff',
  'invoice_inbox',
  'reminder_settings',
  'roles',
  'lineworks_config',
  // sessions は復元時に他人のセッションを復活させてしまうのでバックアップ対象外
] as const

const R2_PREFIX = 'backups/'

/**
 * D1の値をSQLリテラル形式に変換
 */
function sqlLiteral(v: any): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    // BLOB: hex literal X'...'
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array((v as any).buffer)
    let hex = ''
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0')
    }
    return `X'${hex}'`
  }
  // string
  const s = String(v).replace(/'/g, "''")
  return `'${s}'`
}

/**
 * 全テーブルを読み出してSQL文字列を生成
 * @returns { sql, rowCount }
 */
export async function generateBackupSql(
  db: D1Database
): Promise<{ sql: string; rowCount: number }> {
  let totalRows = 0
  const parts: string[] = []
  parts.push('-- ======================================')
  parts.push('-- 請求書回覧システム データベースバックアップ')
  parts.push(`-- Generated: ${new Date().toISOString()}`)
  parts.push('-- ======================================')
  parts.push('PRAGMA foreign_keys = OFF;')
  parts.push('BEGIN TRANSACTION;')
  parts.push('')

  for (const tableName of BACKUP_TABLES) {
    try {
      // テーブル作成文を取得
      const schemaRow = await db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
        .bind(tableName)
        .first() as any
      if (!schemaRow || !schemaRow.sql) {
        // テーブルが存在しない場合はスキップ
        continue
      }

      parts.push(`-- ------------------------------------`)
      parts.push(`-- Table: ${tableName}`)
      parts.push(`-- ------------------------------------`)
      parts.push(`DROP TABLE IF EXISTS ${tableName};`)
      parts.push(`${schemaRow.sql};`)
      parts.push('')

      // 全行を取得
      const rows = await db.prepare(`SELECT * FROM ${tableName}`).all()
      const results = rows.results as any[]

      if (results.length > 0) {
        const columns = Object.keys(results[0])
        const colList = columns.map(c => `"${c}"`).join(', ')

        // 100件ずつバルクINSERT
        const BATCH = 100
        for (let i = 0; i < results.length; i += BATCH) {
          const chunk = results.slice(i, i + BATCH)
          const valueRows = chunk.map(row => {
            const vals = columns.map(col => sqlLiteral(row[col])).join(', ')
            return `(${vals})`
          })
          parts.push(`INSERT INTO ${tableName} (${colList}) VALUES`)
          parts.push(valueRows.join(',\n') + ';')
          parts.push('')
        }

        totalRows += results.length
      }
    } catch (e: any) {
      parts.push(`-- ERROR backing up table ${tableName}: ${e?.message || e}`)
      parts.push('')
    }
  }

  // インデックスも保存
  try {
    const indexes = await db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`)
      .all()
    const indexResults = indexes.results as any[]
    if (indexResults.length > 0) {
      parts.push('-- ------------------------------------')
      parts.push('-- Indexes')
      parts.push('-- ------------------------------------')
      for (const idx of indexResults) {
        if (idx.sql) parts.push(`${idx.sql};`)
      }
      parts.push('')
    }
  } catch {}

  parts.push('COMMIT;')
  parts.push('PRAGMA foreign_keys = ON;')

  return { sql: parts.join('\n'), rowCount: totalRows }
}

/**
 * ファイル名を生成（命名規則: backup_YYYY-MM-DD_HH-MM_{source}.sql）
 * 日本時間で生成
 */
export function buildBackupFilename(source: BackupSource, date: Date = new Date()): string {
  // JST (UTC+9) に変換
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000)
  const yyyy = jst.getUTCFullYear()
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(jst.getUTCDate()).padStart(2, '0')
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mi = String(jst.getUTCMinutes()).padStart(2, '0')
  let suffix: string
  switch (source) {
    case 'auto':         suffix = 'cron_auto'; break
    case 'pre_restore':  suffix = 'pre_restore'; break
    case 'manual':
    default:             suffix = 'manual'; break
  }
  return `backup_${yyyy}-${mm}-${dd}_${hh}-${mi}_${suffix}.sql`
}

/**
 * R2 に SQL を保存
 */
export async function saveBackup(
  r2: R2Bucket,
  filename: string,
  sql: string,
  source: BackupSource,
  rowCount: number
): Promise<string> {
  const key = `${R2_PREFIX}${filename}`
  await r2.put(key, sql, {
    httpMetadata: {
      contentType: 'application/sql; charset=utf-8',
      contentDisposition: `attachment; filename="${filename}"`,
    },
    customMetadata: {
      source,
      rowCount: String(rowCount),
      createdAt: new Date().toISOString(),
    }
  })
  return key
}

/**
 * R2 のバックアップ一覧を取得（新しい順）
 */
export async function listBackups(r2: R2Bucket): Promise<BackupMeta[]> {
  const list = await r2.list({ prefix: R2_PREFIX, limit: 1000 })
  const items: BackupMeta[] = list.objects.map(obj => {
    const filename = obj.key.startsWith(R2_PREFIX) ? obj.key.slice(R2_PREFIX.length) : obj.key
    // ファイル名から種別を判定
    let source: BackupSource = 'manual'
    if (filename.includes('_cron_auto')) source = 'auto'
    else if (filename.includes('_pre_restore')) source = 'pre_restore'
    else if (filename.includes('_manual')) source = 'manual'
    // カスタムメタデータがあればそれを優先
    const meta = obj.customMetadata || {}
    if (meta.source === 'auto' || meta.source === 'manual' || meta.source === 'pre_restore') {
      source = meta.source as BackupSource
    }
    const rowCount = meta.rowCount ? Number(meta.rowCount) : undefined
    return {
      key: obj.key,
      filename,
      size: obj.size,
      uploaded: obj.uploaded,
      source,
      rowCount,
    }
  })
  // 新しい順にソート
  items.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
  return items
}

/**
 * 単一バックアップを取得
 */
export async function getBackup(r2: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  if (!key.startsWith(R2_PREFIX)) return null
  return await r2.get(key)
}

/**
 * 単一バックアップを削除
 */
export async function deleteBackup(r2: R2Bucket, key: string): Promise<void> {
  if (!key.startsWith(R2_PREFIX)) return
  await r2.delete(key)
}

/**
 * 古い自動バックアップを削除（保持件数を超えたもの）
 * 手動・復元前バックアップは削除しない
 */
export async function pruneOldBackups(
  r2: R2Bucket,
  keepCount: number = 30
): Promise<{ deletedKeys: string[]; kept: number }> {
  const all = await listBackups(r2)
  const autos = all.filter(b => b.source === 'auto')
  if (autos.length <= keepCount) {
    return { deletedKeys: [], kept: autos.length }
  }
  const toDelete = autos.slice(keepCount)
  const deletedKeys: string[] = []
  for (const item of toDelete) {
    try {
      await r2.delete(item.key)
      deletedKeys.push(item.key)
    } catch {}
  }
  return { deletedKeys, kept: keepCount }
}

/**
 * SQL ステートメントを分割（簡易パーサ）
 * - 文字列リテラル内のセミコロンは無視
 * - 行コメント `-- ...` は除去
 * - 複数行INSERTにも対応
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let buf = ''
  let inSingleQuote = false
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    // 行コメント
    if (!inSingleQuote && ch === '-' && next === '-') {
      // 行末まで読み飛ばし
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    // 文字列リテラル
    if (ch === "'") {
      if (inSingleQuote && next === "'") {
        // エスケープ済シングルクォート
        buf += "''"
        i += 2
        continue
      }
      inSingleQuote = !inSingleQuote
      buf += ch
      i++
      continue
    }
    if (!inSingleQuote && ch === ';') {
      const trimmed = buf.trim()
      if (trimmed) statements.push(trimmed)
      buf = ''
      i++
      continue
    }
    buf += ch
    i++
  }
  const trimmed = buf.trim()
  if (trimmed) statements.push(trimmed)
  return statements
}

/**
 * バックアップSQLからD1へ復元
 * - 既存テーブルは DROP TABLE → 再作成 → INSERT で完全上書き
 * - PRAGMA / BEGIN / COMMIT / TRANSACTION 系はスキップ（D1の batch で扱う）
 */
export async function restoreFromSql(
  db: D1Database,
  sql: string
): Promise<{ executed: number; skipped: number; errors: string[] }> {
  const statements = splitSqlStatements(sql)
  const errors: string[] = []
  let executed = 0
  let skipped = 0

  // 実行用のステートメントを準備
  const stmts: D1PreparedStatement[] = []
  for (const stmt of statements) {
    const upper = stmt.toUpperCase().trim()
    // トランザクション系・PRAGMA はD1では使えないのでスキップ
    if (
      upper.startsWith('PRAGMA') ||
      upper.startsWith('BEGIN') ||
      upper.startsWith('COMMIT') ||
      upper.startsWith('ROLLBACK') ||
      upper.startsWith('END TRANSACTION') ||
      upper === ''
    ) {
      skipped++
      continue
    }
    try {
      stmts.push(db.prepare(stmt))
    } catch (e: any) {
      errors.push(`prepare failed: ${e?.message || e} - ${stmt.slice(0, 100)}`)
    }
  }

  // D1 batch は最大100ステートメントなので分割
  const BATCH = 50
  for (let i = 0; i < stmts.length; i += BATCH) {
    const chunk = stmts.slice(i, i + BATCH)
    try {
      await db.batch(chunk)
      executed += chunk.length
    } catch (e: any) {
      // batch失敗時は1件ずつ試す
      for (const s of chunk) {
        try {
          await s.run()
          executed++
        } catch (e2: any) {
          errors.push(`exec failed: ${e2?.message || e2}`)
        }
      }
    }
  }

  return { executed, skipped, errors }
}

/**
 * サイズを人間が読みやすい形式に
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * JST 形式の日時文字列
 */
export function formatJstDateTime(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const yyyy = jst.getUTCFullYear()
  const mm = jst.getUTCMonth() + 1
  const dd = jst.getUTCDate()
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mi = String(jst.getUTCMinutes()).padStart(2, '0')
  const ss = String(jst.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`
}
