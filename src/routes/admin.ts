import { Hono } from 'hono'
import { getSessionUser, getSessionIdFromCookie, hashPassword } from '../lib/auth'
import { layout } from './layout'

type Bindings = { DB: D1Database; R2: R2Bucket }
const admin = new Hono<{ Bindings: Bindings }>()

// 管理者チェックミドルウェア
admin.use('*', async (c, next) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')
  if (!user.is_admin) return c.redirect('/')
  c.set('user' as any, user)
  await next()
})

// ユーザー一覧
admin.get('/users', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const users = await db.prepare(`
    SELECT u.*, s.name as supervisor_name,
      os.id as ops_staff_id, os.is_primary as ops_is_primary,
      hs.id as honsha_staff_id
    FROM users u
    LEFT JOIN users s ON u.supervisor_id = s.id
    LEFT JOIN operations_staff os ON os.user_id = u.id
    LEFT JOIN honsha_staff hs ON hs.user_id = u.id
    ORDER BY CAST(u.employee_number AS INTEGER)
  `).all()

  // rolesテーブルからラベル・色を取得
  const rolesData = await db.prepare("SELECT * FROM roles WHERE is_active = 1").all()
  const roleMap: Record<string, {label: string, color: string}> = {}
  ;(rolesData.results as any[]).forEach((r: any) => { roleMap[r.value] = {label: r.label, color: r.color} })
  // フォールバック
  const roleColorClass: Record<string, string> = {
    blue: 'bg-[#EEF4FA] text-[#2E5580]', indigo: 'bg-indigo-50 text-indigo-700',
    orange: 'bg-orange-50 text-orange-700', yellow: 'bg-yellow-50 text-yellow-700',
    green: 'bg-green-50 text-green-700', red: 'bg-red-50 text-red-700',
    purple: 'bg-purple-50 text-purple-700', gray: 'bg-gray-100 text-gray-600'
  }

  const content = `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100">
      <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 class="font-semibold text-gray-800 flex items-center gap-2">
          <svg class="w-5 h-5 text-[#396999]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
          閲覧ユーザー一覧（${users.results.length}件）
        </h2>
        <div class="flex gap-2">
          <a href="/admin/users/export" class="bg-green-600 hover:bg-green-700 text-white text-xs font-semibold px-3 py-2 rounded-lg transition flex items-center gap-1">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            CSV出力
          </a>
          <a href="/admin/users/new" class="bg-[#396999] hover:bg-[#2E5580] text-white text-xs font-semibold px-3 py-2 rounded-lg transition flex items-center gap-1">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
            追加
          </a>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">社員番号 ▲</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">名前 ▲</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">役割 ▲</th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">メール ▲</th>
              <th class="px-3 py-3 text-center text-xs font-semibold text-gray-500 whitespace-nowrap">
                <svg class="w-3.5 h-3.5 inline mr-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
                メール
              </th>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">
                <span style="color:#00B900;">●</span> LINE WORKS ID
              </th>
              <th class="px-3 py-3 text-center text-xs font-semibold text-gray-500 whitespace-nowrap">
                <span style="color:#00B900;">●</span> LW通知
              </th>
              <th class="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${(users.results as any[]).map(u => {
              const rm = roleMap[u.role]
              const baseLabel = rm ? rm.label : u.role
              const isSupLabel = (u.is_supervisor && u.role === 'front') ? baseLabel + '/上司'
                               : (u.is_admin && u.role !== 'admin') ? baseLabel + '/責任者'
                               : baseLabel
              const colorKey = rm ? rm.color : 'gray'
              const cls = roleColorClass[colorKey] || 'bg-gray-100 text-gray-600'
              const emailOn = u.notify_method === 'email' || u.notify_method === 'both' || !u.notify_method
              const lwOn    = u.notify_method === 'lineworks' || u.notify_method === 'both'
              const hasLw   = !!u.lineworks_user_id
              return `
              <tr class="hover:bg-gray-50 transition">
                <td class="px-3 py-3 font-mono text-xs text-gray-500">${u.employee_number}</td>
                <td class="px-3 py-3">
                  <div class="font-semibold text-gray-800 text-sm">${u.name}</div>
                  ${u.is_admin ? '<span class="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded">管理者</span>' : ''}
                  ${!u.is_active ? '<span class="text-xs bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded">無効</span>' : ''}
                </td>
                <td class="px-3 py-3">
                  <span class="${cls} text-xs px-2 py-0.5 rounded-full whitespace-nowrap">${isSupLabel}</span>
                </td>
                <td class="px-3 py-3 text-gray-500 text-xs max-w-[160px] truncate">${u.email || '-'}</td>

                <!-- メール通知トグル -->
                <td class="px-3 py-3 text-center">
                  <button
                    type="button"
                    onclick="toggleNotify(${u.id}, 'email', this)"
                    data-on="${emailOn ? '1' : '0'}"
                    title="${emailOn ? 'メール通知ON' : 'メール通知OFF'}"
                    class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${emailOn ? 'bg-[#396999]' : 'bg-gray-200'}">
                    <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${emailOn ? 'translate-x-6' : 'translate-x-1'}"></span>
                  </button>
                </td>

                <!-- LINE WORKS ID -->
                <td class="px-3 py-3">
                  ${hasLw
                    ? `<span class="text-xs text-gray-600 flex items-center gap-1">
                        <span style="color:#00B900;font-size:10px;">●</span>
                        <span class="truncate max-w-[130px]">${u.lineworks_user_id}</span>
                       </span>`
                    : `<span class="text-xs text-gray-300">未設定</span>`
                  }
                </td>

                <!-- LW通知トグル -->
                <td class="px-3 py-3 text-center">
                  ${hasLw
                    ? `<button
                        type="button"
                        onclick="toggleNotify(${u.id}, 'lineworks', this)"
                        data-on="${lwOn ? '1' : '0'}"
                        title="${lwOn ? 'LW通知ON' : 'LW通知OFF'}"
                        class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${lwOn ? 'bg-green-500' : 'bg-gray-200'}">
                        <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${lwOn ? 'translate-x-6' : 'translate-x-1'}"></span>
                       </button>`
                    : `<span class="text-xs text-gray-300">-</span>`
                  }
                </td>

                <td class="px-3 py-3">
                  <div class="flex flex-col gap-1 items-start">
                    <a href="/admin/users/${u.id}/edit" class="flex items-center gap-1 text-[#396999] hover:text-[#234166] text-xs font-medium px-2 py-1 bg-[#EEF4FA] hover:bg-[#D5E5F2] rounded transition whitespace-nowrap">
                      <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                      編集
                    </a>
                    ${hasLw ? `
                    <button type="button" onclick="lwTest(${u.id}, '${u.name.replace(/'/g, "\\'")}')"
                      class="flex items-center gap-1 text-green-600 hover:text-green-800 text-xs font-medium px-2 py-1 bg-green-50 hover:bg-green-100 rounded transition whitespace-nowrap">
                      <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
                      LWテスト
                    </button>
                    ` : ''}
                    ${u.employee_number !== 'admin' ? `
                    <button type="button" onclick="deleteUser(${u.id}, '${u.name.replace(/'/g, "\\'")}')"
                      class="flex items-center gap-1 text-red-500 hover:text-red-700 text-xs font-medium px-2 py-1 bg-red-50 hover:bg-red-100 rounded transition whitespace-nowrap">
                      <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                      削除
                    </button>
                    ` : '<span class="text-xs text-gray-300">-</span>'}
                  </div>
                </td>
              </tr>
              `
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `

  // 削除確認モーダル + 隠しフォーム
  const deleteModal = `
    <!-- 削除確認モーダル -->
    <div id="deleteModal" class="hidden fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
      <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600 text-xl">⚠️</div>
          <h3 class="font-bold text-gray-800 text-lg">ユーザー削除の確認</h3>
        </div>
        <p class="text-gray-600 text-sm mb-2">以下のユーザーを削除します。</p>
        <p class="font-semibold text-gray-800 text-base mb-4" id="deleteTargetName"></p>
        <p class="text-xs text-red-500 bg-red-50 rounded p-2 mb-5">⚠ この操作は取り消せません。関連する担当者設定も解除されます。</p>
        <div class="flex gap-3">
          <button onclick="closeDeleteModal()" class="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition">キャンセル</button>
          <button onclick="submitDelete()" class="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition">削除する</button>
        </div>
      </div>
    </div>

    <!-- 削除用隠しフォーム -->
    <form id="deleteForm" method="POST" action="" class="hidden"></form>

    <!-- LINE WORKS テスト送信モーダル -->
    <div id="lwTestModal" class="hidden fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
      <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center text-xl" style="color:#00B900;">●</div>
          <div>
            <h3 class="font-bold text-gray-800 text-base">LINE WORKS テスト送信</h3>
            <p class="text-xs text-gray-500" id="lwTestTargetName"></p>
          </div>
        </div>
        <!-- スピナー -->
        <div id="lwTestSpinner" class="flex flex-col items-center py-4 gap-2">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500"></div>
          <p class="text-sm text-gray-500">送信中...</p>
        </div>
        <!-- 結果 -->
        <p id="lwTestStatus" class="hidden"></p>
        <p id="lwTestMessage" class="text-sm text-gray-600 text-center mt-2 min-h-[1.5rem]"></p>
        <!-- 閉じるボタン -->
        <div id="lwTestCloseBtn" class="hidden mt-5">
          <button onclick="closeLwTestModal()" class="w-full px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition">閉じる</button>
        </div>
      </div>
    </div>

    <script>
      function deleteUser(userId, userName) {
        document.getElementById('deleteTargetName').textContent = '【' + userName + '】';
        document.getElementById('deleteForm').action = '/admin/users/' + userId + '/delete';
        document.getElementById('deleteModal').classList.remove('hidden');
      }
      function closeDeleteModal() {
        document.getElementById('deleteModal').classList.add('hidden');
      }
      function submitDelete() {
        document.getElementById('deleteForm').submit();
      }
      document.getElementById('deleteModal').addEventListener('click', function(e) {
        if (e.target === this) closeDeleteModal();
      });
      document.getElementById('lwTestModal').addEventListener('click', function(e) {
        if (e.target === this) closeLwTestModal();
      });

      // LINE WORKS テスト送信
      async function lwTest(userId, userName) {
        const modal = document.getElementById('lwTestModal');
        const nameEl = document.getElementById('lwTestTargetName');
        const statusEl = document.getElementById('lwTestStatus');
        const msgEl = document.getElementById('lwTestMessage');

        nameEl.textContent = userName + ' さん';
        statusEl.className = 'hidden';
        msgEl.textContent = '';
        document.getElementById('lwTestSpinner').classList.remove('hidden');
        document.getElementById('lwTestCloseBtn').classList.add('hidden');
        modal.classList.remove('hidden');

        try {
          const res = await fetch('/admin/users/' + userId + '/lw-test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          const data = await res.json();
          document.getElementById('lwTestSpinner').classList.add('hidden');
          document.getElementById('lwTestCloseBtn').classList.remove('hidden');
          if (data.ok) {
            statusEl.textContent = '✅ 送信成功';
            statusEl.className = 'text-center text-green-600 font-semibold text-base';
            msgEl.textContent = data.message || '送信しました';
          } else {
            statusEl.textContent = '❌ 送信失敗';
            statusEl.className = 'text-center text-red-600 font-semibold text-base';
            msgEl.textContent = data.error || '不明なエラー';
          }
        } catch(e) {
          document.getElementById('lwTestSpinner').classList.add('hidden');
          document.getElementById('lwTestCloseBtn').classList.remove('hidden');
          statusEl.textContent = '❌ 通信エラー';
          statusEl.className = 'text-center text-red-600 font-semibold text-base';
          msgEl.textContent = String(e);
        }
      }
      function closeLwTestModal() {
        document.getElementById('lwTestModal').classList.add('hidden');
      }

      // 通知トグル: メール or LINE WORKS を即時保存
      async function toggleNotify(userId, type, btn) {
        const currentOn = btn.dataset.on === '1';
        const newOn = !currentOn;

        // UI即時更新
        btn.dataset.on = newOn ? '1' : '0';
        if (type === 'email') {
          btn.className = 'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ' + (newOn ? 'bg-[#396999]' : 'bg-gray-200');
        } else {
          btn.className = 'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ' + (newOn ? 'bg-green-500' : 'bg-gray-200');
        }
        btn.querySelector('span').className = 'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ' + (newOn ? 'translate-x-6' : 'translate-x-1');
        btn.title = type === 'email'
          ? (newOn ? 'メール通知ON' : 'メール通知OFF')
          : (newOn ? 'LW通知ON' : 'LW通知OFF');

        // サーバーへ保存
        try {
          const res = await fetch('/admin/users/' + userId + '/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, on: newOn })
          });
          if (!res.ok) throw new Error('save failed');
        } catch(e) {
          // 失敗時はロールバック
          btn.dataset.on = currentOn ? '1' : '0';
          if (type === 'email') {
            btn.className = 'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ' + (currentOn ? 'bg-[#396999]' : 'bg-gray-200');
          } else {
            btn.className = 'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ' + (currentOn ? 'bg-green-500' : 'bg-gray-200');
          }
          btn.querySelector('span').className = 'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ' + (currentOn ? 'translate-x-6' : 'translate-x-1');
          alert('保存に失敗しました。再度お試しください。');
        }
      }
    </script>
  `

  // 削除完了・エラーメッセージ
  const params = new URL(c.req.url).searchParams
  const alertMsg = params.get('deleted') === '1'
    ? '<div class="mb-4 px-4 py-3 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm">✅ ユーザーを削除しました。</div>'
    : params.get('error') === 'self'
    ? '<div class="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">❌ 自分自身は削除できません。</div>'
    : params.get('error') === 'admin'
    ? '<div class="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">❌ システム管理者は削除できません。</div>'
    : ''

  return c.html(layout('ユーザー管理', alertMsg + content + deleteModal, user))
})

