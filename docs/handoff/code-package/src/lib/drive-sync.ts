/**
 * Google Drive 自動保存 — このシステム固有のロジック
 *
 * 【呼び出しタイミング】業務管理課(Step2)承認時
 * 【対象ファイル】申請の全添付 (invoice1-6, other1-2, estimate, kumiai_invoice)
 * 【フォルダ】{ROOT}/{YYYY年}/{MM月}/{物件№-マンション名}/
 * 【ファイル名】{物件№}-{ファイル種別}-{承認日YYYY-MM-DD}.{ext}
 */

import { DriveClient, type DriveEnv } from './drive-client'

// このシステムで使う env の型 (D1, R2, KVを含む)
export interface SyncEnv extends DriveEnv {
  DB: D1Database
  R2: R2Bucket
}

// file_type → 日本語表示名 (ファイル名の一部として使用)
const FILE_TYPE_LABEL: Record<string, string> = {
  invoice1: '請求書①',
  invoice2: '請求書②',
  invoice3: '請求書③',
  invoice4: '請求書④',
  invoice5: '請求書⑤',
  invoice6: '請求書⑥',
  other1: '添付①',
  other2: '添付②',
  estimate: '見積書①',
  kumiai_invoice: '管理組合宛請求書',
}

/** Windowsファイル名で使えない文字を除去 */
export function sanitizeFileName(s: string): string {
  return String(s ?? '').replace(/[\\/:*?"<>|\r\n\t]/g, '').trim() || '_'
}

/** YYYY-MM-DD 形式の日付文字列 (JST) */
function formatDateJST(d: Date = new Date()): string {
  // Cloudflare Workers は UTC で動くため JST に補正
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const y = jst.getUTCFullYear()
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(jst.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** 拡張子取得 */
function extOf(filename: string): string {
  const m = filename.match(/\.([a-zA-Z0-9]+)$/)
  return m ? m[1].toLowerCase() : 'bin'
}

/** MIMEタイプ判定 (拡張子ベースのフォールバック) */
function guessMimeType(filename: string, fallback?: string): string {
  const e = extOf(filename)
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
  }
  return map[e] || fallback || 'application/octet-stream'
}

/**
 * 指定申請の全添付ファイルを Google Drive に自動保存する
 * - Step2承認時に呼ばれる想定
 * - 各添付ごとに drive_uploads テーブルへ記録 (成功/失敗)
 * - dedupe_key で二重実行を防止 (同じ申請の同じfile_typeが既にsuccessならスキップ)
 */
export async function syncApplicationToDrive(
  env: SyncEnv,
  applicationId: number,
  opts?: { kv?: KVNamespace }
): Promise<{ success: number; failed: number; skipped: number }> {
  const db = env.DB
  let successCount = 0
  let failedCount = 0
  let skippedCount = 0

  // 申請情報 + マンション情報取得
  const app = await db.prepare(`
    SELECT a.id, a.application_number, a.mansion_id,
           m.name as mansion_name, m.mansion_number
    FROM applications a
    LEFT JOIN mansions m ON a.mansion_id = m.id
    WHERE a.id = ?
  `).bind(applicationId).first() as any
  if (!app) throw new Error(`syncApplicationToDrive: 申請 ID=${applicationId} が見つかりません`)

  const mansionNum = app.mansion_number || app.mansion_id || 'X'
  const mansionName = sanitizeFileName(app.mansion_name || 'マンション名未設定')
  const savedAt = formatDateJST(new Date())  // Step2承認日 (= 実行日)

  // フォルダパス構築: YYYY年/MM月/{物件№-マンション名}
  const [year, month, _day] = savedAt.split('-')
  const folderPath = [`${year}年`, `${month}月`, `${mansionNum}-${mansionName}`]

  // 添付一覧取得
  const attsRes = await db.prepare(
    'SELECT id, file_type, file_name, file_key FROM attachments WHERE application_id = ?'
  ).bind(applicationId).all()
  const atts = (attsRes.results || []) as any[]
  if (atts.length === 0) {
    return { success: 0, failed: 0, skipped: 0 }
  }

  // Driveクライアント初期化 (Secret未設定なら例外)
  const drive = new DriveClient(env, { kv: opts?.kv })

  // 各添付を1つずつ処理
  for (const att of atts) {
    const dedupeKey = `app:${applicationId}:${att.file_type}`

    // 既にsuccessならスキップ (dedupe)
    const existing = await db.prepare(
      'SELECT id, status FROM drive_uploads WHERE dedupe_key = ?'
    ).bind(dedupeKey).first() as any
    if (existing && existing.status === 'success') {
      skippedCount++
      continue
    }

    // ファイル名生成
    const ext = extOf(att.file_name || '.bin')
    const label = FILE_TYPE_LABEL[att.file_type] || att.file_type
    const driveFileName = sanitizeFileName(`${mansionNum}-${label}-${savedAt}.${ext}`)
    const folderPathStr = folderPath.join('/')

    // 既存レコードがあればUPDATE、なければINSERT (pending状態で開始)
    if (existing) {
      await db.prepare(`
        UPDATE drive_uploads SET
          attachment_id=?, file_type=?, r2_key=?, file_name=?, folder_path=?,
          status='pending', error_message=NULL, attempts=attempts+1, updated_at=datetime('now')
        WHERE id=?
      `).bind(att.id, att.file_type, att.file_key, driveFileName, folderPathStr, existing.id).run()
    } else {
      await db.prepare(`
        INSERT INTO drive_uploads
          (dedupe_key, application_id, attachment_id, file_type, r2_key, file_name, folder_path, status, attempts)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1)
      `).bind(dedupeKey, applicationId, att.id, att.file_type, att.file_key, driveFileName, folderPathStr).run()
    }

    try {
      // R2からファイル取得
      if (!att.file_key) throw new Error('R2キーが空です')
      const obj = await env.R2.get(att.file_key)
      if (!obj) throw new Error(`R2にファイルが存在しません: ${att.file_key}`)
      const body = await obj.arrayBuffer()
      const mimeType = obj.httpMetadata?.contentType || guessMimeType(att.file_name)

      // Driveに保存
      const result = await drive.saveFile({
        path: folderPath,
        name: driveFileName,
        mimeType,
        body,
      })

      // 成功記録
      await db.prepare(`
        UPDATE drive_uploads SET
          status='success', drive_file_id=?, drive_file_url=?, error_message=NULL, updated_at=datetime('now')
        WHERE dedupe_key=?
      `).bind(result.id, result.url, dedupeKey).run()
      successCount++
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 500)
      console.error(`[drive-sync] app=${applicationId} type=${att.file_type} 失敗:`, msg)
      await db.prepare(`
        UPDATE drive_uploads SET
          status='failed', error_message=?, updated_at=datetime('now')
        WHERE dedupe_key=?
      `).bind(msg, dedupeKey).run()
      failedCount++
    }
  }

  return { success: successCount, failed: failedCount, skipped: skippedCount }
}

/**
 * 失敗した1件の drive_uploads レコードを再試行
 */
export async function retryDriveUpload(
  env: SyncEnv,
  uploadId: number,
  opts?: { kv?: KVNamespace }
): Promise<{ ok: boolean; error?: string }> {
  const db = env.DB
  const rec = await db.prepare(
    'SELECT * FROM drive_uploads WHERE id = ?'
  ).bind(uploadId).first() as any
  if (!rec) return { ok: false, error: 'レコードが見つかりません' }
  if (rec.status === 'success') return { ok: true }

  // pending状態に更新
  await db.prepare(`
    UPDATE drive_uploads SET status='pending', attempts=attempts+1, error_message=NULL, updated_at=datetime('now')
    WHERE id=?
  `).bind(uploadId).run()

  try {
    if (!rec.r2_key) throw new Error('R2キーが空です')
    const obj = await env.R2.get(rec.r2_key)
    if (!obj) throw new Error(`R2にファイルが存在しません: ${rec.r2_key}`)
    const body = await obj.arrayBuffer()

    // attachment_id からファイル情報再取得 (mimeType判定用)
    let mimeType = 'application/octet-stream'
    if (rec.attachment_id) {
      const att = await db.prepare('SELECT file_name FROM attachments WHERE id=?').bind(rec.attachment_id).first() as any
      if (att) mimeType = obj.httpMetadata?.contentType || guessMimeType(att.file_name)
    } else {
      mimeType = obj.httpMetadata?.contentType || guessMimeType(rec.file_name)
    }

    const folderPath = String(rec.folder_path).split('/').filter(Boolean)
    const drive = new DriveClient(env, { kv: opts?.kv })
    const result = await drive.saveFile({
      path: folderPath,
      name: rec.file_name,
      mimeType,
      body,
    })

    await db.prepare(`
      UPDATE drive_uploads SET
        status='success', drive_file_id=?, drive_file_url=?, error_message=NULL, updated_at=datetime('now')
      WHERE id=?
    `).bind(result.id, result.url, uploadId).run()
    return { ok: true }
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 500)
    await db.prepare(`
      UPDATE drive_uploads SET status='failed', error_message=?, updated_at=datetime('now') WHERE id=?
    `).bind(msg, uploadId).run()
    return { ok: false, error: msg }
  }
}
