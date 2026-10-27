// ログイン履歴ユーティリティ

export type LoginEventType = 'login' | 'logout' | 'failed' | 'expired'

/** User-Agent から「OS / ブラウザ」形式の端末表記を作る */
export function parseDevice(ua: string | undefined | null): string {
  if (!ua) return ''
  let os = 'その他'
  if (/iPhone/i.test(ua)) os = 'iPhone'
  else if (/iPad/i.test(ua)) os = 'iPad'
  else if (/Android/i.test(ua)) os = 'Android'
  else if (/Windows/i.test(ua)) os = 'Windows'
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'Mac'
  else if (/CrOS/i.test(ua)) os = 'ChromeOS'
  else if (/Linux/i.test(ua)) os = 'Linux'

  let browser = 'その他'
  if (/Edg(e|A|iOS)?\//i.test(ua)) browser = 'Edge'
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera'
  else if (/Line\//i.test(ua)) browser = 'LINE'
  else if (/Firefox|FxiOS/i.test(ua)) browser = 'Firefox'
  else if (/Chrome|CriOS/i.test(ua)) browser = 'Chrome'
  else if (/Safari/i.test(ua)) browser = 'Safari'

  return `${os} / ${browser}`
}

export function getClientIp(headers: { header: (name: string) => string | undefined }): string {
  return (
    headers.header('CF-Connecting-IP') ||
    (headers.header('X-Forwarded-For') || '').split(',')[0].trim() ||
    ''
  )
}

/** ログイン履歴を1件記録（失敗しても本処理は止めない） */
export async function writeLoginLog(
  db: D1Database,
  log: {
    event_type: LoginEventType
    user_id?: number | null
    employee_number?: string | null
    user_name?: string | null
    failure_reason?: string | null
    ip_address?: string | null
    user_agent?: string | null
  }
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO login_logs (event_type, user_id, employee_number, user_name, failure_reason, ip_address, user_agent, device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      log.event_type,
      log.user_id ?? null,
      log.employee_number ?? null,
      log.user_name ?? null,
      log.failure_reason ?? null,
      log.ip_address ?? null,
      log.user_agent ?? null,
      parseDevice(log.user_agent)
    ).run()
  } catch (e) {
    console.error('login log write failed', e)
  }
}

/**
 * 期限切れセッションを「時間切れ」として記録し、セッションを削除する。
 * 日時はセッションの期限が切れた時刻（expires_at）。
 */
export async function sweepExpiredSessions(db: D1Database): Promise<void> {
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO login_logs (event_type, user_id, employee_number, user_name, created_at)
         SELECT 'expired', u.id, u.employee_number, u.name, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.expires_at <= datetime('now')`
      ),
      db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`),
    ])
  } catch (e) {
    console.error('sweep expired sessions failed', e)
  }
}