// ユーザー削除
admin.post('/users/:id/delete', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')

  // 自分自身は削除不可
  const me = (c as any).get('user')
  if (String(me.uid) === String(id)) {
    return c.redirect('/admin/users?error=self')
  }

  // adminユーザーは削除不可
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first() as any
  if (!target) return c.redirect('/admin/users')
  if (target.employee_number === 'admin') return c.redirect('/admin/users?error=admin')

  // 関連データを削除
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run()
  await db.prepare('DELETE FROM operations_staff WHERE user_id = ?').bind(id).run()
  await db.prepare('DELETE FROM honsha_staff WHERE user_id = ?').bind(id).run()
  // 上長として設定されている場合は解除
  await db.prepare('UPDATE users SET supervisor_id = NULL WHERE supervisor_id = ?').bind(id).run()
  // ユーザー削除
  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run()

  return c.redirect('/admin/users?deleted=1')
})

// 通知設定トグル AJAX API
admin.post('/users/:id/notify', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.json() as { type: 'email' | 'lineworks'; on: boolean }

  // 現在の notify_method を取得
  const u = await db.prepare('SELECT notify_method FROM users WHERE id = ?').bind(id).first() as any
  if (!u) return c.json({ ok: false, error: 'not found' }, 404)

  const current = u.notify_method || 'email'
  const emailOn = current === 'email' || current === 'both'
  const lwOn    = current === 'lineworks' || current === 'both'

  let newEmailOn = emailOn
  let newLwOn    = lwOn

  if (body.type === 'email')     newEmailOn = body.on
  if (body.type === 'lineworks') newLwOn    = body.on

  let newMethod: string
  if (newEmailOn && newLwOn)       newMethod = 'both'
  else if (newEmailOn)             newMethod = 'email'
  else if (newLwOn)                newMethod = 'lineworks'
  else                             newMethod = 'email'  // 両方OFFはメールに戻す

  await db.prepare('UPDATE users SET notify_method = ?, updated_at = datetime("now") WHERE id = ?')
    .bind(newMethod, id).run()

  return c.json({ ok: true, notify_method: newMethod })
})

// LINE WORKS テスト送信 AJAX API（ユーザー管理画面から）
admin.post('/users/:id/lw-test', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')

  // 対象ユーザーを取得
  const target = await db.prepare(
    'SELECT id, name, lineworks_user_id FROM users WHERE id = ?'
  ).bind(id).first() as any
  if (!target) return c.json({ ok: false, error: 'ユーザーが見つかりません' }, 404)
  if (!target.lineworks_user_id) return c.json({ ok: false, error: 'LINE WORKS IDが未設定です' })

  // LINE WORKS設定を取得
  const lwConfig = await db.prepare(
    'SELECT * FROM lineworks_config WHERE is_active = 1 LIMIT 1'
  ).first() as any
  if (!lwConfig) return c.json({ ok: false, error: 'LINE WORKS設定が未登録です' })

  try {
    const { sendLineWorksMessage, rowToConfig } = await import('../lib/lineworks')
    const config = rowToConfig(lwConfig)

    // アクセストークン未設定チェック
    const now = Math.floor(Date.now() / 1000)
    if (!config.accessToken && !config.refreshToken) {
      return c.json({
        ok: false,
        error: 'LINE WORKSアクセストークンが設定されていません。管理画面の「LINE WORKS設定」→「トークン設定」からアクセストークンを登録してください。',
        needsToken: true
      })
    }

    const msg = {
      type: 'text' as const,
      text: `【テスト通知】\n宛先: ${target.name} さん\nこのメッセージはユーザー管理画面から送信されたテストです。\nLINE WORKS通知は正常に動作しています。`,
    }
    const result = await sendLineWorksMessage(config, target.lineworks_user_id, msg)
    if (result === true) {
      return c.json({ ok: true, message: `${target.name} さんへ送信しました` })
    } else {
      return c.json({ ok: false, error: result })
    }
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '不明なエラー' })
  }
})

// ユーザー一覧 CSV出力
admin.get('/users/export', async (c) => {
  const db = c.env.DB
  const users = await db.prepare(`
    SELECT employee_number, name, email, role, department,
      is_admin, is_supervisor, is_active, notify_method, lineworks_user_id
    FROM users ORDER BY CAST(employee_number AS INTEGER)
  `).all()

  const header = ['社員番号', '氏名', 'メール', '役割', '部署', '管理者', '上司', '有効', '通知方法', 'LINE WORKS ID']
  const rows = (users.results as any[]).map(u => [
    u.employee_number, u.name, u.email || '', u.role, u.department || '',
    u.is_admin ? '1' : '0', u.is_supervisor ? '1' : '0', u.is_active ? '1' : '0',
    u.notify_method || 'email', u.lineworks_user_id || ''
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))

  const csv = '\uFEFF' + [header.join(','), ...rows].join('\r\n')
  const now = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="users_${now}.csv"`,
    }
  })
})

// ユーザー追加フォーム
admin.get('/users/new', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const supervisors = await db.prepare("SELECT * FROM users WHERE is_active = 1 ORDER BY name").all()
  const roles = await db.prepare("SELECT * FROM roles WHERE is_active = 1 ORDER BY sort_order").all()
  return c.html(layout('ユーザー追加', userForm(null, supervisors.results as any[], undefined, undefined, roles.results as any[]), user))
})

// ユーザー追加処理
admin.post('/users', async (c) => {
  const db = c.env.DB
  const body = await c.req.parseBody() as any
  const hash = await hashPassword(body.employee_number) // 初期PW=社員番号
  await db.prepare(`
    INSERT INTO users (employee_number, name, email, department, role, is_supervisor, is_admin, supervisor_id, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(
    body.employee_number, body.name, body.email, body.department || null,
    body.role, body.is_supervisor ? 1 : 0, body.is_admin ? 1 : 0,
    body.supervisor_id ? parseInt(body.supervisor_id) : null, hash
  ).run()
  return c.redirect('/admin/users')
})

// ユーザー編集フォーム
admin.get('/users/:id/edit', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(c.req.param('id')).first() as any
  const supervisors = await db.prepare("SELECT * FROM users WHERE is_active = 1 ORDER BY name").all()
  const roles = await db.prepare("SELECT * FROM roles WHERE is_active = 1 ORDER BY sort_order").all()
  if (!target) return c.redirect('/admin/users')
  // 担当区分情報を取得
  const opsStaff = await db.prepare('SELECT * FROM operations_staff WHERE user_id = ?').bind(target.id).first() as any
  const honshaStaff = await db.prepare('SELECT * FROM honsha_staff WHERE user_id = ?').bind(target.id).first() as any
  return c.html(layout('ユーザー編集', userForm(target, supervisors.results as any[], opsStaff, honshaStaff, roles.results as any[]), user))
})

// ユーザー更新処理
admin.post('/users/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.parseBody() as any
  await db.prepare(`
    UPDATE users SET name=?, email=?, department=?, role=?, is_supervisor=?, is_admin=?, supervisor_id=?, is_active=?,
      lineworks_user_id=?, notify_method=?, updated_at=datetime("now")
    WHERE id=?
  `).bind(
    body.name, body.email, body.department || null,
    body.role, body.is_supervisor ? 1 : 0, body.is_admin ? 1 : 0,
    body.supervisor_id ? parseInt(body.supervisor_id) : null,
    body.is_active ? 1 : 0,
    body.lineworks_user_id || null,
    body.notify_method || 'email',
    id
  ).run()

  // パスワードリセット
  if (body.reset_password) {
    const hash = await hashPassword(body.employee_number)
    await db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?').bind(hash, id).run()
  }

  // ---- 担当区分の更新（operations_staff / honsha_staff）----
  // まず既存の担当設定をクリア
  await db.prepare('DELETE FROM operations_staff WHERE user_id = ?').bind(id).run()
  await db.prepare('DELETE FROM honsha_staff WHERE user_id = ?').bind(id).run()

  // 役割が operations の場合、担当/予備を登録
  if (body.role === 'operations' && body.ops_assignment) {
    const isPrimary = body.ops_assignment === 'primary' ? 1 : 0
    await db.prepare('INSERT OR IGNORE INTO operations_staff (user_id, is_primary) VALUES (?, ?)')
      .bind(id, isPrimary).run()
  }
  // 役割が honsha の場合、本社経理担当として登録
  if (body.role === 'honsha' && body.honsha_assignment === '1') {
    await db.prepare('INSERT OR IGNORE INTO honsha_staff (user_id) VALUES (?)').bind(id).run()
  }

  return c.redirect('/admin/users')
})

