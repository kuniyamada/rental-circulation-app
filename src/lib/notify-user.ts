// ============================================================
// 1人に、その人の通知設定（メール / LINE WORKS / 両方）でお知らせを送る
//   送信結果は notify_logs に記録。どれか1つでも送れたら true
// ============================================================
import { logNotify } from './notify-log'
import { sendMailDetailed } from './mail'
import { sendLineWorksMessage, rowToConfig, type LineWorksConfigRow } from './lineworks'

export async function notifyUser(db: D1Database, userId: number | string, msg: {
  type: string
  subject: string
  html: string
  lwText: string                         // LINE WORKS の本文
  lwButton?: { label: string; url: string }
  applicationId?: number | string | null
  inboxId?: number | string | null
}): Promise<{ ok: boolean; name: string | null; method: string }> {
  const u = await db.prepare('SELECT name, email, notify_method, lineworks_user_id FROM users WHERE id = ?').bind(userId).first() as any
  const base = { type: msg.type, recipientId: userId, recipientName: u?.name ?? null, applicationId: msg.applicationId ?? null, inboxId: msg.inboxId ?? null }
  if (!u) {
    await logNotify(db, { ...base, channel: 'email', subject: msg.subject, status: 'skipped', error: '送信先のユーザーが見つかりません' })
    return { ok: false, name: null, method: '' }
  }
  const method = u.notify_method || 'email'
  let ok = false

  if (method === 'email' || method === 'both') {
    const smtp = await db.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any
    if (!smtp) await logNotify(db, { ...base, channel: 'email', to: u.email, subject: msg.subject, status: 'skipped', error: 'メール送信設定（SMTP）がありません' })
    else if (!u.email) await logNotify(db, { ...base, channel: 'email', subject: msg.subject, status: 'skipped', error: 'メールアドレスが登録されていません' })
    else {
      const r = await sendMailDetailed(smtp, { to: u.email, subject: msg.subject, html: msg.html })
      await logNotify(db, { ...base, channel: 'email', to: u.email, subject: msg.subject, status: r.ok ? 'sent' : 'failed', error: r.ok ? null : (r.error || '送信に失敗しました') })
      if (r.ok) ok = true
    }
  }

  if (method === 'lineworks' || method === 'both') {
    const row = await db.prepare('SELECT * FROM lineworks_config WHERE is_active = 1 LIMIT 1').first() as LineWorksConfigRow | null
    if (!row) await logNotify(db, { ...base, channel: 'lineworks', to: u.lineworks_user_id, subject: msg.subject, status: 'skipped', error: 'LINE WORKS の設定が有効になっていません' })
    else if (!u.lineworks_user_id) await logNotify(db, { ...base, channel: 'lineworks', subject: msg.subject, status: 'skipped', error: 'LINE WORKS のIDが登録されていません' })
    else {
      const full = msg.lwText
      const short = full.length > 155 ? full.substring(0, 155) + '...' : full
      let result: true | string
      try {
        result = await sendLineWorksMessage(rowToConfig(row), u.lineworks_user_id,
          msg.lwButton
            ? { type: 'button_template', altText: full, template: { type: 'buttons', text: short, actions: [{ type: 'uri', label: msg.lwButton.label, uri: msg.lwButton.url }] } }
            : { type: 'text', text: full.length > 1900 ? full.substring(0, 1900) + '...' : full },
          async (tokenData) => {
            const expiresAt = Math.floor(Date.now() / 1000) + Number(tokenData.expires_in || 86400)
            await db.prepare('UPDATE lineworks_config SET access_token=?, refresh_token=?, token_expires_at=?, updated_at=datetime("now") WHERE is_active=1')
              .bind(tokenData.access_token, tokenData.refresh_token || row.refresh_token || null, expiresAt).run()
          })
      } catch (e: any) { result = String(e?.message || e) }
      await logNotify(db, { ...base, channel: 'lineworks', to: u.lineworks_user_id, subject: msg.subject, status: result === true ? 'sent' : 'failed', error: result === true ? null : String(result) })
      if (result === true) ok = true
    }
  }
  return { ok, name: u.name, method }
}
