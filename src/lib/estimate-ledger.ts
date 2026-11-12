// 見積書・請求書作成 管理簿
//   元請（payment_target='td' & td_type='motouke'）の回覧で、業務管理課(Step2)承認時に
//   見積書（attachments.file_type='estimate'）を指定のGoogleドライブフォルダ直下へ保存し、管理簿に1行追加する。
import { DriveClient } from './drive-client'
import { sanitizeFileName } from './drive-sync'

export function estimateFolderConfigured(env: any): boolean {
  return !!(env && env.ESTIMATE_FOLDER_ID && env.GOOGLE_OAUTH_CLIENT_ID &&
    env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN)
}

function todayJST(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '')
  return m ? m[1].toLowerCase() : 'pdf'
}

// 管理簿に登録（無ければ追加・あれば最新の申請に付け替え）→ 未保存ならDriveへ保存
export async function registerEstimate(env: any, applicationId: number): Promise<{ ledgerId?: number; status: string }> {
  const db: D1Database = env.DB
  const app = await db.prepare(`
    SELECT a.id, a.payment_target, a.td_type, a.applicant_id, a.mansion_id, a.is_test,
           m.mansion_number, m.name AS mansion_name
    FROM applications a LEFT JOIN mansions m ON m.id = a.mansion_id WHERE a.id = ?
  `).bind(applicationId).first() as any
  if (!app || app.payment_target !== 'td' || app.td_type !== 'motouke') return { status: 'not_motouke' }

  const att = await db.prepare(
    "SELECT id, file_name, file_key FROM attachments WHERE application_id = ? AND file_type = 'estimate' ORDER BY id DESC LIMIT 1"
  ).bind(applicationId).first() as any
  if (!att || !att.file_key) return { status: 'no_estimate' }

  const existing = await db.prepare('SELECT id, drive_status FROM estimate_ledger WHERE r2_key = ?').bind(att.file_key).first() as any
  let ledgerId: number
  if (existing) {
    ledgerId = existing.id
    await db.prepare(
      "UPDATE estimate_ledger SET application_id = ?, attachment_id = ?, mansion_id = ?, mansion_number = ?, mansion_name = ?, applicant_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(app.id, att.id, app.mansion_id, app.mansion_number ?? null, app.mansion_name ?? null, app.applicant_id, ledgerId).run()
    if (existing.drive_status === 'success') return { ledgerId, status: 'already_saved' }
  } else {
    const r = await db.prepare(`
      INSERT INTO estimate_ledger
        (application_id, attachment_id, r2_key, mansion_id, mansion_number, mansion_name, applicant_id, original_file_name, is_test)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(app.id, att.id, att.file_key, app.mansion_id, app.mansion_number ?? null, app.mansion_name ?? null,
      app.applicant_id, att.file_name, app.is_test ? 1 : 0).run()
    ledgerId = Number(r.meta.last_row_id)
  }
  const status = await saveLedgerToDrive(env, ledgerId)
  return { ledgerId, status }
}

// 管理簿1行分の見積書をDriveへ保存（失敗しても管理簿は残り、画面から再保存できる）
export async function saveLedgerToDrive(env: any, ledgerId: number): Promise<string> {
  const db: D1Database = env.DB
  const row = await db.prepare('SELECT * FROM estimate_ledger WHERE id = ?').bind(ledgerId).first() as any
  if (!row) return 'not_found'
  if (row.drive_status === 'success') return 'already_saved'
  if (!estimateFolderConfigured(env)) {
    await db.prepare("UPDATE estimate_ledger SET drive_status = 'skipped', drive_error = ?, updated_at = datetime('now') WHERE id = ?")
      .bind('Googleドライブの保存先が未設定です', ledgerId).run()
    return 'skipped'
  }
  try {
    const obj = await env.R2.get(row.r2_key)
    if (!obj) throw new Error('見積書ファイルが見つかりません（R2）')
    const body = await obj.arrayBuffer()

    // ファイル名: 034-ハイタウン大森公園-見積書-2026-11-12.pdf（同名があれば _2, _3 …）
    const num = row.mansion_number != null ? String(row.mansion_number).padStart(3, '0') : 'XXX'
    const base = sanitizeFileName(`${row.is_test ? '【テスト】' : ''}${num}-${row.mansion_name || '物件名未設定'}-見積書-${todayJST()}`)
    const ext = extOf(row.original_file_name)
    let name = `${base}.${ext}`
    for (let i = 2; i < 50; i++) {
      const dup = await db.prepare('SELECT 1 FROM estimate_ledger WHERE drive_file_name = ? AND id != ? LIMIT 1').bind(name, ledgerId).first()
      if (!dup) break
      name = `${base}_${i}.${ext}`
    }

    // 保存先: 指定フォルダの直下
    const drive = new DriveClient({ ...env, DRIVE_ROOT_FOLDER_ID: env.ESTIMATE_FOLDER_ID })
    const res = await drive.saveFile({
      path: [],
      name,
      mimeType: obj.httpMetadata?.contentType || (ext === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
      body,
      mode: 'always-new',
    })
    await db.prepare(
      "UPDATE estimate_ledger SET drive_status = 'success', drive_file_name = ?, drive_file_id = ?, drive_file_url = ?, drive_error = NULL, updated_at = datetime('now') WHERE id = ?"
    ).bind(res.name || name, res.id, res.url, ledgerId).run()
    return 'success'
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 500)
    console.error(`[estimate-ledger] id=${ledgerId} 保存失敗:`, msg)
    await db.prepare("UPDATE estimate_ledger SET drive_status = 'failed', drive_error = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(msg, ledgerId).run()
    return 'failed'
  }
}