function userForm(user: any, supervisors: any[], opsStaff?: any, honshaStaff?: any, roles: any[] = []): string {
  // rolesが空の場合はデフォルト
  if (roles.length === 0) {
    roles = [
      { value: 'front', label: '担当者' },
      { value: 'operations', label: '業務管理課' },
      { value: 'accounting', label: '会計課' },
      { value: 'honsha', label: '本社経理' },
      { value: 'admin', label: '管理者' },
    ]
  }
  const isEdit = !!user

  return `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6 max-w-2xl">
      <form method="POST" action="${isEdit ? `/admin/users/${user.id}` : '/admin/users'}">
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">社員番号 <span class="text-red-500">*</span></label>
              <input type="text" name="employee_number" value="${user?.employee_number || ''}" ${isEdit ? 'readonly' : 'required'}
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none ${isEdit ? 'bg-gray-50' : ''}">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">氏名 <span class="text-red-500">*</span></label>
              <input type="text" name="name" value="${user?.name || ''}" required
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            </div>
          </div>
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">メールアドレス <span class="text-red-500">*</span></label>
            <input type="email" name="email" value="${user?.email || ''}" required
              class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">部署</label>
              <input type="text" name="department" value="${user?.department || ''}"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">役割 <span class="text-red-500">*</span></label>
              <select name="role" required class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
                ${roles.map(r => `<option value="${r.value}" ${user?.role === r.value ? 'selected' : ''}>${r.label}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="flex gap-4 flex-wrap">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" name="is_admin" value="1" ${user?.is_admin ? 'checked' : ''}
                class="w-4 h-4 text-[#396999] rounded">
              <span class="text-sm">管理者権限</span>
            </label>
            ${isEdit ? `
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" name="is_active" value="1" ${user?.is_active ? 'checked' : ''}
                class="w-4 h-4 text-[#396999] rounded">
              <span class="text-sm">アカウント有効</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" name="reset_password" value="1"
                class="w-4 h-4 text-orange-500 rounded">
              <span class="text-sm text-orange-600">パスワードリセット（社員番号に戻す）</span>
            </label>
            ` : ''}
          </div>

          <!-- LINE WORKS 通知設定 -->
          <div class="border-t border-gray-100 pt-4 mt-2">
            <h3 class="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <span style="color:#00B900;">●</span> LINE WORKS 通知設定
            </h3>
            <div class="grid grid-cols-1 gap-3">
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-1.5">LINE WORKS ユーザーID</label>
                <input type="text" name="lineworks_user_id" value="${user?.lineworks_user_id || ''}"
                  placeholder="例: yamada@tokyo-defense"
                  class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
                <p class="text-xs text-gray-400 mt-1">LINE WORKS のユーザーID（例: yamada@tokyo-defense）</p>
              </div>
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-1.5">通知方法</label>
                <select name="notify_method" class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
                  <option value="email" ${(!user?.notify_method || user?.notify_method === 'email') ? 'selected' : ''}>📧 メールのみ</option>
                  <option value="lineworks" ${user?.notify_method === 'lineworks' ? 'selected' : ''}>💬 LINE WORKSのみ</option>
                  <option value="both" ${user?.notify_method === 'both' ? 'selected' : ''}>📧💬 メール + LINE WORKS（両方）</option>
                </select>
              </div>
            </div>
          </div>

        </div>
        <div class="flex gap-3 mt-6">
          <a href="/admin/users" class="px-4 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition">キャンセル</a>
          <button type="submit" class="bg-[#396999] hover:bg-[#2E5580] text-white font-semibold px-6 py-2.5 rounded-lg transition text-sm">
            ${isEdit ? '更新する' : '追加する'}
          </button>
        </div>
      </form>
    </div>
    <script>
    </script>
  `
}

// マンション一覧
admin.get('/mansions', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const mansions = await db.prepare(`
    SELECT m.*, uf.name as front_name, ua.name as accounting_name
    FROM mansions m
    LEFT JOIN users uf ON m.front_user_id = uf.id
    LEFT JOIN users ua ON m.accounting_user_id = ua.id
    ORDER BY CAST(m.mansion_number AS INTEGER)
  `).all()

  const content = `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100">
      <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 class="font-semibold text-gray-800">マンション一覧 <span class="text-[#396999]">${mansions.results.length}件</span></h2>
        <a href="/admin/mansions/new" class="bg-[#396999] hover:bg-[#2E5580] text-white text-sm font-semibold px-4 py-2 rounded-lg transition">＋ マンション追加</a>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-3 py-3 text-left text-xs font-semibold text-gray-500 w-16">番号</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">マンション名</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            ${(mansions.results as any[]).length === 0 ? '<tr><td colspan="4" class="px-4 py-8 text-center text-gray-400">マンションが登録されていません</td></tr>' :
              (mansions.results as any[]).map(m => `
                <tr class="hover:bg-gray-50">
                  <td class="px-3 py-3 text-center font-mono text-xs text-gray-400 bg-gray-50">${m.mansion_number ?? '-'}</td>
                  <td class="px-4 py-3 font-medium">${m.name}</td>
                  <td class="px-4 py-3">
                    <form method="POST" action="/admin/mansions/${m.id}/toggle" class="flex items-center gap-2">
                      <button type="submit" class="relative inline-flex items-center w-11 h-6 rounded-full transition-colors focus:outline-none ${m.is_active ? 'bg-green-500' : 'bg-gray-300'}">
                        <span class="inline-block w-4 h-4 bg-white rounded-full shadow transition-transform ${m.is_active ? 'translate-x-6' : 'translate-x-1'}"></span>
                      </button>
                      <span class="text-xs ${m.is_active ? 'text-green-600 font-medium' : 'text-gray-400'}">${m.is_active ? 'ON' : 'OFF'}</span>
                    </form>
                  </td>
                  <td class="px-4 py-3"><a href="/admin/mansions/${m.id}/edit" class="text-[#396999] hover:underline text-xs">編集</a></td>
                </tr>
              `).join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `
  return c.html(layout('マンション管理', content, user))
})

// マンション追加フォーム
admin.get('/mansions/new', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const users = await db.prepare("SELECT * FROM users WHERE is_active = 1 ORDER BY name").all()
  return c.html(layout('マンション追加', mansionForm(null, users.results as any[]), user))
})

// マンション追加
admin.post('/mansions', async (c) => {
  const db = c.env.DB
  const body = await c.req.parseBody() as any
  const mansionNumber = body.mansion_number ? parseInt(body.mansion_number) : null
  await db.prepare(
    'INSERT INTO mansions (name, mansion_number, front_user_id, accounting_user_id) VALUES (?, ?, ?, ?)'
  ).bind(body.name, mansionNumber, body.front_user_id || null, body.accounting_user_id || null).run()
  return c.redirect('/admin/mansions')
})

// マンション編集フォーム
admin.get('/mansions/:id/edit', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const mansion = await db.prepare('SELECT * FROM mansions WHERE id = ?').bind(c.req.param('id')).first()
  const users = await db.prepare("SELECT * FROM users WHERE is_active = 1 ORDER BY name").all()
  if (!mansion) return c.redirect('/admin/mansions')
  return c.html(layout('マンション編集', mansionForm(mansion as any, users.results as any[]), user))
})

// 状態トグル
admin.post('/mansions/:id/toggle', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  await db.prepare(
    'UPDATE mansions SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END, updated_at = datetime("now") WHERE id = ?'
  ).bind(id).run()
  return c.redirect('/admin/mansions')
})

// マンション更新
admin.post('/mansions/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.parseBody() as any
  const mansionNumber = body.mansion_number ? parseInt(body.mansion_number) : null
  await db.prepare(
    'UPDATE mansions SET name=?, mansion_number=?, front_user_id=?, accounting_user_id=?, is_active=?, updated_at=datetime("now") WHERE id=?'
  ).bind(body.name, mansionNumber, body.front_user_id || null, body.accounting_user_id || null, body.is_active ? 1 : 0, id).run()
  return c.redirect('/admin/mansions')
})

function mansionForm(mansion: any, users: any[]): string {
  const isEdit = !!mansion
  const fronts = users.filter(u => ['front', 'manager', 'operations', 'admin'].includes(u.role))
  const accountings = users.filter(u => ['accounting', 'honsha', 'admin'].includes(u.role))

  return `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6 max-w-xl">
      <form method="POST" action="${isEdit ? `/admin/mansions/${mansion.id}` : '/admin/mansions'}">
        <div class="space-y-4">
          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">管理組合番号</label>
              <input type="number" name="mansion_number" value="${mansion?.mansion_number ?? ''}" placeholder="例: 1"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            </div>
            <div class="col-span-2">
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">マンション名 <span class="text-red-500">*</span></label>
              <input type="text" name="name" value="${mansion?.name || ''}" required
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            </div>
          </div>
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">担当フロント</label>
            <select name="front_user_id" class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
              <option value="">選択してください</option>
              ${fronts.map(u => `<option value="${u.id}" ${mansion?.front_user_id === u.id ? 'selected' : ''}>${u.name}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">管理組合 会計担当者</label>
            <select name="accounting_user_id" class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
              <option value="">選択してください</option>
              ${accountings.map(u => `<option value="${u.id}" ${mansion?.accounting_user_id === u.id ? 'selected' : ''}>${u.name}</option>`).join('')}
            </select>
          </div>
          ${isEdit ? `
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" name="is_active" value="1" ${mansion?.is_active ? 'checked' : ''} class="w-4 h-4 text-[#396999] rounded">
            <span class="text-sm">有効</span>
          </label>
          ` : ''}
        </div>
        <div class="flex gap-3 mt-6">
          <a href="/admin/mansions" class="px-4 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition">キャンセル</a>
          <button type="submit" class="bg-[#396999] hover:bg-[#2E5580] text-white font-semibold px-6 py-2.5 rounded-lg transition text-sm">${isEdit ? '更新する' : '追加する'}</button>
        </div>
      </form>
    </div>
  `
}

// 担当者設定（業務管理課・本社経理）
admin.get('/staff', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const ops = await db.prepare(`
    SELECT os.*, u.name, u.employee_number FROM operations_staff os JOIN users u ON os.user_id = u.id
  `).all()
  const honsha = await db.prepare(`
    SELECT hs.*, u.name, u.employee_number FROM honsha_staff hs JOIN users u ON hs.user_id = u.id
  `).all()
  const allUsers = await db.prepare("SELECT * FROM users WHERE is_active = 1 ORDER BY name").all()

  const content = `
    <div class="space-y-6 max-w-2xl">
      <!-- 業務管理課 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 class="font-semibold text-gray-800 mb-4">業務管理課担当者設定</h2>
        <div class="space-y-2 mb-4">
          ${(ops.results as any[]).map(o => `
            <div class="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3">
              <div>
                <span class="font-medium text-sm">${o.name}</span>
                <span class="text-xs text-gray-400 ml-2">${o.employee_number}</span>
                <span class="ml-2 text-xs ${o.is_primary ? 'bg-[#D5E5F2] text-[#396999]' : 'bg-gray-100 text-gray-500'} px-2 py-0.5 rounded-full">${o.is_primary ? '担当' : '予備'}</span>
              </div>
              <form method="POST" action="/admin/staff/ops/${o.id}/delete"><button type="submit" class="text-red-400 hover:text-red-600 text-xs" onclick="return confirm('削除しますか？')">削除</button></form>
            </div>
          `).join('')}
        </div>
        <form method="POST" action="/admin/staff/ops" class="flex gap-2">
          <select name="user_id" required class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            <option value="">ユーザーを選択</option>
            ${(allUsers.results as any[]).map(u => `<option value="${u.id}">${u.name}</option>`).join('')}
          </select>
          <select name="is_primary" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            <option value="1">担当</option>
            <option value="0">予備</option>
          </select>
          <button type="submit" class="bg-[#396999] text-white text-sm px-4 py-2 rounded-lg hover:bg-[#2E5580] transition">追加</button>
        </form>
      </div>

      <!-- 本社経理 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 class="font-semibold text-gray-800 mb-4">本社経理担当者設定</h2>
        <div class="space-y-2 mb-4">
          ${(honsha.results as any[]).map(h => `
            <div class="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3">
              <div>
                <span class="font-medium text-sm">${h.name}</span>
                <span class="text-xs text-gray-400 ml-2">${h.employee_number}</span>
              </div>
              <form method="POST" action="/admin/staff/honsha/${h.id}/delete"><button type="submit" class="text-red-400 hover:text-red-600 text-xs" onclick="return confirm('削除しますか？')">削除</button></form>
            </div>
          `).join('')}
        </div>
        <form method="POST" action="/admin/staff/honsha" class="flex gap-2">
          <select name="user_id" required class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            <option value="">ユーザーを選択</option>
            ${(allUsers.results as any[]).map(u => `<option value="${u.id}">${u.name}</option>`).join('')}
          </select>
          <button type="submit" class="bg-[#396999] text-white text-sm px-4 py-2 rounded-lg hover:bg-[#2E5580] transition">追加</button>
        </form>
      </div>
    </div>
  `
  return c.html(layout('スタッフ担当者設定', content, user))
})

admin.post('/staff/ops', async (c) => {
  const body = await c.req.parseBody() as any
  await c.env.DB.prepare('INSERT OR IGNORE INTO operations_staff (user_id, is_primary) VALUES (?, ?)').bind(body.user_id, body.is_primary).run()
  return c.redirect('/admin/staff')
})
admin.post('/staff/ops/:id/delete', async (c) => {
  await c.env.DB.prepare('DELETE FROM operations_staff WHERE id = ?').bind(c.req.param('id')).run()
  return c.redirect('/admin/staff')
})
admin.post('/staff/honsha', async (c) => {
  const body = await c.req.parseBody() as any
  await c.env.DB.prepare('INSERT OR IGNORE INTO honsha_staff (user_id) VALUES (?)').bind(body.user_id).run()
  return c.redirect('/admin/staff')
})
admin.post('/staff/honsha/:id/delete', async (c) => {
  await c.env.DB.prepare('DELETE FROM honsha_staff WHERE id = ?').bind(c.req.param('id')).run()
  return c.redirect('/admin/staff')
})

// SMTP設定（Gmail専用）
admin.get('/smtp', async (c) => {
  const user = (c as any).get('user')
  const smtp = await c.env.DB.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any
  const saved = c.req.query('saved')

  const content = `
    <div class="space-y-5 max-w-xl">
      <!-- Gmail設定状態バナー -->
      <div class="bg-[#EEF4FA] border border-[#AECBE5] rounded-xl p-4 flex items-start gap-3">
        <svg class="w-5 h-5 text-[#396999] mt-0.5 shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.910 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/>
        </svg>
        <div>
          <p class="text-sm font-semibold text-[#234166]">Gmail送信設定</p>
          <p class="text-xs text-[#396999] mt-0.5">送信元アカウント：<strong>tokyo.defense.mail@gmail.com</strong></p>
          <p class="text-xs text-[#396999] mt-0.5">メール送信には MailChannels API を経由してGmail認証を行います。</p>
        </div>
      </div>

      ${saved ? `<div class="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">✅ 設定を保存しました。</div>` : ''}

      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <form method="POST" action="/admin/smtp">
          <!-- 固定値（非表示） -->
          <input type="hidden" name="host" value="smtp.gmail.com">
          <input type="hidden" name="port" value="587">
          <input type="hidden" name="use_tls" value="1">

          <div class="space-y-4">
            <!-- Gmailアドレス -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">
                Gmailアドレス
                <span class="text-red-500">*</span>
              </label>
              <div class="relative">
                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.910 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/></svg>
                </span>
                <input type="email" name="username" name2="from_email"
                  value="${smtp?.username || 'tokyo.defense.mail@gmail.com'}"
                  required
                  class="w-full pl-9 pr-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none bg-gray-50"
                  readonly>
              </div>
              <input type="hidden" name="from_email" value="${smtp?.from_email || 'tokyo.defense.mail@gmail.com'}">
            </div>

            <!-- Gmailパスワード -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">
                Gmailパスワード（またはアプリパスワード）
                <span class="text-red-500">*</span>
              </label>
              <input type="password" name="password"
                placeholder="変更する場合のみ入力（空欄=現在の設定を維持）"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
              <p class="text-xs text-gray-400 mt-1">
                現在のパスワードは設定済みです。変更する場合のみ入力してください。
              </p>
            </div>

            <!-- 送信者名 -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">送信者名（メールの差出人表示）</label>
              <input type="text" name="from_name"
                value="${smtp?.from_name || '請求書回覧システム（東京ディフェンス）'}"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            </div>

            <!-- 現在の設定確認（読み取り専用） -->
            <div class="bg-gray-50 rounded-lg p-4 text-xs text-gray-500 space-y-1">
              <p class="font-semibold text-gray-600 mb-2">📋 現在の設定</p>
              <p>SMTPサーバー：smtp.gmail.com:587（TLS有効・固定）</p>
              <p>送信元アドレス：${smtp?.from_email || 'tokyo.defense.mail@gmail.com'}</p>
              <p>送信者名：${smtp?.from_name || '請求書回覧システム（東京ディフェンス）'}</p>
              <p>パスワード：${smtp?.password ? '設定済み ✅' : '未設定 ⚠️'}</p>
            </div>
          </div>

          <div class="flex gap-3 mt-6">
            <button type="submit"
              class="bg-[#396999] hover:bg-[#2E5580] text-white font-semibold px-6 py-2.5 rounded-lg transition text-sm">
              保存する
            </button>
          </div>
        </form>
      </div>

      <!-- 注意事項 -->
      <div class="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
        <p class="font-semibold mb-2">⚠️ Gmailご利用の注意事項</p>
        <ul class="list-disc list-inside space-y-1 text-xs">
          <li>Googleアカウントの「2段階認証」が必要です</li>
          <li>通常のパスワードではなく<strong>アプリパスワード</strong>（16桁）の使用を推奨します</li>
          <li>アプリパスワード：Googleアカウント → セキュリティ → アプリパスワード</li>
          <li>メール送信にはMailChannels APIを経由します（Cloudflare Workers制約のため）</li>
        </ul>
      </div>
    </div>
  `
  return c.html(layout('メール設定（Gmail）', content, user))
})

admin.post('/smtp', async (c) => {
  const db = c.env.DB
  const body = await c.req.parseBody() as any

  // Gmail固定値
  const host = 'smtp.gmail.com'
  const port = 587
  const use_tls = 1
  const username = body.username || 'tokyo.defense.mail@gmail.com'
  const from_email = body.from_email || username
  const from_name = body.from_name || '請求書回覧システム（東京ディフェンス）'
  // アプリパスワードのスペースを自動除去（例: "abcd efgh ijkl mnop" → "abcdefghijklmnop"）
  const cleanPassword = body.password ? (body.password as string).replace(/\s/g, '') : null

  const existing = await db.prepare('SELECT id FROM smtp_settings LIMIT 1').first()

  if (existing) {
    let sql = 'UPDATE smtp_settings SET host=?, port=?, username=?, from_email=?, from_name=?, use_tls=?, updated_at=datetime("now")'
    const params: any[] = [host, port, username, from_email, from_name, use_tls]
    if (cleanPassword) { sql += ', password=?'; params.push(cleanPassword) }
    sql += ' WHERE id=?'; params.push((existing as any).id)
    await db.prepare(sql).bind(...params).run()
  } else {
    await db.prepare(
      'INSERT INTO smtp_settings (host, port, username, password, from_email, from_name, use_tls) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(host, port, username, cleanPassword, from_email, from_name, use_tls).run()
  }
  return c.redirect('/admin/smtp?saved=1')
})

// ============================================================
// リマインダー設定
// ============================================================
admin.get('/reminder', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const params = new URL(c.req.url).searchParams
  const saved = params.get('saved') === '1'

  const settings = await db.prepare('SELECT * FROM reminder_settings WHERE id = 1').first() as any

  const content = `
    <div class="max-w-xl space-y-4">
      <h2 class="text-xl font-bold text-gray-800">⏰ リマインダー設定</h2>

      ${saved ? '<div class="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">✅ 設定を保存しました。</div>' : ''}

      <!-- ① 受付→申請リマインド -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="text-base font-bold text-gray-800 mb-1">📥 ① 受付後の申請リマインド</h3>
        <p class="text-sm text-gray-500 mb-5">
          フロント担当者が請求書受付後に回覧申請を行っていない場合、<br>
          指定した日数ごとに自動リマインドメールを送信します。
        </p>

        <form method="POST" action="/admin/reminder" class="space-y-5">

          <div class="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" name="is_active" value="1" ${settings?.is_active ? 'checked' : ''}
                class="sr-only peer" onchange="toggleForm(this, 'reminderForm')">
              <div class="w-11 h-6 bg-gray-300 peer-focus:ring-2 peer-focus:ring-[#396999] rounded-full peer
                          peer-checked:after:translate-x-full peer-checked:bg-[#396999]
                          after:content-[''] after:absolute after:top-0.5 after:left-[2px]
                          after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
            </label>
            <span class="text-sm font-semibold text-gray-700">自動リマインドを有効にする</span>
          </div>

          <div id="reminderForm" class="${settings?.is_active ? '' : 'opacity-50 pointer-events-none'}">
            <div class="space-y-2">
              <label class="block text-sm font-semibold text-gray-700">リマインド間隔（日数）</label>
              <div class="flex items-center gap-3">
                <input type="number" name="remind_interval_days"
                  value="${settings?.remind_interval_days || 3}"
                  min="1" max="30" required
                  class="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm text-center focus:ring-2 focus:ring-[#396999] outline-none">
                <span class="text-sm text-gray-600">日ごとにリマインドメールを送信</span>
              </div>
            </div>
            <div class="space-y-2 mt-4">
              <label class="block text-sm font-semibold text-gray-700">最大リマインド回数</label>
              <div class="flex items-center gap-3">
                <input type="number" name="remind_max_count"
                  value="${settings?.remind_max_count || 3}"
                  min="1" max="10" required
                  class="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm text-center focus:ring-2 focus:ring-[#396999] outline-none">
                <span class="text-sm text-gray-600">回まで送信</span>
              </div>
            </div>
            <div class="mt-5 p-4 bg-[#EEF4FA] rounded-lg text-xs text-[#2E5580] space-y-1" id="preview"></div>
          </div>

          <div class="flex gap-3 pt-2">
            <button type="submit"
              class="bg-[#396999] hover:bg-[#2E5580] text-white font-semibold px-6 py-2.5 rounded-lg transition text-sm">
              保存する
            </button>
          </div>
        </form>
      </div>

      <!-- ② 承認者リマインド -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="text-base font-bold text-gray-800 mb-1">✅ ② 承認者へのリマインド</h3>
        <p class="text-sm text-gray-500 mb-5">
          回覧中の申請で承認者（上長・業務管理課・最終承認者）が<br>
          指定日数以上承認しない場合、リマインドメールを自動送信します。
        </p>

        <form method="POST" action="/admin/reminder-review" class="space-y-5">

          <div class="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" name="review_remind_is_active" value="1" ${settings?.review_remind_is_active ? 'checked' : ''}
                class="sr-only peer" onchange="toggleForm(this, 'reviewReminderForm')">
              <div class="w-11 h-6 bg-gray-300 peer-focus:ring-2 peer-focus:ring-[#396999] rounded-full peer
                          peer-checked:after:translate-x-full peer-checked:bg-[#396999]
                          after:content-[''] after:absolute after:top-0.5 after:left-[2px]
                          after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
            </label>
            <span class="text-sm font-semibold text-gray-700">承認リマインドを有効にする</span>
          </div>

          <div id="reviewReminderForm" class="${settings?.review_remind_is_active ? '' : 'opacity-50 pointer-events-none'}">
            <div class="space-y-2">
              <label class="block text-sm font-semibold text-gray-700">リマインド間隔（日数）</label>
              <div class="flex items-center gap-3">
                <input type="number" name="review_remind_interval_days"
                  value="${settings?.review_remind_interval_days || 2}"
                  min="1" max="30" required
                  class="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm text-center focus:ring-2 focus:ring-[#396999] outline-none"
                  oninput="updateReviewPreview()">
                <span class="text-sm text-gray-600">日ごとにリマインドメールを送信</span>
              </div>
              <p class="text-xs text-gray-400">例：2日 → 承認待ちから2日後・4日後に送信</p>
            </div>
            <div class="space-y-2 mt-4">
              <label class="block text-sm font-semibold text-gray-700">最大リマインド回数</label>
              <div class="flex items-center gap-3">
                <input type="number" name="review_remind_max_count"
                  value="${settings?.review_remind_max_count || 3}"
                  min="1" max="10" required
                  class="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm text-center focus:ring-2 focus:ring-[#396999] outline-none"
                  oninput="updateReviewPreview()">
                <span class="text-sm text-gray-600">回まで送信</span>
              </div>
            </div>
            <div class="mt-5 p-4 bg-orange-50 rounded-lg text-xs text-orange-700 space-y-1" id="reviewPreview"></div>
          </div>

          <!-- 手動実行ボタン -->
          <div class="flex items-center gap-3 pt-2">
            <button type="submit"
              class="bg-[#396999] hover:bg-[#2E5580] text-white font-semibold px-6 py-2.5 rounded-lg transition text-sm">
              保存する
            </button>
            <button type="button" onclick="triggerReviewReminder()"
              class="bg-orange-500 hover:bg-orange-600 text-white font-semibold px-6 py-2.5 rounded-lg transition text-sm">
              今すぐ実行
            </button>
          </div>
          <div id="triggerResult" class="hidden text-sm px-4 py-2 rounded-lg"></div>
        </form>
      </div>

      <!-- 動作説明 -->
      <div class="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
        <p class="font-semibold mb-2">📝 リマインダーの動作について</p>
        <ul class="list-disc list-inside space-y-1 text-xs">
          <li>① 受付登録からリマインド間隔日数が経過した未申請案件に自動送信</li>
          <li>② 承認待ちになってからリマインド間隔日数が経過した承認者に自動送信</li>
          <li>「今すぐ実行」ボタンで即時リマインド確認・送信が可能</li>
          <li>最大回数を超えた場合は自動送信を停止</li>
          <li>承認・否決・差し戻しが行われるとリマインドは自動停止</li>
        </ul>
      </div>
    </div>

    <script>
      function toggleForm(cb, formId) {
        const form = document.getElementById(formId);
        if (!form) return;
        form.classList.toggle('opacity-50', !cb.checked);
        form.classList.toggle('pointer-events-none', !cb.checked);
      }

      function updatePreview() {
        const interval = parseInt(document.querySelector('[name=remind_interval_days]')?.value || '3');
        const maxCount = parseInt(document.querySelector('[name=remind_max_count]')?.value || '3');
        const preview = document.getElementById('preview');
        if (!preview) return;
        let html = '<p class="font-semibold mb-2">📅 送信スケジュール（例）</p>';
        for (let i = 1; i <= maxCount; i++) {
          html += '<p>受付登録から ' + (interval * i) + ' 日後 → 第' + i + 'リマインド送信</p>';
        }
        preview.innerHTML = html;
      }

      function updateReviewPreview() {
        const interval = parseInt(document.querySelector('[name=review_remind_interval_days]')?.value || '2');
        const maxCount = parseInt(document.querySelector('[name=review_remind_max_count]')?.value || '3');
        const preview = document.getElementById('reviewPreview');
        if (!preview) return;
        let html = '<p class="font-semibold mb-2">📅 承認リマインド スケジュール（例）</p>';
        for (let i = 1; i <= maxCount; i++) {
          html += '<p>承認待ちから ' + (interval * i) + ' 日後 → 第' + i + '回リマインド送信</p>';
        }
        preview.innerHTML = html;
      }

      async function triggerReviewReminder() {
        const btn = event.target;
        const resultEl = document.getElementById('triggerResult');
        btn.disabled = true;
        btn.textContent = '実行中...';
        try {
          const res = await fetch('/api/trigger-review-reminders');
          const data = await res.json();
          resultEl.className = 'text-sm px-4 py-2 rounded-lg bg-green-50 text-green-700 border border-green-200';
          resultEl.textContent = '✅ ' + data.message + '（対象: ' + data.targets + '件 / 送信: ' + data.sent + '件）';
          resultEl.classList.remove('hidden');
        } catch(e) {
          resultEl.className = 'text-sm px-4 py-2 rounded-lg bg-red-50 text-red-700 border border-red-200';
          resultEl.textContent = '❌ エラーが発生しました';
          resultEl.classList.remove('hidden');
        } finally {
          btn.disabled = false;
          btn.textContent = '今すぐ実行';
        }
      }

      document.querySelectorAll('[name=remind_interval_days],[name=remind_max_count]').forEach(el => {
        el.addEventListener('input', updatePreview);
      });
      updatePreview();
      updateReviewPreview();
    </script>
  `
  return c.html(layout('リマインダー設定', content, user))
})

admin.post('/reminder', async (c) => {
  const db = c.env.DB
  const me = (c as any).get('user')
  const body = await c.req.parseBody() as any

  const isActive = body.is_active ? 1 : 0
  const intervalDays = Math.max(1, Math.min(30, parseInt(body.remind_interval_days) || 3))
  const maxCount = Math.max(1, Math.min(10, parseInt(body.remind_max_count) || 3))
  const now = new Date().toISOString()

  const existing = await db.prepare('SELECT id FROM reminder_settings LIMIT 1').first()
  if (existing) {
    await db.prepare(`
      UPDATE reminder_settings
      SET remind_interval_days=?, remind_max_count=?, is_active=?, updated_by=?, updated_at=?
      WHERE id=1
    `).bind(intervalDays, maxCount, isActive, me.id, now).run()
  } else {
    await db.prepare(`
      INSERT INTO reminder_settings (remind_interval_days, remind_max_count, is_active, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(intervalDays, maxCount, isActive, me.id, now).run()
  }
  return c.redirect('/admin/reminder?saved=1')
})

// 承認リマインド設定保存
admin.post('/reminder-review', async (c) => {
  const db = c.env.DB
  const me = (c as any).get('user')
  const body = await c.req.parseBody() as any

  const isActive = body.review_remind_is_active ? 1 : 0
  const intervalDays = Math.max(1, Math.min(30, parseInt(body.review_remind_interval_days) || 2))
  const maxCount = Math.max(1, Math.min(10, parseInt(body.review_remind_max_count) || 3))
  const now = new Date().toISOString()

  const existing = await db.prepare('SELECT id FROM reminder_settings LIMIT 1').first()
  if (existing) {
    await db.prepare(`
      UPDATE reminder_settings
      SET review_remind_interval_days=?, review_remind_max_count=?, review_remind_is_active=?, updated_by=?, updated_at=?
      WHERE id=1
    `).bind(intervalDays, maxCount, isActive, me.id, now).run()
  } else {
    await db.prepare(`
      INSERT INTO reminder_settings (review_remind_interval_days, review_remind_max_count, review_remind_is_active, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(intervalDays, maxCount, isActive, me.id, now).run()
  }
  return c.redirect('/admin/reminder?saved=1')
})

// ============================================================
// 役割マスタ管理
// ============================================================
admin.get('/roles', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const roles = await db.prepare('SELECT * FROM roles ORDER BY sort_order').all()
  const saved = c.req.query('saved')
  const deleted = c.req.query('deleted')

  const content = `
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-bold text-gray-800">🏷️ 役割マスタ管理</h2>
        <button onclick="document.getElementById('addModal').classList.remove('hidden')"
          class="bg-[#396999] hover:bg-[#2E5580] text-white text-sm font-semibold px-4 py-2 rounded-lg transition">
          ＋ 役割を追加
        </button>
      </div>

      ${saved ? '<div class="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-2 rounded-lg">✅ 保存しました</div>' : ''}
      ${deleted ? '<div class="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg">🗑 削除しました</div>' : ''}

      <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">表示名</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">内部値</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">バッジ色</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">順番</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            ${(roles.results as any[]).map(r => {
              const colorMap: Record<string,string> = {
                blue:'bg-[#EEF4FA] text-[#2E5580]', indigo:'bg-indigo-50 text-indigo-700',
                orange:'bg-orange-50 text-orange-700', yellow:'bg-yellow-50 text-yellow-700',
                green:'bg-green-50 text-green-700', red:'bg-red-50 text-red-700',
                purple:'bg-purple-50 text-purple-700', gray:'bg-gray-100 text-gray-600'
              }
              const cls = colorMap[r.color] || 'bg-gray-100 text-gray-600'
              return `
              <tr class="hover:bg-gray-50">
                <td class="px-4 py-3">
                  <span class="${cls} text-xs px-2 py-0.5 rounded-full font-medium">${r.label}</span>
                </td>
                <td class="px-4 py-3 font-mono text-xs text-gray-400">${r.value}</td>
                <td class="px-4 py-3">
                  <span class="text-xs ${cls} px-2 py-0.5 rounded">${r.color}</span>
                </td>
                <td class="px-4 py-3 text-gray-500 text-xs">${r.sort_order}</td>
                <td class="px-4 py-3">
                  ${r.is_active
                    ? '<span class="text-green-600 text-xs">● 有効</span>'
                    : '<span class="text-gray-400 text-xs">● 無効</span>'}
                </td>
                <td class="px-4 py-3">
                  <div class="flex gap-2">
                    <button onclick="openEditModal(${r.id},'${r.value}','${r.label}','${r.color}',${r.sort_order},${r.is_active})"
                      class="text-xs px-2 py-1 bg-[#EEF4FA] text-[#396999] hover:bg-[#D5E5F2] rounded transition">編集</button>
                    ${r.value !== 'admin' && r.value !== 'front' ? `
                    <form method="POST" action="/admin/roles/${r.id}/delete" onsubmit="return confirm('「${r.label}」を削除しますか？')">
                      <button type="submit" class="text-xs px-2 py-1 bg-red-50 text-red-500 hover:bg-red-100 rounded transition">削除</button>
                    </form>` : '<span class="text-xs text-gray-300 px-2">-</span>'}
                  </div>
                </td>
              </tr>`
            }).join('')}
          </tbody>
        </table>
      </div>

      <div class="bg-[#EEF4FA] border border-[#AECBE5] rounded-lg p-4 text-sm text-[#2E5580]">
        <p class="font-semibold mb-1">💡 役割について</p>
        <ul class="text-xs space-y-1 text-[#396999]">
          <li>• <strong>担当者（front）</strong>・<strong>管理者（admin）</strong>は削除できません</li>
          <li>• 追加した役割はユーザー編集画面のプルダウンにすぐ反映されます</li>
          <li>• 「担当者/上司」はユーザー編集の <strong>上司フラグ</strong> で設定してください</li>
        </ul>
      </div>
    </div>

    <!-- 追加モーダル -->
    <div id="addModal" class="hidden fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
      <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
        <h3 class="font-bold text-gray-800 text-lg mb-4">＋ 役割を追加</h3>
        <form method="POST" action="/admin/roles" class="space-y-4">
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">表示名 <span class="text-red-500">*</span></label>
            <input type="text" name="label" required placeholder="例：不動産部"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
          </div>
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">内部値（英数字）<span class="text-red-500">*</span></label>
            <input type="text" name="value" required placeholder="例：realestate" pattern="[a-z0-9_]+"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            <p class="text-xs text-gray-400 mt-1">小文字英数字とアンダースコアのみ</p>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1">バッジ色</label>
              <select name="color" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
                <option value="blue">青（blue）</option>
                <option value="indigo">藍（indigo）</option>
                <option value="orange">橙（orange）</option>
                <option value="yellow">黄（yellow）</option>
                <option value="green">緑（green）</option>
                <option value="red">赤（red）</option>
                <option value="purple">紫（purple）</option>
                <option value="gray">灰（gray）</option>
              </select>
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1">表示順</label>
              <input type="number" name="sort_order" value="100" min="0"
                class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            </div>
          </div>
          <div class="flex gap-3 pt-2">
            <button type="button" onclick="document.getElementById('addModal').classList.add('hidden')"
              class="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 transition">キャンセル</button>
            <button type="submit"
              class="flex-1 px-4 py-2 bg-[#396999] hover:bg-[#2E5580] text-white font-semibold rounded-lg text-sm transition">追加する</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 編集モーダル -->
    <div id="editModal" class="hidden fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
      <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
        <h3 class="font-bold text-gray-800 text-lg mb-4">✏️ 役割を編集</h3>
        <form id="editForm" method="POST" action="" class="space-y-4">
          <input type="hidden" name="_method" value="PUT">
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">表示名 <span class="text-red-500">*</span></label>
            <input type="text" id="editLabel" name="label" required
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
          </div>
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">内部値</label>
            <input type="text" id="editValue" name="value" readonly
              class="w-full px-3 py-2 border border-gray-200 bg-gray-50 rounded-lg text-sm text-gray-400">
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1">バッジ色</label>
              <select id="editColor" name="color" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
                <option value="blue">青（blue）</option>
                <option value="indigo">藍（indigo）</option>
                <option value="orange">橙（orange）</option>
                <option value="yellow">黄（yellow）</option>
                <option value="green">緑（green）</option>
                <option value="red">赤（red）</option>
                <option value="purple">紫（purple）</option>
                <option value="gray">灰（gray）</option>
              </select>
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1">表示順</label>
              <input type="number" id="editSortOrder" name="sort_order" min="0"
                class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            </div>
          </div>
          <div>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" id="editIsActive" name="is_active" value="1"
                class="w-4 h-4 text-[#396999] rounded">
              <span class="text-sm">有効</span>
            </label>
          </div>
          <div class="flex gap-3 pt-2">
            <button type="button" onclick="document.getElementById('editModal').classList.add('hidden')"
              class="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 transition">キャンセル</button>
            <button type="submit"
              class="flex-1 px-4 py-2 bg-[#396999] hover:bg-[#2E5580] text-white font-semibold rounded-lg text-sm transition">更新する</button>
          </div>
        </form>
      </div>
    </div>

    <script>
      function openEditModal(id, value, label, color, sortOrder, isActive) {
        document.getElementById('editForm').action = '/admin/roles/' + id;
        document.getElementById('editLabel').value = label;
        document.getElementById('editValue').value = value;
        document.getElementById('editColor').value = color;
        document.getElementById('editSortOrder').value = sortOrder;
        document.getElementById('editIsActive').checked = isActive == 1;
        document.getElementById('editModal').classList.remove('hidden');
      }
    </script>
  `
  return c.html(layout('役割マスタ管理', content, user))
})

// 役割追加
admin.post('/roles', async (c) => {
  const db = c.env.DB
  const body = await c.req.parseBody() as any
  await db.prepare(
    'INSERT OR IGNORE INTO roles (value, label, color, sort_order) VALUES (?, ?, ?, ?)'
  ).bind(body.value, body.label, body.color || 'blue', parseInt(body.sort_order) || 100).run()
  return c.redirect('/admin/roles?saved=1')
})

// 役割更新
admin.post('/roles/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.parseBody() as any
  await db.prepare(
    'UPDATE roles SET label=?, color=?, sort_order=?, is_active=? WHERE id=?'
  ).bind(body.label, body.color || 'blue', parseInt(body.sort_order) || 0, body.is_active ? 1 : 0, id).run()
  return c.redirect('/admin/roles?saved=1')
})

// 役割削除
admin.post('/roles/:id/delete', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  // front・adminは削除不可
  const role = await db.prepare('SELECT value FROM roles WHERE id = ?').bind(id).first() as any
  if (!role || role.value === 'front' || role.value === 'admin') return c.redirect('/admin/roles')
  await db.prepare('DELETE FROM roles WHERE id = ?').bind(id).run()
  return c.redirect('/admin/roles?deleted=1')
})

// ============================================================
// データバックアップ
// ============================================================
admin.get('/backup', async (c) => {
  const user = (c as any).get('user')
  const saved = c.req.query('done')

  const content = `
    <div class="space-y-6 max-w-2xl">

      ${saved ? '<div class="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-lg">✅ バックアップのダウンロードを開始しました</div>' : ''}

      <!-- JSON バックアップ -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="text-base font-bold text-gray-800 mb-1">📦 フルバックアップ（JSON）</h3>
        <p class="text-sm text-gray-500 mb-4">
          すべてのテーブル（申請・ユーザー・マンション・回覧ステップ等）を<br>
          JSON形式でダウンロードします。復元・移行用途に利用できます。
        </p>
        <div class="flex flex-wrap gap-3">
          <a href="/admin/backup/download?format=json"
            class="inline-flex items-center gap-2 bg-[#396999] hover:bg-[#2E5580] text-white font-semibold px-5 py-2.5 rounded-lg transition text-sm">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            JSONでダウンロード
          </a>
        </div>
        <p class="text-xs text-gray-400 mt-3">※ パスワードハッシュ・セッション情報は除外されます</p>
      </div>

      <!-- CSV エクスポート -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="text-base font-bold text-gray-800 mb-1">📊 申請データ エクスポート（CSV）</h3>
        <p class="text-sm text-gray-500 mb-4">
          申請一覧をCSV形式でダウンロードします。<br>
          Excel等の表計算ソフトで開くことができます。
        </p>
        <div class="flex flex-wrap gap-3">
          <a href="/admin/backup/download?format=csv&table=applications"
            class="inline-flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold px-5 py-2.5 rounded-lg transition text-sm">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            申請一覧CSV
          </a>
          <a href="/admin/backup/download?format=csv&table=users"
            class="inline-flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold px-5 py-2.5 rounded-lg transition text-sm">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            ユーザー一覧CSV
          </a>
          <a href="/admin/backup/download?format=csv&table=mansions"
            class="inline-flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold px-5 py-2.5 rounded-lg transition text-sm">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            マンション一覧CSV
          </a>
        </div>
      </div>

      <!-- 注意事項 -->
      <div class="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
        <p class="font-semibold mb-2">⚠️ バックアップの取り扱いについて</p>
        <ul class="list-disc list-inside space-y-1 text-xs">
          <li>バックアップファイルには個人情報が含まれます。厳重に管理してください</li>
          <li>JSONバックアップはシステム管理者のみが使用できます</li>
          <li>ダウンロード後は安全な場所に保管し、不要になったら削除してください</li>
        </ul>
      </div>

    </div>
  `
  return c.html(layout('データバックアップ', content, user))
})

// バックアップダウンロード
admin.get('/backup/download', async (c) => {
  const db = c.env.DB
  const format = c.req.query('format') || 'json'
  const table = c.req.query('table') || ''
  const now = new Date().toISOString().slice(0, 10).replace(/-/g, '')

  // ===== JSON フルバックアップ =====
  if (format === 'json') {
    const tables = [
      'applications', 'attachments', 'circulation_steps',
      'invoice_inbox', 'mansions', 'notification_logs',
      'operations_staff', 'honsha_staff', 'reminder_settings',
      'roles', 'smtp_settings'
    ]

    const backup: Record<string, any[]> = {
      _meta: [{
        exported_at: new Date().toISOString(),
        version: '1.0',
        system: '請求書回覧システム'
      }] as any
    }

    for (const t of tables) {
      try {
        // usersテーブルはパスワードハッシュを除外
        if (t === 'users') {
          const rows = await db.prepare(
            'SELECT id, employee_number, name, email, department, role, is_active, is_admin, created_at, updated_at FROM users'
          ).all()
          backup['users'] = rows.results as any[]
        } else {
          const rows = await db.prepare(`SELECT * FROM ${t}`).all()
          backup[t] = rows.results as any[]
        }
      } catch {
        backup[t] = []
      }
    }

    const json = JSON.stringify(backup, null, 2)
    return new Response(json, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="backup_${now}.json"`,
      }
    })
  }

  // ===== CSV エクスポート =====
  if (format === 'csv') {
    // 許可テーブルのみ
    const allowed: Record<string, { query: string; filename: string }> = {
      applications: {
        filename: `applications_${now}.csv`,
        query: `
          SELECT
            a.application_number AS 申請番号,
            a.title AS 件名,
            m.name AS マンション名,
            u.name AS 申請者,
            a.circulation_start_date AS 回覧開始日,
            CASE a.payment_target
              WHEN 'kumiai' THEN '管理組合'
              WHEN 'td' THEN '会社（TD）'
              ELSE a.payment_target
            END AS 支払先,
            a.budget_amount AS 金額（円）,
            a.commission_rate AS 手数料率（％）,
            CASE a.status
              WHEN 'circulating' THEN '回覧中'
              WHEN 'completed'   THEN '完了'
              WHEN 'rejected'    THEN '差し戻し'
              WHEN 'on_hold'     THEN '保留中'
              ELSE a.status
            END AS ステータス,
            a.current_step AS 現在ステップ,
            a.resubmit_count AS 再提出回数,
            a.created_at AS 作成日時,
            a.updated_at AS 更新日時
          FROM applications a
          LEFT JOIN mansions m ON a.mansion_id = m.id
          LEFT JOIN users u ON a.applicant_id = u.id
          ORDER BY a.created_at DESC
        `
      },
      users: {
        filename: `users_${now}.csv`,
        query: `
          SELECT
            employee_number AS 社員番号,
            name AS 氏名,
            email AS メールアドレス,
            department AS 部署,
            CASE role
              WHEN 'front'            THEN '担当者'
              WHEN 'front_supervisor' THEN '担当者/上司'
              WHEN 'operations'       THEN '業務管理課'
              WHEN 'accounting'       THEN '会計課'
              WHEN 'honsha'           THEN '本社経理'
              WHEN 'admin'            THEN '管理者'
              ELSE role
            END AS 役割,
            CASE is_active WHEN 1 THEN '有効' ELSE '無効' END AS アカウント状態,
            created_at AS 作成日時
          FROM users
          ORDER BY CAST(employee_number AS INTEGER)
        `
      },
      mansions: {
        filename: `mansions_${now}.csv`,
        query: `
          SELECT
            m.mansion_number AS 番号,
            m.name AS マンション名,
            uf.name AS フロント担当者,
            ua.name AS 会計担当者,
            CASE m.is_active WHEN 1 THEN '有効' ELSE '無効' END AS 状態
          FROM mansions m
          LEFT JOIN users uf ON m.front_user_id = uf.id
          LEFT JOIN users ua ON m.accounting_user_id = ua.id
          ORDER BY CAST(m.mansion_number AS INTEGER)
        `
      }
    }

    const def = allowed[table]
    if (!def) return c.redirect('/admin/backup')

    const rows = await db.prepare(def.query).all()
    const results = rows.results as any[]

    if (results.length === 0) {
      // ヘッダーだけのCSVを返す
      return new Response('\uFEFF', {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${def.filename}"`,
        }
      })
    }

    // BOM付きUTF-8でExcelで文字化けしない
    const headers = Object.keys(results[0])
    const csvRows = [
      headers.join(','),
      ...results.map(row =>
        headers.map(h => {
          const v = row[h] == null ? '' : String(row[h])
          // カンマ・改行・ダブルクォートを含む場合はクォートで囲む
          return v.includes(',') || v.includes('\n') || v.includes('"')
            ? '"' + v.replace(/"/g, '""') + '"'
            : v
        }).join(',')
      )
    ]
    const csv = '\uFEFF' + csvRows.join('\r\n')

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${def.filename}"`,
      }
    })
  }

  return c.redirect('/admin/backup')
})

