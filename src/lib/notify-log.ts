// 通知履歴の記録（記録に失敗しても送信処理は止めない）
export interface NotifyLogEntry {
  type: string
  channel: 'email' | 'lineworks'
  recipientId?: number | string | null
  recipientName?: string | null
  to?: string | null
  subject?: string | null
  status: 'sent' | 'failed' | 'skipped'
  error?: string | null
  applicationId?: number | string | null
  inboxId?: number | string | null
}

export async function logNotify(db: D1Database, e: NotifyLogEntry): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO notify_logs (notification_type, channel, recipient_id, recipient_name, to_address, subject, status, error, application_id, inbox_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      e.type, e.channel,
      e.recipientId != null && e.recipientId !== '' ? Number(e.recipientId) : null,
      e.recipientName ?? null, e.to ?? null,
      e.subject ? String(e.subject).slice(0, 300) : null,
      e.status, e.error ? String(e.error).slice(0, 500) : null,
      e.applicationId != null && e.applicationId !== '' ? Number(e.applicationId) : null,
      e.inboxId != null && e.inboxId !== '' ? Number(e.inboxId) : null,
    ).run()
  } catch (err) {
    console.error('[notify-log] 記録失敗:', err)
  }
}

export const NOTIFY_TYPE_LABEL: Record<string, string> = {
  inbox_new: '請求書受付',
  inbox_remind: '受付の再通知',
  review_request: '承認依頼',
  review_reminder: '承認リマインド',
  motouke_next: '元請 次の手続き',
  completed: '回覧完了',
  rejected: '却下',
  on_hold: '保留',
  returned: '差し戻し',
  answered: '回答',
  reapplied: '再申請',
  recalled: '申請者の取消',
  reminder_summary: 'リマインドのまとめ',
}

export const CHANNEL_LABEL: Record<string, string> = { email: 'メール', lineworks: 'LINE WORKS' }

// D1 の CURRENT_TIMESTAMP（UTC 'YYYY-MM-DD HH:MM:SS'）を日本時間 'M/D HH:MM' に
export function fmtJst(utc: string | null | undefined, withYear = false): string {
  if (!utc) return '-'
  const d = new Date(String(utc).replace(' ', 'T') + (String(utc).includes('Z') ? '' : 'Z'))
  if (isNaN(d.getTime())) return String(utc)
  const j = new Date(d.getTime() + 9 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  const md = `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`
  return withYear ? `${j.getUTCFullYear()}/${md}` : md
}
