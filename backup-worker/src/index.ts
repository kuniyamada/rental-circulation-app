/**
 * webapp-backup-worker
 *
 * 請求書回覧システムの自動バックアップ専用Worker
 * - 毎日 17:00 UTC (02:00 JST) に scheduled() が起動
 * - 本体アプリと同じ D1 (webapp-production) と R2 (webapp-attachments) にアクセス
 * - SQLダンプを生成して R2 の backups/ 配下に保存
 * - 最新30件を超える古い自動バックアップは自動削除
 *
 * 手動テスト: GET / で同じ処理を実行できる（CRON_TOKEN必須）
 */

export interface Env {
  DB: D1Database
  R2: R2Bucket
  CRON_TOKEN?: string  // GETでの手動実行を保護するための秘密トークン
}

// =============== バックアップ対象テーブル ===============
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
] as const

const R2_PREFIX = 'backups/'
const KEEP_COUNT = 30

// =============== SQL生成 ===============
function sqlLiteral(v: any): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array((v as any).buffer)
    let hex = ''
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
    return `X'${hex}'`
  }
  const s = String(v).replace(/'/g, "''")
  return `'${s}'`
}

async function generateBackupSql(db: D1Database): Promise<{ sql: string; rowCount: number }> {
  let totalRows = 0
  const parts: string[] = []
  parts.push('-- ======================================')
  parts.push('-- 請求書回覧システム データベースバックアップ')
  parts.push(`-- Generated: ${new Date().toISOString()}`)
  parts.push('-- Source: webapp-backup-worker (Cron)')
  parts.push('-- ======================================')
  parts.push('PRAGMA foreign_keys = OFF;')
  parts.push('BEGIN TRANSACTION;')
  parts.push('')

  for (const tableName of BACKUP_TABLES) {
    try {
      const schemaRow = await db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
        .bind(tableName)
        .first() as any
      if (!schemaRow?.sql) continue

      parts.push(`-- Table: ${tableName}`)
      parts.push(`DROP TABLE IF EXISTS ${tableName};`)
      parts.push(`${schemaRow.sql};`)

      const rows = await db.prepare(`SELECT * FROM ${tableName}`).all()
      const results = rows.results as any[]
      if (results.length > 0) {
        const columns = Object.keys(results[0])
        const colList = columns.map(c => `"${c}"`).join(', ')
        const BATCH = 100
        for (let i = 0; i < results.length; i += BATCH) {
          const chunk = results.slice(i, i + BATCH)
          const valueRows = chunk.map(row => `(${columns.map(c => sqlLiteral(row[c])).join(', ')})`)
          parts.push(`INSERT INTO ${tableName} (${colList}) VALUES`)
          parts.push(valueRows.join(',\n') + ';')
        }
        totalRows += results.length
      }
      parts.push('')
    } catch (e: any) {
      parts.push(`-- ERROR on ${tableName}: ${e?.message || e}`)
    }
  }

  // インデックス
  try {
    const idx = await db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`).all()
    for (const row of (idx.results as any[])) {
      if (row.sql) parts.push(`${row.sql};`)
    }
  } catch {}

  parts.push('COMMIT;')
  parts.push('PRAGMA foreign_keys = ON;')

  return { sql: parts.join('\n'), rowCount: totalRows }
}

// =============== ファイル名生成（JST基準）===============
function buildBackupFilename(date: Date = new Date()): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000)
  const yyyy = jst.getUTCFullYear()
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(jst.getUTCDate()).padStart(2, '0')
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mi = String(jst.getUTCMinutes()).padStart(2, '0')
  return `backup_${yyyy}-${mm}-${dd}_${hh}-${mi}_cron_auto.sql`
}

// =============== R2 保存 ===============
async function saveBackup(r2: R2Bucket, filename: string, sql: string, rowCount: number): Promise<string> {
  const key = `${R2_PREFIX}${filename}`
  await r2.put(key, sql, {
    httpMetadata: {
      contentType: 'application/sql; charset=utf-8',
      contentDisposition: `attachment; filename="${filename}"`,
    },
    customMetadata: {
      source: 'auto',
      rowCount: String(rowCount),
      createdAt: new Date().toISOString(),
    }
  })
  return key
}

// =============== 古いバックアップ削除（自動分のみ）===============
async function pruneOldBackups(r2: R2Bucket, keepCount: number): Promise<string[]> {
  const list = await r2.list({ prefix: R2_PREFIX, limit: 1000 })
  const autos = list.objects
    .filter(obj => {
      const filename = obj.key.startsWith(R2_PREFIX) ? obj.key.slice(R2_PREFIX.length) : obj.key
      const src = obj.customMetadata?.source
      if (src === 'auto') return true
      if (src) return false // manualやpre_restoreは削除しない
      return filename.includes('_cron_auto')
    })
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())

  if (autos.length <= keepCount) return []
  const toDelete = autos.slice(keepCount)
  const deleted: string[] = []
  for (const obj of toDelete) {
    try {
      await r2.delete(obj.key)
      deleted.push(obj.key)
    } catch {}
  }
  return deleted
}

// =============== バックアップ実行 ===============
async function runBackup(env: Env): Promise<{ ok: boolean; filename?: string; rowCount?: number; pruned?: number; error?: string }> {
  try {
    const { sql, rowCount } = await generateBackupSql(env.DB)
    const filename = buildBackupFilename()
    await saveBackup(env.R2, filename, sql, rowCount)
    const pruned = await pruneOldBackups(env.R2, KEEP_COUNT)
    console.log(`[backup-worker] success file=${filename} rows=${rowCount} pruned=${pruned.length}`)
    return { ok: true, filename, rowCount, pruned: pruned.length }
  } catch (e: any) {
    console.error(`[backup-worker] failed: ${e?.message || e}`)
    return { ok: false, error: e?.message || String(e) }
  }
}

// =============== エントリポイント ===============
export default {
  // Cron Trigger（毎日 17:00 UTC = 翌日 02:00 JST）
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log(`[backup-worker] scheduled triggered at ${new Date().toISOString()} (cron=${event.cron})`)
    ctx.waitUntil(runBackup(env))
  },

  // 手動実行用（GET / with token）
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    // ヘルスチェック
    if (url.pathname === '/health' || url.pathname === '/') {
      const token = url.searchParams.get('token')
      if (!env.CRON_TOKEN) {
        return Response.json({
          status: 'ok',
          worker: 'webapp-backup-worker',
          message: 'CRON_TOKEN secret not set. Set it with: wrangler secret put CRON_TOKEN',
          schedule: 'daily 17:00 UTC (02:00 JST)',
        })
      }
      if (token !== env.CRON_TOKEN) {
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      }
      // トークン認証OK: 手動実行
      const result = await runBackup(env)
      return Response.json(result)
    }

    return Response.json({ error: 'not found' }, { status: 404 })
  }
}