// ============================================================
// LINE WORKS 設定
// ============================================================
admin.get('/lineworks', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const config = await db.prepare('SELECT * FROM lineworks_config WHERE is_active = 1 LIMIT 1').first() as any
  const params = new URL(c.req.url).searchParams
  const testResult = params.get('test')
  const testDetail = params.get('detail') || ''
  const errorParam = params.get('error')
  const savedParam = params.get('saved')

  // テスト結果・エラーメッセージ
  let alertHtml = ''
  if (testResult === 'ok') {
    alertHtml = `<div class="mb-4 px-4 py-3 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm flex items-center gap-2">
      <span class="text-lg">✅</span> <span>LINE WORKSへのテスト通知を送信しました！BotトークRoomを確認してください。</span>
    </div>`
  } else if (testResult === 'fail') {
    let hint = ''
    if (testDetail.includes('ACCESS_DENIED') || testDetail === 'send_failed') {
      hint = `<div class="mt-2 text-xs bg-orange-50 border border-orange-200 text-orange-700 rounded p-2">
        <strong>【対処方法】</strong> LINE WORKS Developer Console でBotの「ユーザーへのメッセージ送信」権限を確認してください。<br>
        Bot管理 → 対象Bot → 設定 → <strong>「ユーザーへのメッセージ送信」をON</strong> にする必要があります。<br>
        また、BotがメンバーとしてトークRoomに参加していることを確認してください。
      </div>`
    }
    alertHtml = `<div class="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
      <div class="flex items-center gap-2"><span class="text-lg">❌</span><span>テスト通知の送信に失敗しました。</span></div>
      ${testDetail ? `<div class="mt-1 text-xs font-mono text-red-500">${testDetail}</div>` : ''}
      ${hint}
    </div>`
  } else if (savedParam === '1') {
    alertHtml = `<div class="mb-4 px-4 py-3 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm flex items-center gap-2">
      ✅ 設定を保存しました。
    </div>`
  } else if (errorParam === 'no_lw_id') {
    alertHtml = `<div class="mb-4 px-4 py-3 bg-orange-50 border border-orange-200 text-orange-700 rounded-lg text-sm">
      ⚠️ あなたのアカウントにLINE WORKS IDが設定されていません。<a href="/admin/users/7/edit" class="underline">ユーザー編集</a>からIDを設定してください。
    </div>`
  }

  const content = `
    <div class="space-y-6">
      ${alertHtml}
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6 max-w-2xl">
        <h2 class="text-lg font-bold text-gray-800 mb-1 flex items-center gap-2">
          <span style="color:#00B900;font-size:20px;">●</span> LINE WORKS Bot 設定
        </h2>
        <p class="text-sm text-gray-500 mb-5">Bot ID・API認証情報を設定します。変更すると即時反映されます。</p>

        <form method="POST" action="/admin/lineworks">
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">Bot ID <span class="text-red-500">*</span></label>
              <input type="text" name="bot_id" value="${config?.bot_id || ''}" required placeholder="例: 11913647"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-1.5">Client ID <span class="text-red-500">*</span></label>
                <input type="text" name="client_id" value="${config?.client_id || ''}" required placeholder="Client ID"
                  class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
              </div>
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-1.5">Client Secret <span class="text-red-500">*</span></label>
                <input type="text" name="client_secret" value="${config?.client_secret || ''}" required placeholder="Client Secret"
                  class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
              </div>
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">Service Account <span class="text-red-500">*</span></label>
              <input type="text" name="service_account" value="${config?.service_account || ''}" required placeholder="例: xxxx.serviceaccount@tokyo-defense"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">Private Key (PEM) <span class="text-red-500">*</span></label>
              <textarea name="private_key" rows="8" required placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none font-mono text-xs">${config?.private_key || ''}</textarea>
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">ステータス</label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" name="is_active" value="1" ${(!config || config.is_active) ? 'checked' : ''}
                  class="w-4 h-4 text-[#396999] rounded">
                <span class="text-sm">LINE WORKS通知を有効にする</span>
              </label>
            </div>
          </div>
          <div class="flex gap-3 mt-6">
            <button type="submit" class="bg-[#396999] hover:bg-[#2E5580] text-white font-semibold px-6 py-2.5 rounded-lg transition text-sm">
              保存する
            </button>
            <a href="/admin/lineworks/test" class="px-4 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition">
              テスト送信
            </a>
          </div>
        </form>
      </div>

      <!-- 現在の設定状態 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6 max-w-2xl">
        <h3 class="text-sm font-semibold text-gray-700 mb-3">現在の設定</h3>
        ${config ? `
          <div class="space-y-2 text-sm">
            <div class="flex gap-2"><span class="text-gray-500 w-28">Bot ID:</span><span class="font-mono">${config.bot_id}</span></div>
            <div class="flex gap-2"><span class="text-gray-500 w-28">Client ID:</span><span class="font-mono">${config.client_id}</span></div>
            <div class="flex gap-2"><span class="text-gray-500 w-28">Service Account:</span><span class="font-mono text-xs">${config.service_account}</span></div>
            <div class="flex gap-2"><span class="text-gray-500 w-28">ステータス:</span>
              ${config.is_active
                ? '<span class="bg-green-100 text-green-700 px-2 py-0.5 rounded text-xs font-semibold">有効</span>'
                : '<span class="bg-gray-100 text-gray-500 px-2 py-0.5 rounded text-xs">無効</span>'}
            </div>
          </div>
        ` : '<p class="text-sm text-gray-400">設定が登録されていません。上のフォームから登録してください。</p>'}
      </div>

      <!-- アクセストークン設定 -->
      ${config ? `
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6 max-w-2xl">
        <h3 class="text-base font-semibold text-gray-800 mb-1">アクセストークン設定</h3>
        <p class="text-xs text-gray-500 mb-4">
          LINE WORKS通知を送信するにはアクセストークンが必要です。<br>
          LINE WORKS Developer Consoleで取得したアクセストークン（または以下のcurlコマンドで取得）を登録してください。
        </p>

        <!-- トークン現在の状態 -->
        <div class="mb-4 p-3 rounded-lg text-sm ${
          config.access_token && config.token_expires_at && (config.token_expires_at > Math.floor(Date.now()/1000))
            ? 'bg-green-50 border border-green-200'
            : config.refresh_token
            ? 'bg-yellow-50 border border-yellow-200'
            : 'bg-red-50 border border-red-200'
        }">
          ${config.access_token && config.token_expires_at && (config.token_expires_at > Math.floor(Date.now()/1000))
            ? `<span class="text-green-700 font-semibold">✅ アクセストークン有効</span>
               <span class="text-green-600 ml-2 text-xs">（有効期限: ${new Date((config.token_expires_at || 0) * 1000).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'})}）</span>`
            : config.refresh_token
            ? `<span class="text-yellow-700 font-semibold">⚠️ アクセストークン期限切れ</span>
               <span class="text-yellow-600 ml-2 text-xs">（Refresh Tokenで更新可能）</span>`
            : '<span class="text-red-700 font-semibold">❌ アクセストークン未設定</span>'}
        </div>

        <!-- Refresh Token 更新ボタン -->
        ${config.refresh_token ? `
        <div class="mb-4">
          <button onclick="refreshToken()" class="bg-[#396999] hover:bg-[#2E5580] text-white font-semibold px-4 py-2 rounded-lg text-sm transition">
            🔄 Refresh Tokenでトークンを更新
          </button>
          <span id="refresh-status" class="ml-3 text-sm text-gray-500"></span>
        </div>
        ` : ''}

        <!-- アクセストークン手動設定フォーム -->
        <div class="border-t pt-4">
          <h4 class="text-sm font-semibold text-gray-700 mb-3">トークンを手動で登録</h4>
          <div class="bg-gray-50 rounded-lg p-3 mb-4">
            <p class="text-xs text-gray-600 mb-2 font-semibold">取得用curlコマンド（ターミナルで実行）：</p>
            <pre class="text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap break-all">JWT="eyJ..." # JWTを事前に生成してセット
