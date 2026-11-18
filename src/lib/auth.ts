// 認証ユーティリティ
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export function generateSessionId(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function generateApplicationNumber(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const random = Math.floor(Math.random() * 9000) + 1000
  return `REQ-${year}${month}${day}-${random}`
}

export async function getSessionUser(db: D1Database, sessionId: string | undefined): Promise<any | null> {
  if (!sessionId) return null
  const session = await db.prepare(
    'SELECT s.*, u.id as uid, u.name, u.email, u.role, u.is_admin, u.employee_number, u.must_change_password, u.test_mode FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ? AND s.expires_at > datetime("now")'
  ).bind(sessionId).first() as any
  if (!session) return null
  // 本来の権限を保持（役割プレビューの切替UI表示・解除に使う）
  session.real_role = session.role
  session.real_is_admin = session.is_admin
  session.real_uid = session.uid
  session.real_employee_number = session.employee_number
  session.real_name = session.name
  session.preview_user = null
  // 管理者の個人名プレビュー中: 選んだ人として画面を表示（管理者権限は外す・見るだけ）
  if (session.is_admin && session.preview_user_id) {
    const pu = await db.prepare(
      'SELECT id, name, email, role, employee_number FROM users WHERE id = ? AND is_active = 1'
    ).bind(session.preview_user_id).first() as any
    if (pu) {
      session.preview_user = { id: pu.id, name: pu.name, employee_number: pu.employee_number }
      session.uid = pu.id
      session.name = pu.name
      session.email = pu.email
      session.role = pu.role
      session.employee_number = pu.employee_number
      session.is_admin = 0
      session.test_mode = 0
      session.must_change_password = 0
      session.preview_role = null
    }
  }
  // 管理者の役割プレビュー中: 選択した役割として画面を表示（管理者権限は外す・見るだけ）
  if (!session.preview_user && session.is_admin && session.preview_role && PREVIEW_ROLES[session.preview_role]) {
    session.role = session.preview_role
    session.is_admin = 0
    session.test_mode = 0
  } else if (!session.preview_user) {
    session.preview_role = null
  }
  // 本来の管理者には、個人名プレビューで選べる人の一覧を持たせる（上部バーの選択欄用）
  if (session.real_is_admin) {
    try {
      const rows = await db.prepare(
        "SELECT id, name, employee_number, role FROM users WHERE is_active = 1 AND id != ? ORDER BY CAST(employee_number AS INTEGER), name"
      ).bind(session.real_uid).all()
      session.preview_user_options = rows.results || []
    } catch { session.preview_user_options = [] }
  }
  return session
}

// 役割プレビューで選べる役割（キー: users.role の値）
export const PREVIEW_ROLES: Record<string, string> = {
  front: '担当者',
  front_supervisor: '担当者/上司',
  operations: '業務管理課',
  accounting: '会計',
  honsha: '本社経理',
}

export function getSessionIdFromCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined
  const match = cookieHeader.match(/session_id=([^;]+)/)
  return match ? match[1] : undefined
}
