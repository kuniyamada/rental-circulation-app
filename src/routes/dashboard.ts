import { Hono } from 'hono'
import { getSessionUser, getSessionIdFromCookie } from '../lib/auth'
import { layout, statusBadge } from './layout'

type Bindings = { DB: D1Database; R2: R2Bucket }
const dashboard = new Hono<{ Bindings: Bindings }>()

dashboard.get('/', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')
  if (user.must_change_password) return c.redirect('/change-password')

  const db = c.env.DB

  // 自分が申請した案件
  const myApps = await db.prepare(`
    SELECT a.*, m.name as mansion_name
    FROM applications a
    LEFT JOIN mansions m ON a.mansion_id = m.id
    WHERE a.applicant_id = ?
    ORDER BY a.created_at DESC
    LIMIT 20
  `).bind(user.uid).all()

  // 自分が承認待ちの案件
  const pendingReviews = await db.prepare(`
    SELECT a.*, m.name as mansion_name, cs.step_number, cs.id as step_id, cs.action_comment
    FROM circulation_steps cs
    JOIN applications a ON cs.application_id = a.id
    LEFT JOIN mansions m ON a.mansion_id = m.id
    WHERE cs.reviewer_id = ? AND cs.status = 'pending' AND a.status = 'circulating'
    ORDER BY a.created_at ASC
  `).bind(user.uid).all()

  // 保留（回答待ち）- 自分の申請で保留中
  const holdApps = await db.prepare(`
    SELECT a.*, m.name as mansion_name, cs.action_comment as question, cs.id as step_id
    FROM circulation_steps cs
    JOIN applications a ON cs.application_id = a.id
    LEFT JOIN mansions m ON a.mansion_id = m.id
    WHERE a.applicant_id = ? AND cs.status = 'on_hold'
    ORDER BY cs.created_at DESC
  `).bind(user.uid).all()

  const content = `
    <div class="space-y-8">
      <!-- 統計カード -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-gray-500">承認待ち</p>
              <p class="text-3xl font-bold text-orange-500 mt-1">${pendingReviews.results.length}</p>
            </div>
            <div class="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center">
              <svg class="w-6 h-6 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
          </div>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-gray-500">回答待ち（保留）</p>
              <p class="text-3xl font-bold text-yellow-500 mt-1">${holdApps.results.length}</p>
            </div>
            <div class="w-12 h-12 bg-yellow-100 rounded-full flex items-center justify-center">
              <svg class="w-6 h-6 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
          </div>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-gray-500">自分の申請件数</p>
              <p class="text-3xl font-bold text-blue-500 mt-1">${myApps.results.length}</p>
            </div>
            <div class="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
              <svg class="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            </div>
          </div>
        </div>
      </div>

      <!-- 承認待ち一覧 -->
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
                  <p class="text-sm text-gray-500 mt-0.5">ステップ ${app.step_number} / ${app.payment_target === 'kumiai' ? '4' : '4'}</p>
                </div>
                <a href="/applications/${app.id}/review/${app.step_id}"
                  class="bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition">
                  承認する
                </a>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      <!-- 保留・回答待ち -->
      ${holdApps.results.length > 0 ? `
      <div class="bg-white rounded-xl shadow-sm border border-gray-100">
        <div class="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <span class="w-3 h-3 bg-yellow-400 rounded-full"></span>
          <h2 class="text-lg font-semibold text-gray-800">保留中（回答が必要）</h2>
          <span class="ml-auto bg-yellow-100 text-yellow-600 text-xs font-semibold px-2 py-1 rounded-full">${holdApps.results.length}件</span>
        </div>
        <div class="divide-y divide-gray-50">
          ${(holdApps.results as any[]).map(app => `
            <div class="px-6 py-4 hover:bg-gray-50 transition">
              <div class="flex items-center justify-between">
                <div>
                  <span class="text-xs text-gray-400">${app.application_number}</span>
                  <p class="font-semibold text-gray-800">${app.mansion_name || app.title}</p>
                  <p class="text-sm text-yellow-600 mt-1">❓ ${app.question}</p>
                </div>
                <a href="/applications/${app.id}"
                  class="bg-yellow-500 hover:bg-yellow-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition">
                  回答する
                </a>
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
${(['admin','front','front_supervisor'].includes(user.role) || user.is_admin) ? `
          <a href="/applications/new" class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition flex items-center gap-1">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
            新規申請
          </a>
          ` : ''}
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
  `
  return c.html(layout('ダッシュボード', content, user))
})

export default dashboard