curl -X POST https://auth.worksmobile.com/oauth2/v2.0/token \\
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \\
  -d "assertion=$JWT" \\
  -d "client_id=${config.client_id}" \\
  -d "client_secret=${config.client_secret}" \\
  -d "scope=bot"</pre>
          </div>
          <div class="space-y-3">
            <div>
              <label class="block text-xs font-semibold text-gray-700 mb-1">Access Token <span class="text-red-500">*</span></label>
              <textarea id="manual-access-token" rows="3" placeholder="kr1AAABFNKyxc7xs..."
                class="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs font-mono focus:ring-2 focus:ring-[#396999] outline-none"></textarea>
            </div>
            <div>
              <label class="block text-xs font-semibold text-gray-700 mb-1">Refresh Token（任意）</label>
              <input type="text" id="manual-refresh-token" placeholder="kr1AAAAVq8kTe..."
                class="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs font-mono focus:ring-2 focus:ring-[#396999] outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-gray-700 mb-1">有効期間（秒）</label>
              <input type="number" id="manual-expires-in" value="86400" placeholder="86400"
                class="w-48 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
              <span class="text-xs text-gray-500 ml-2">（86400 = 24時間、3600 = 1時間）</span>
            </div>
            <button onclick="saveToken()" class="bg-green-600 hover:bg-green-700 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">
              トークンを保存
            </button>
            <span id="save-token-status" class="ml-3 text-sm"></span>
          </div>
        </div>
      </div>
      ` : ''}
    </div>

    <script>
    async function refreshToken() {
      const btn = event.target
      const status = document.getElementById('refresh-status')
      btn.disabled = true
      status.textContent = '更新中...'
      status.className = 'ml-3 text-sm text-gray-500'
      try {
        const res = await fetch('/admin/lineworks/refresh-token', { method: 'POST', headers: {'Content-Type':'application/json'} })
        const data = await res.json()
        if (data.ok) {
          status.textContent = '✅ 更新成功'
          status.className = 'ml-3 text-sm text-green-600'
          setTimeout(() => location.reload(), 1500)
        } else {
          status.textContent = '❌ ' + data.error
          status.className = 'ml-3 text-sm text-red-600'
          btn.disabled = false
        }
      } catch(e) {
        status.textContent = '❌ 通信エラー'
        status.className = 'ml-3 text-sm text-red-600'
        btn.disabled = false
      }
    }

    async function saveToken() {
      const accessToken = document.getElementById('manual-access-token').value.trim()
      const refreshToken = document.getElementById('manual-refresh-token').value.trim()
      const expiresIn = parseInt(document.getElementById('manual-expires-in').value) || 86400
      const status = document.getElementById('save-token-status')

      if (!accessToken) {
        status.textContent = '❌ Access Tokenを入力してください'
        status.className = 'ml-3 text-sm text-red-600'
        return
      }

      status.textContent = '保存中...'
      status.className = 'ml-3 text-sm text-gray-500'
      try {
        const res = await fetch('/admin/lineworks/set-token', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken || undefined, expires_in: expiresIn })
        })
        const data = await res.json()
        if (data.ok) {
          status.textContent = '✅ 保存しました'
          status.className = 'ml-3 text-sm text-green-600'
          setTimeout(() => location.reload(), 1500)
        } else {
          status.textContent = '❌ ' + data.error
          status.className = 'ml-3 text-sm text-red-600'
        }
      } catch(e) {
        status.textContent = '❌ 通信エラー'
        status.className = 'ml-3 text-sm text-red-600'
      }
    }
    </script>
  `
  return c.html((await import('./layout')).layout('LINE WORKS設定', content, user))
})

