import { Hono } from 'hono'
import { hashPassword, generateSessionId, getSessionIdFromCookie } from '../lib/auth'

type Bindings = { DB: D1Database; R2: R2Bucket }
const auth = new Hono<{ Bindings: Bindings }>()

// ログインページ
auth.get('/login', (c) => {
  const error = c.req.query('error')
  return c.html(loginPage(error))
})

// ログイン処理
auth.post('/login', async (c) => {
  const { employee_number, password } = await c.req.parseBody() as any
  const db = c.env.DB
  const hash = await hashPassword(password)
  const user = await db.prepare(
    'SELECT * FROM users WHERE employee_number = ? AND password_hash = ? AND is_active = 1'
  ).bind(employee_number, hash).first() as any

  if (!user) {
    return c.redirect('/login?error=invalid')
  }

  // セッション作成（24時間）
  const sessionId = generateSessionId()
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19)
  await db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(sessionId, user.id, expires).run()

  // 常にダッシュボードへ（パスワード変更は任意）
  return new Response(null, {
    status: 302,
    headers: {
      'Set-Cookie': `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
      'Location': '/'
    }
  })
})

// ログアウト
auth.post('/logout', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  if (sessionId) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run()
  }
  return new Response(null, {
    status: 302,
    headers: {
      'Set-Cookie': 'session_id=; Path=/; HttpOnly; Max-Age=0',
      'Location': '/login'
    }
  })
})

// パスワード変更ページ
auth.get('/change-password', (c) => {
  return c.html(changePasswordPage())
})

// パスワード変更処理
auth.post('/change-password', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  if (!sessionId) return c.redirect('/login')

  const session = await c.env.DB.prepare(
    'SELECT s.user_id FROM sessions s WHERE s.id = ? AND s.expires_at > datetime("now")'
  ).bind(sessionId).first() as any
  if (!session) return c.redirect('/login')

  const { current_password, new_password, confirm_password } = await c.req.parseBody() as any

  if (new_password !== confirm_password) {
    return c.html(changePasswordPage('新しいパスワードが一致しません'))
  }
  if (new_password.length < 6) {
    return c.html(changePasswordPage('パスワードは6文字以上にしてください'))
  }

  const currentHash = await hashPassword(current_password)
  const user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE id = ? AND password_hash = ?'
  ).bind(session.user_id, currentHash).first()
  if (!user) {
    return c.html(changePasswordPage('現在のパスワードが正しくありません'))
  }

  const newHash = await hashPassword(new_password)
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime("now") WHERE id = ?'
  ).bind(newHash, session.user_id).run()

  return c.redirect('/?pw_changed=1')
})

function loginPage(error?: string | null) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ログイン - 請求書回覧システム</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-[#EEF4FA] to-[#D5E5F2] min-h-screen flex items-center justify-center">
  <div class="bg-white rounded-2xl shadow-lg p-10 w-full max-w-md">
    <div class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-[#396999] rounded-full mb-4">
        <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
      </div>
      <h1 class="text-2xl font-bold text-gray-800">請求書回覧システム</h1>
      <p class="text-gray-500 text-sm mt-1">マンション管理 業務システム</p>
    </div>
    ${error ? `<div class="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6 text-sm">社員番号またはパスワードが正しくありません</div>` : ''}
    <form method="POST" action="/login">
      <div class="mb-5">
        <label class="block text-sm font-medium text-gray-700 mb-2">社員番号</label>
        <input type="text" name="employee_number" required
          class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#396999] focus:border-transparent outline-none transition"
          placeholder="例: U001">
      </div>
      <div class="mb-6">
        <label class="block text-sm font-medium text-gray-700 mb-2">パスワード</label>
        <input type="password" name="password" required
          class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#396999] focus:border-transparent outline-none transition"
          placeholder="初期値は社員番号と同じです">
      </div>
      <button type="submit"
        class="w-full bg-[#396999] hover:bg-[#2E5580] text-white font-semibold py-3 rounded-lg transition duration-200">
        ログイン
      </button>
    </form>
    <p class="text-center text-xs text-gray-400 mt-6">初期パスワードは社員番号と同じです</p>
  </div>
</body>
</html>`
}

function changePasswordPage(error?: string) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>パスワード変更 - 請求書回覧システム</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-[#EEF4FA] to-[#D5E5F2] min-h-screen flex items-center justify-center">
  <div class="bg-white rounded-2xl shadow-lg p-10 w-full max-w-md">
    <h1 class="text-xl font-bold text-gray-800 mb-2">パスワード変更</h1>
    <p class="text-sm text-gray-500 mb-6">新しいパスワードを設定してください。</p>
    ${error ? `<div class="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">${error}</div>` : ''}
    <form method="POST" action="/change-password">
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-2">現在のパスワード</label>
        <input type="password" name="current_password" required class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#396999] outline-none">
      </div>
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-2">新しいパスワード（6文字以上）</label>
        <input type="password" name="new_password" required minlength="6" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#396999] outline-none">
      </div>
      <div class="mb-6">
        <label class="block text-sm font-medium text-gray-700 mb-2">新しいパスワード（確認）</label>
        <input type="password" name="confirm_password" required minlength="6" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#396999] outline-none">
      </div>
      <button type="submit" class="w-full bg-[#396999] hover:bg-[#2E5580] text-white font-semibold py-3 rounded-lg transition">変更する</button>
    </form>
  </div>
</body>
</html>`
}

export default auth
