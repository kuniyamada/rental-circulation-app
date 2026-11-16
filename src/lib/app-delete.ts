// テスト申請の削除（管理者のみ・is_test=1 の申請だけ）
//   - 申請に結び付くデータ（回覧ステップ・通知履歴・添付・Drive保存記録・管理簿・請求書受付）をまとめて削除
//   - Googleドライブに自動保存したファイルはゴミ箱へ移動（30日以内なら戻せる）
//   - R2 のファイルは、ほかから参照されていない場合だけ削除
import { DriveClient } from './drive-client'

export type DeleteResult = { ok: boolean; message: string; appNumber?: string; driveTrashed?: number; driveFailed?: string[] }

export async function deleteTestApplication(env: any, appId: number): Promise<DeleteResult> {
  const db: D1Database = env.DB
  const app = await db.prepare('SELECT id, application_number, is_test FROM applications WHERE id = ?').bind(appId).first() as any
  if (!app) return { ok: false, message: '申請が見つかりません' }
  if (app.is_test !== 1) return { ok: false, message: 'テスト申請ではないため削除できません（本番の申請は削除できない仕様です）' }

  // この申請をもとにした後続の申請（差し戻し再申請・元請B）があれば先にそちらを削除してもらう
  const child = await db.prepare('SELECT application_number FROM applications WHERE original_application_id = ? LIMIT 1').bind(appId).first() as any
  if (child) return { ok: false, message: `この申請をもとにした申請（${child.application_number}）があるため削除できません。先にそちらを削除してください` }

  const all = async (sql: string) => ((await db.prepare(sql).bind(appId).all()).results || []) as any[]
  const atts = await all('SELECT id, file_key FROM attachments WHERE application_id = ?')
  const inboxes = await all('SELECT id, attachment_key FROM invoice_inbox WHERE application_id = ?')
  const drives = await all("SELECT drive_file_id FROM drive_uploads WHERE application_id = ? AND drive_file_id IS NOT NULL")
  const ledgers = await all("SELECT id, drive_file_id FROM estimate_ledger WHERE application_id = ?")

  // 1) Googleドライブのファイルをゴミ箱へ（失敗しても削除は続ける）
  const driveIds = [...drives.map(d => d.drive_file_id), ...ledgers.map(l => l.drive_file_id)].filter(Boolean)
  let driveTrashed = 0
  const driveFailed: string[] = []
  if (driveIds.length) {
    const canDrive = env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN
    if (!canDrive) {
      driveFailed.push(...driveIds)
    } else {
      const drive = new DriveClient({ ...env, DRIVE_ROOT_FOLDER_ID: env.DRIVE_ROOT_FOLDER_ID || env.ESTIMATE_FOLDER_ID || 'x' })
      for (const fid of driveIds) {
        try { await drive.trashFile(fid); driveTrashed++ }
        catch (e: any) {
          // すでに無い（404）なら削除済み扱い
          if (e?.status === 404) driveTrashed++
          else { driveFailed.push(fid); console.error('[app-delete] drive trash failed', fid, e?.message || e) }
        }
      }
    }
  }

  // 2) データベース（参照される側を最後に）
  const ledgerIds = ledgers.map(l => l.id)
  const inboxIds = inboxes.map(i => i.id)
  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM notification_logs WHERE application_id = ?').bind(appId),
    db.prepare('DELETE FROM circulation_steps WHERE application_id = ?').bind(appId),
    db.prepare('DELETE FROM drive_uploads WHERE application_id = ?').bind(appId),
    db.prepare('DELETE FROM estimate_ledger WHERE application_id = ?').bind(appId),
    ...inboxIds.map(id => db.prepare('UPDATE estimate_ledger SET inbox_id = NULL WHERE inbox_id = ?').bind(id)),
    db.prepare('DELETE FROM invoice_inbox WHERE application_id = ?').bind(appId),
    db.prepare('DELETE FROM attachments WHERE application_id = ?').bind(appId),
    db.prepare('DELETE FROM applications WHERE id = ? AND is_test = 1').bind(appId),
  ]
  await db.batch(stmts)
  void ledgerIds

  // 3) R2 のファイル（ほかの申請・受付・管理簿から参照されていないものだけ）
  const keys = Array.from(new Set([...atts.map(a => a.file_key), ...inboxes.map(i => i.attachment_key)].filter(Boolean)))
  for (const key of keys) {
    const used = await db.prepare(`
      SELECT 1 FROM attachments WHERE file_key = ?1
      UNION ALL SELECT 1 FROM invoice_inbox WHERE attachment_key = ?1
      UNION ALL SELECT 1 FROM estimate_ledger WHERE r2_key = ?1
      LIMIT 1`).bind(key).first()
    if (!used) { try { await env.R2.delete(key) } catch (e) { console.error('[app-delete] R2 delete failed', key, e) } }
  }

  return { ok: true, message: `${app.application_number} を削除しました`, appNumber: app.application_number, driveTrashed, driveFailed }
}