admin.post('/lineworks', async (c) => {
  const db = c.env.DB
  const body = await c.req.parseBody() as any
  const existing = await db.prepare('SELECT id FROM lineworks_config LIMIT 1').first() as any

  if (existing) {
    await db.prepare(`
      UPDATE lineworks_config SET bot_id=?, client_id=?, client_secret=?, service_account=?, private_key=?, is_active=?, updated_at=datetime("now")
      WHERE id=?
    `).bind(body.bot_id, body.client_id, body.client_secret, body.service_account, body.private_key, body.is_active ? 1 : 0, existing.id).run()
  } else {
    await db.prepare(`
      INSERT INTO lineworks_config (bot_id, client_id, client_secret, service_account, private_key, is_active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(body.bot_id, body.client_id, body.client_secret, body.service_account, body.private_key, body.is_active ? 1 : 0).run()
  }

  return c.redirect('/admin/lineworks?saved=1')
})

// LINE WORKS アクセストークン手動設定 API
// Cloudflare Workers では RSA 署名が制限されるため、
// 事前に取得したアクセストークンを直接登録する
admin.post('/lineworks/set-token', async (c) => {
  const db = c.env.DB
  const body = await c.req.json() as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }

  if (!body.access_token) {
    return c.json({ ok: false, error: 'access_token は必須です' }, 400)
  }

  const existing = await db.prepare('SELECT id FROM lineworks_config LIMIT 1').first() as any
  if (!existing) {
    return c.json({ ok: false, error: 'LINE WORKS設定が登録されていません' }, 404)
  }

  const expiresAt = body.expires_in
    ? Math.floor(Date.now() / 1000) + Number(body.expires_in)
    : Math.floor(Date.now() / 1000) + 86400 // デフォルト24時間

  await db.prepare(`
    UPDATE lineworks_config
    SET access_token=?, refresh_token=?, token_expires_at=?, updated_at=datetime("now")
    WHERE id=?
  `).bind(
    body.access_token,
    body.refresh_token || null,
    expiresAt,
    existing.id
  ).run()

  return c.json({ ok: true, message: 'アクセストークンを保存しました', expires_at: expiresAt })
})

// LINE WORKS Refresh Token でアクセストークン更新 API
admin.post('/lineworks/refresh-token', async (c) => {
  const db = c.env.DB
  const config = await db.prepare('SELECT * FROM lineworks_config WHERE is_active = 1 LIMIT 1').first() as any

  if (!config) {
    return c.json({ ok: false, error: 'LINE WORKS設定が未登録です' }, 404)
  }

  if (!config.refresh_token) {
    return c.json({ ok: false, error: 'Refresh Tokenが設定されていません。先にアクセストークンを手動設定してください。', needsToken: true })
  }

  try {
    const { refreshAccessToken } = await import('../lib/lineworks')
    const tokenData = await refreshAccessToken(config.client_id, config.client_secret, config.refresh_token)

    const expiresAt = Math.floor(Date.now() / 1000) + Number(tokenData.expires_in || 86400)

    await db.prepare(`
      UPDATE lineworks_config
      SET access_token=?, refresh_token=?, token_expires_at=?, updated_at=datetime("now")
      WHERE id=?
    `).bind(
      tokenData.access_token,
      tokenData.refresh_token || config.refresh_token, // 新しいrefresh_tokenがあれば更新
      expiresAt,
      config.id
    ).run()

    return c.json({ ok: true, message: 'アクセストークンを更新しました', expires_at: expiresAt })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '更新に失敗しました' })
  }
})

// LINE WORKS テスト送信
admin.get('/lineworks/test', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const config = await db.prepare('SELECT * FROM lineworks_config WHERE is_active = 1 LIMIT 1').first() as any

  if (!config) {
    return c.redirect('/admin/lineworks?error=no_config')
  }

  // 管理者自身のLINE WORKS IDに送信
  const adminUser = await db.prepare('SELECT lineworks_user_id FROM users WHERE id = ?').bind(user.uid).first() as any

  if (!adminUser?.lineworks_user_id) {
    return c.redirect('/admin/lineworks?error=no_lw_id')
  }

  try {
    const { sendLineWorksMessage, rowToConfig } = await import('../lib/lineworks')
    const lwConfig = rowToConfig(config)

    // まずシンプルなテキストメッセージで送信テスト
    const msg = {
      type: 'text' as const,
      text: `【テスト通知】\n請求書回覧システムからのテストメッセージです。\n送信日時: ${new Date().toLocaleString('ja-JP', {timeZone: 'Asia/Tokyo'})}\n送信者: ${user.name}`,
    }
    const result = await sendLineWorksMessage(lwConfig, adminUser.lineworks_user_id, msg)
    const ok = result === true
    const errParam = ok ? '' : `&detail=${encodeURIComponent(String(result).slice(0, 100))}`
    return c.redirect(`/admin/lineworks?test=${ok ? 'ok' : 'fail'}${errParam}`)
  } catch (e: any) {
    console.error('[LW Test]', e?.message || e)
    const msg = encodeURIComponent(String(e?.message || 'unknown').slice(0, 100))
    return c.redirect(`/admin/lineworks?test=fail&detail=${msg}`)
  }
})

export default admin
