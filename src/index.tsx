import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { getSessionUser, getSessionIdFromCookie } from './lib/auth'
import auth from './routes/auth'
import applications from './routes/applications'
import admin from './routes/admin'
import inbox from './routes/inbox'

type Bindings = { DB: D1Database; R2: R2Bucket }

const app = new Hono<{ Bindings: Bindings }>()

// 静的ファイル
app.use('/static/*', serveStatic({ root: './' }))

// 認証ルート（/login, /logout, /change-password）
app.route('/', auth)

// ===== トップページ（ダッシュボード） =====
app.get('/', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')
  // パスワード変更は任意（強制リダイレクトなし）

  const pwChanged = c.req.query('pw_changed') === '1'
  const db = c.env.DB

  const myApps = await db.prepare(`
    SELECT a.*, m.name as mansion_name
    FROM applications a LEFT JOIN mansions m ON a.mansion_id = m.id
    WHERE a.applicant_id = ? ORDER BY a.created_at DESC LIMIT 20
  `).bind(user.uid).all()

  const pendingReviews = await db.prepare(`
    SELECT a.*, m.name as mansion_name, cs.step_number, cs.id as step_id
    FROM circulation_steps cs JOIN applications a ON cs.application_id = a.id
    LEFT JOIN mansions m ON a.mansion_id = m.id
    WHERE cs.reviewer_id = ? AND cs.status = 'pending' AND a.status = 'circulating'
    ORDER BY a.created_at ASC
  `).bind(user.uid).all()

  const holdApps = await db.prepare(`
    SELECT a.*, m.name as mansion_name, cs.action_comment as question, cs.id as step_id
    FROM circulation_steps cs JOIN applications a ON cs.application_id = a.id
    LEFT JOIN mansions m ON a.mansion_id = m.id
    WHERE a.applicant_id = ? AND cs.status = 'on_hold'
    ORDER BY cs.created_at DESC
  `).bind(user.uid).all()

  // 業務管理課・管理者向け：未申請の受付一覧
  const pendingInbox = (user.role === 'operations' || user.is_admin)
    ? await db.prepare(`
        SELECT ii.*, m.name as mansion_name, f.name as front_name
        FROM invoice_inbox ii
        LEFT JOIN mansions m ON ii.mansion_id = m.id
        LEFT JOIN users f ON ii.front_user_id = f.id
        WHERE ii.status = 'pending'
        ORDER BY ii.created_at ASC
      `).all()
    : { results: [] }

  // フロント向け：自分宛の未申請受付
  const myPendingInbox = (user.role === 'front')
    ? await db.prepare(`
        SELECT ii.*, m.name as mansion_name, r.name as registered_by_name
        FROM invoice_inbox ii
        LEFT JOIN mansions m ON ii.mansion_id = m.id
        LEFT JOIN users r ON ii.registered_by = r.id
        WHERE ii.front_user_id = ? AND ii.status = 'pending'
        ORDER BY ii.created_at ASC
      `).bind(user.uid).all()
    : { results: [] }

  const statusBadge = (status: string) => {
    const map: Record<string, { label: string; cls: string }> = {
      draft:       { label: '下書き',   cls: 'bg-gray-100 text-gray-600' },
      circulating: { label: '回覧中',   cls: 'bg-blue-100 text-blue-600' },
      approved:    { label: '承認済',   cls: 'bg-green-100 text-green-700' },
      rejected:    { label: '差し戻し', cls: 'bg-red-100 text-red-600' },
      on_hold:     { label: '保留中',   cls: 'bg-yellow-100 text-yellow-700' },
      completed:   { label: '完了',     cls: 'bg-purple-100 text-purple-700' },
    }
    const s = map[status] || { label: status, cls: 'bg-gray-100 text-gray-600' }
    return `<span class="text-xs font-semibold px-2 py-0.5 rounded-full ${s.cls}">${s.label}</span>`
  }

  const roleLabel: Record<string, string> = {
    front: 'フロント', manager: '上長', operations: '業務管理課',
    accounting: '会計担当', honsha: '本社経理', admin: '管理者',
  }

  const sidebar = `
    <aside id="sidebar" class="w-60 bg-white border-r border-gray-200 fixed left-0 top-14 bottom-0 overflow-y-auto z-40 transform -translate-x-full lg:translate-x-0 transition-transform duration-200">
      <nav class="p-3 space-y-1">
        <a href="/" class="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm bg-blue-50 text-blue-600 font-semibold">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
          ダッシュボード
        </a>
        <a href="/applications/new" class="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-blue-50 hover:text-blue-600 transition">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          新規申請
        </a>
        <a href="/applications" class="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-blue-50 hover:text-blue-600 transition">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
          申請一覧・検索
        </a>
        <a href="/change-password" class="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-blue-50 hover:text-blue-600 transition">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg>
          パスワード変更
        </a>
        ${(user.role === 'operations' || user.is_admin) ? `
        <div class="pt-3 pb-1">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider px-4">受付管理</p>
        </div>
        <a href="/inbox" class="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-blue-50 hover:text-blue-600 transition">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"/></svg>
          請求書受付管理
        </a>
        ` : ''}
        ${user.is_admin ? `
        <div class="pt-3 pb-1">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider px-4">管理者メニュー</p>
        </div>
        <a href="/admin/users" class="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-blue-50 hover:text-blue-600 transition">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
          ユーザー管理
        </a>
        <a href="/admin/mansions" class="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-blue-50 hover:text-blue-600 transition">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
          マンション管理
        </a>
        <a href="/admin/staff" class="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-blue-50 hover:text-blue-600 transition">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
          担当者設定
        </a>
        <a href="/admin/smtp" class="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-blue-50 hover:text-blue-600 transition">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
          メール設定
        </a>
        <a href="/admin/reminder" class="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-blue-50 hover:text-blue-600 transition">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>
          リマインダー設定
        </a>
        ` : ''}
      </nav>
    </aside>
  `

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ダッシュボード - 請求書回覧システム</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
  <header class="bg-white border-b border-gray-200 fixed top-0 left-0 right-0 z-50">
    <div class="flex items-center justify-between px-4 h-14">
      <div class="flex items-center gap-3">
        <button onclick="document.getElementById('sidebar').classList.toggle('-translate-x-full');document.getElementById('overlay').classList.toggle('hidden')" class="p-1.5 rounded-lg hover:bg-gray-100 lg:hidden">
          <svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
        </button>
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          </div>
          <span class="font-bold text-gray-800 text-sm">請求書回覧システム</span>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <div class="text-right hidden sm:block">
          <p class="text-sm font-semibold text-gray-800">${user.name}</p>
          <p class="text-xs text-gray-400">${roleLabel[user.role] || user.role} / ${user.employee_number}</p>
        </div>
        <form method="POST" action="/logout">
          <button type="submit" class="text-xs text-gray-500 hover:text-red-500 border border-gray-200 px-3 py-1.5 rounded-lg hover:border-red-200 transition">ログアウト</button>
        </form>
      </div>
    </div>
  </header>
  <div class="flex pt-14">
    ${sidebar}
    <div id="overlay" onclick="document.getElementById('sidebar').classList.add('-translate-x-full');this.classList.add('hidden')" class="fixed inset-0 bg-black bg-opacity-30 z-30 hidden lg:hidden"></div>
    <main class="flex-1 lg:ml-60 p-6">
      <div class="max-w-6xl mx-auto">
        <h1 class="text-xl font-bold text-gray-800 mb-6">ダッシュボード</h1>
        ${pwChanged ? `<div class="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm mb-6">✅ パスワードを変更しました。</div>` : ''}
        <div class="space-y-8">
          <!-- フロント向け：対応待ち請求書 -->
          ${(myPendingInbox.results as any[]).length > 0 ? `
          <div class="bg-orange-50 border border-orange-200 rounded-xl p-4">
            <div class="flex items-center gap-2 mb-3">
              <span class="w-3 h-3 bg-orange-500 rounded-full animate-pulse"></span>
              <h2 class="font-bold text-orange-800">📥 対応が必要な請求書があります</h2>
              <span class="ml-auto bg-orange-500 text-white text-xs font-bold px-2 py-1 rounded-full">${(myPendingInbox.results as any[]).length}件</span>
            </div>
            <div class="space-y-2">
              ${(myPendingInbox.results as any[]).map((item: any) => `
                <div class="bg-white rounded-lg px-4 py-3 flex items-center justify-between shadow-sm">
                  <div>
                    <p class="font-semibold text-gray-800 text-sm">${item.mansion_name || '-'}</p>
                    <p class="text-xs text-gray-500 mt-0.5">登録：${item.registered_by_name}（業務管理課）/ ${item.created_at?.slice(0,10)}</p>
                    ${item.note ? `<p class="text-xs text-gray-400 mt-0.5">備考: ${item.note}</p>` : ''}
                  </div>
                  <div class="flex gap-2 items-center">
                    ${item.attachment_key ? `<a href="/inbox/${item.id}/download" class="text-xs text-blue-600 hover:underline">📎請求書</a>` : ''}
                    <a href="/applications/new" class="bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition">回覧申請する</a>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
          ` : ''}

          <!-- 業務管理課向け：未申請受付一覧 -->
          ${(pendingInbox.results as any[]).length > 0 ? `
          <div class="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
            <div class="flex items-center gap-2 mb-3">
              <span class="w-3 h-3 bg-yellow-500 rounded-full animate-pulse"></span>
              <h2 class="font-bold text-yellow-800">⚠️ 未申請の受付案件</h2>
              <span class="ml-auto bg-yellow-500 text-white text-xs font-bold px-2 py-1 rounded-full">${(pendingInbox.results as any[]).length}件</span>
            </div>
            <div class="space-y-2">
              ${(pendingInbox.results as any[]).map((item: any) => `
                <div class="bg-white rounded-lg px-4 py-3 flex items-center justify-between shadow-sm">
                  <div>
                    <p class="font-semibold text-gray-800 text-sm">${item.mansion_name || '-'}</p>
                    <p class="text-xs text-gray-500 mt-0.5">担当: ${item.front_name || '-'} / 登録: ${item.created_at?.slice(0,10)}</p>
                    ${item.remind_count > 0 ? `<p class="text-xs text-orange-500 mt-0.5">リマインド ${item.remind_count}回送信済</p>` : '<p class="text-xs text-gray-400 mt-0.5">リマインド未送信</p>'}
                  </div>
                  <div class="flex gap-2">
                    <form method="POST" action="/inbox/${item.id}/remind" onsubmit="return confirm('${item.front_name}さんにリマインドを送信しますか？')">
                      <button type="submit" class="text-xs px-3 py-1.5 bg-orange-50 text-orange-600 hover:bg-orange-100 border border-orange-200 rounded-lg transition">再通知</button>
                    </form>
                    <a href="/inbox" class="text-xs px-3 py-1.5 bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200 rounded-lg transition">管理画面へ</a>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
          ` : ''}

          <!-- 統計カード -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <div class="flex items-center justify-between">
                <div><p class="text-sm text-gray-500">承認待ち</p><p class="text-3xl font-bold text-orange-500 mt-1">${pendingReviews.results.length}</p></div>
                <div class="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center">
                  <svg class="w-6 h-6 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                </div>
              </div>
            </div>
            <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <div class="flex items-center justify-between">
                <div><p class="text-sm text-gray-500">回答待ち（保留）</p><p class="text-3xl font-bold text-yellow-500 mt-1">${holdApps.results.length}</p></div>
                <div class="w-12 h-12 bg-yellow-100 rounded-full flex items-center justify-center">
                  <svg class="w-6 h-6 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                </div>
              </div>
            </div>
            <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <div class="flex items-center justify-between">
                <div><p class="text-sm text-gray-500">自分の申請件数</p><p class="text-3xl font-bold text-blue-500 mt-1">${myApps.results.length}</p></div>
                <div class="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
                  <svg class="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                </div>
              </div>
            </div>
          </div>

          ${pendingReviews.results.length > 0 ? `
          <div class="bg-white rounded-xl shadow-sm border border-gray-100">
            <div class="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
              <span class="w-3 h-3 bg-orange-400 rounded-full animate-pulse"></span>
              <h2 class="text-lg font-semibold text-gray-800">承認待ち案件</h2>
              <span class="ml-auto bg-orange-100 text-orange-600 text-xs font-semibold px-2 py-1 rounded-full">${pendingReviews.results.length}件</span>
            </div>
            <div class="divide-y divide-gray-50">
              ${(pendingReviews.results as any[]).map(app => `
                <div class="px-6 py-4 hover:bg-gray-50 transition">
                  <div class="flex items-center justify-between">
                    <div>
                      <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs text-gray-400">${app.application_number}</span>
                        ${app.resubmit_count > 0 ? `<span class="bg-purple-100 text-purple-600 text-xs px-2 py-0.5 rounded-full">再提出 ${app.resubmit_count}回</span>` : ''}
                      </div>
                      <p class="font-semibold text-gray-800">${app.mansion_name || app.title}</p>
                      <p class="text-sm text-gray-500 mt-0.5">ステップ ${app.step_number}</p>
                    </div>
                    <a href="/applications/${app.id}/review/${app.step_id}" class="bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition">承認する</a>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
          ` : ''}

          ${holdApps.results.length > 0 ? `
          <div class="bg-white rounded-xl shadow-sm border border-gray-100">
            <div class="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
              <span class="w-3 h-3 bg-yellow-400 rounded-full"></span>
              <h2 class="text-lg font-semibold text-gray-800">保留中（回答が必要）</h2>
            </div>
            <div class="divide-y divide-gray-50">
              ${(holdApps.results as any[]).map(app => `
                <div class="px-6 py-4 hover:bg-gray-50 transition">
                  <div class="flex items-center justify-between">
                    <div>
                      <p class="font-semibold text-gray-800">${app.mansion_name || app.title}</p>
                      <p class="text-sm text-yellow-600 mt-1">❓ ${app.question}</p>
                    </div>
                    <a href="/applications/${app.id}" class="bg-yellow-500 hover:bg-yellow-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition">回答する</a>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
          ` : ''}

          <!-- 自分の申請一覧 -->
          <div class="bg-white rounded-xl shadow-sm border border-gray-100">
            <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 class="text-lg font-semibold text-gray-800">自分の申請一覧</h2>
              <a href="/applications/new" class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition flex items-center gap-1">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                新規申請
              </a>
            </div>
            ${myApps.results.length === 0 ? `
              <div class="px-6 py-12 text-center text-gray-400">
                <svg class="w-12 h-12 mx-auto mb-3 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                <p>申請はまだありません</p>
              </div>
            ` : `
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead class="bg-gray-50">
                    <tr>
                      <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">申請番号</th>
                      <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">マンション名</th>
                      <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">支払先</th>
                      <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">金額</th>
                      <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
                      <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">申請日</th>
                      <th class="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-50">
                    ${(myApps.results as any[]).map(app => `
                      <tr class="hover:bg-gray-50">
                        <td class="px-4 py-3 text-gray-500 text-xs">${app.application_number}${app.resubmit_count > 0 ? `<span class="ml-1 bg-purple-100 text-purple-600 text-xs px-1.5 rounded">再提出</span>` : ''}</td>
                        <td class="px-4 py-3 font-medium text-gray-800">${app.mansion_name || app.title}</td>
                        <td class="px-4 py-3">${app.payment_target === 'kumiai' ? '<span class="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full">管理組合</span>' : '<span class="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full">会社(TD)</span>'}</td>
                        <td class="px-4 py-3 text-gray-700">${Number(app.budget_amount).toLocaleString()}円</td>
                        <td class="px-4 py-3">${statusBadge(app.status)}</td>
                        <td class="px-4 py-3 text-gray-400 text-xs">${app.created_at?.substring(0,10)}</td>
                        <td class="px-4 py-3"><a href="/applications/${app.id}" class="text-blue-600 hover:underline text-xs">詳細</a></td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            `}
          </div>
        </div>
      </div>
    </main>
  </div>
</body>
</html>`

  return c.html(html)
})

// ===== 申請関連 =====
app.route('/applications', applications)

// ===== ファイルダウンロード =====
app.get('/files/:attachId', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const att = await c.env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(c.req.param('attachId')).first() as any
  if (!att) return c.notFound()
  const obj = await c.env.R2.get(att.file_key)
  if (!obj) return c.notFound()

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(att.file_name)}"`,
    }
  })
})

// ===== 管理画面 =====
app.route('/admin', admin)

// ===== 請求書受付管理 =====
app.route('/inbox', inbox)

export default app
