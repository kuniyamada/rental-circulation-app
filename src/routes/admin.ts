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
    SELECT u.*, s.name as supervisor_name
    FROM users u LEFT JOIN users s ON u.supervisor_id = s.id
    ORDER BY u.employee_number
  `).all()

  const roleLabels: Record<string, string> = {
    front: 'フロント', manager: '上長', operations: '業務管理課',
    accounting: '会計担当', honsha: '本社経理', admin: '管理者'
  }

  const content = `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100">
      <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 class="font-semibold text-gray-800">ユーザー一覧 <span class="text-blue-600">${users.results.length}名</span></h2>
        <a href="/admin/users/new" class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition">＋ ユーザー追加</a>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">社員番号</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">氏名</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">メール</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">役割</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">直属上長</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            ${(users.results as any[]).map(u => `
              <tr class="hover:bg-gray-50">
                <td class="px-4 py-3 font-mono text-xs">${u.employee_number}</td>
                <td class="px-4 py-3 font-medium">${u.name} ${u.is_admin ? '<span class="text-xs bg-red-100 text-red-600 px-1.5 rounded">管理者</span>' : ''}</td>
                <td class="px-4 py-3 text-gray-500 text-xs">${u.email}</td>
                <td class="px-4 py-3"><span class="bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded-full">${roleLabels[u.role] || u.role}</span></td>
                <td class="px-4 py-3 text-gray-500 text-xs">${u.supervisor_name || '-'}</td>
                <td class="px-4 py-3">
                  ${u.is_active ? '<span class="text-green-600 text-xs">● 有効</span>' : '<span class="text-red-400 text-xs">● 無効</span>'}
                  ${u.must_change_password ? '<span class="ml-2 text-xs text-orange-500">PW要変更</span>' : ''}
                </td>
                <td class="px-4 py-3">
                  <div class="flex items-center gap-3">
                    <a href="/admin/users/${u.id}/edit" class="inline-block text-blue-600 hover:text-blue-800 text-xs font-medium px-2 py-1 bg-blue-50 hover:bg-blue-100 rounded transition">編集</a>
                    ${u.employee_number !== 'admin' ? `
                    <button
                      type="button"
                      onclick="deleteUser(${u.id}, '${u.name.replace(/'/g, "\\'")}')"
                      class="inline-block text-red-500 hover:text-red-700 text-xs font-medium px-2 py-1 bg-red-50 hover:bg-red-100 rounded transition">削除</button>
                    ` : '<span class="text-xs text-gray-300">-</span>'}
                  </div>
                </td>
              </tr>
            `).join('')}
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
      // モーダル外クリックで閉じる
      document.getElementById('deleteModal').addEventListener('click', function(e) {
        if (e.target === this) closeDeleteModal();
      });
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

// ユーザー追加フォーム
admin.get('/users/new', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const supervisors = await db.prepare("SELECT * FROM users WHERE is_active = 1 ORDER BY name").all()
  return c.html(layout('ユーザー追加', userForm(null, supervisors.results as any[]), user))
})

// ユーザー追加処理
admin.post('/users', async (c) => {
  const db = c.env.DB
  const body = await c.req.parseBody() as any
  const hash = await hashPassword(body.employee_number) // 初期PW=社員番号
  await db.prepare(`
    INSERT INTO users (employee_number, name, email, department, role, is_admin, supervisor_id, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(
    body.employee_number, body.name, body.email, body.department || null,
    body.role, body.is_admin ? 1 : 0,
    body.supervisor_id ? parseInt(body.supervisor_id) : null, hash
  ).run()
  return c.redirect('/admin/users')
})

// ユーザー編集フォーム
admin.get('/users/:id/edit', async (c) => {
  const user = (c as any).get('user')
  const db = c.env.DB
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(c.req.param('id')).first()
  const supervisors = await db.prepare("SELECT * FROM users WHERE is_active = 1 ORDER BY name").all()
  if (!target) return c.redirect('/admin/users')
  return c.html(layout('ユーザー編集', userForm(target as any, supervisors.results as any[]), user))
})

// ユーザー更新処理
admin.post('/users/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.parseBody() as any
  await db.prepare(`
    UPDATE users SET name=?, email=?, department=?, role=?, is_admin=?, supervisor_id=?, is_active=?, updated_at=datetime("now")
    WHERE id=?
  `).bind(
    body.name, body.email, body.department || null,
    body.role, body.is_admin ? 1 : 0,
    body.supervisor_id ? parseInt(body.supervisor_id) : null,
    body.is_active ? 1 : 0, id
  ).run()

  // パスワードリセット
  if (body.reset_password) {
    const hash = await hashPassword(body.employee_number)
    await db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?').bind(hash, id).run()
  }

  return c.redirect('/admin/users')
})

function userForm(user: any, supervisors: any[]): string {
  const roles = [
    { value: 'front', label: 'フロント' },
    { value: 'manager', label: '上長' },
    { value: 'operations', label: '業務管理課' },
    { value: 'accounting', label: '会計担当（管理組合）' },
    { value: 'honsha', label: '本社経理' },
    { value: 'admin', label: '管理者' },
  ]
  const isEdit = !!user

  return `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6 max-w-2xl">
      <form method="POST" action="${isEdit ? `/admin/users/${user.id}` : '/admin/users'}">
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">社員番号 <span class="text-red-500">*</span></label>
              <input type="text" name="employee_number" value="${user?.employee_number || ''}" ${isEdit ? 'readonly' : 'required'}
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none ${isEdit ? 'bg-gray-50' : ''}">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">氏名 <span class="text-red-500">*</span></label>
              <input type="text" name="name" value="${user?.name || ''}" required
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            </div>
          </div>
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">メールアドレス <span class="text-red-500">*</span></label>
            <input type="email" name="email" value="${user?.email || ''}" required
              class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">部署</label>
              <input type="text" name="department" value="${user?.department || ''}"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">役割 <span class="text-red-500">*</span></label>
              <select name="role" required class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                ${roles.map(r => `<option value="${r.value}" ${user?.role === r.value ? 'selected' : ''}>${r.label}</option>`).join('')}
              </select>
            </div>
          </div>
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">直属上長</label>
            <select name="supervisor_id" class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">なし</option>
              ${supervisors.filter(s => s.id !== user?.id).map(s =>
                `<option value="${s.id}" ${user?.supervisor_id === s.id ? 'selected' : ''}>${s.name}（${s.employee_number}）</option>`
              ).join('')}
            </select>
          </div>
          <div class="flex gap-4">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" name="is_admin" value="1" ${user?.is_admin ? 'checked' : ''}
                class="w-4 h-4 text-blue-600 rounded">
              <span class="text-sm">管理者権限</span>
            </label>
            ${isEdit ? `
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" name="is_active" value="1" ${user?.is_active ? 'checked' : ''}
                class="w-4 h-4 text-blue-600 rounded">
              <span class="text-sm">アカウント有効</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" name="reset_password" value="1"
                class="w-4 h-4 text-orange-500 rounded">
              <span class="text-sm text-orange-600">パスワードリセット（社員番号に戻す）</span>
            </label>
            ` : ''}
          </div>
        </div>
        <div class="flex gap-3 mt-6">
          <a href="/admin/users" class="px-4 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition">キャンセル</a>
          <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-2.5 rounded-lg transition text-sm">
            ${isEdit ? '更新する' : '追加する'}
          </button>
        </div>
      </form>
    </div>
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
    ORDER BY m.name
  `).all()

  const content = `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100">
      <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 class="font-semibold text-gray-800">マンション一覧 <span class="text-blue-600">${mansions.results.length}件</span></h2>
        <a href="/admin/mansions/new" class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition">＋ マンション追加</a>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">マンション名</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">担当フロント</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">組合会計担当者</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            ${(mansions.results as any[]).length === 0 ? '<tr><td colspan="5" class="px-4 py-8 text-center text-gray-400">マンションが登録されていません</td></tr>' :
              (mansions.results as any[]).map(m => `
                <tr class="hover:bg-gray-50">
                  <td class="px-4 py-3 font-medium">${m.name}</td>
                  <td class="px-4 py-3 text-gray-500">${m.front_name || '-'}</td>
                  <td class="px-4 py-3 text-gray-500">${m.accounting_name || '-'}</td>
                  <td class="px-4 py-3">${m.is_active ? '<span class="text-green-600 text-xs">● 有効</span>' : '<span class="text-red-400 text-xs">● 無効</span>'}</td>
                  <td class="px-4 py-3"><a href="/admin/mansions/${m.id}/edit" class="text-blue-600 hover:underline text-xs">編集</a></td>
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
  await db.prepare(
    'INSERT INTO mansions (name, front_user_id, accounting_user_id) VALUES (?, ?, ?)'
  ).bind(body.name, body.front_user_id || null, body.accounting_user_id || null).run()
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

// マンション更新
admin.post('/mansions/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.parseBody() as any
  await db.prepare(
    'UPDATE mansions SET name=?, front_user_id=?, accounting_user_id=?, is_active=?, updated_at=datetime("now") WHERE id=?'
  ).bind(body.name, body.front_user_id || null, body.accounting_user_id || null, body.is_active ? 1 : 0, id).run()
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
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">マンション名 <span class="text-red-500">*</span></label>
            <input type="text" name="name" value="${mansion?.name || ''}" required
              class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
          </div>
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">担当フロント</label>
            <select name="front_user_id" class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">選択してください</option>
              ${fronts.map(u => `<option value="${u.id}" ${mansion?.front_user_id === u.id ? 'selected' : ''}>${u.name}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">管理組合 会計担当者</label>
            <select name="accounting_user_id" class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">選択してください</option>
              ${accountings.map(u => `<option value="${u.id}" ${mansion?.accounting_user_id === u.id ? 'selected' : ''}>${u.name}</option>`).join('')}
            </select>
          </div>
          ${isEdit ? `
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" name="is_active" value="1" ${mansion?.is_active ? 'checked' : ''} class="w-4 h-4 text-blue-600 rounded">
            <span class="text-sm">有効</span>
          </label>
          ` : ''}
        </div>
        <div class="flex gap-3 mt-6">
          <a href="/admin/mansions" class="px-4 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition">キャンセル</a>
          <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-2.5 rounded-lg transition text-sm">${isEdit ? '更新する' : '追加する'}</button>
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
                <span class="ml-2 text-xs ${o.is_primary ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500'} px-2 py-0.5 rounded-full">${o.is_primary ? '担当' : '予備'}</span>
              </div>
              <form method="POST" action="/admin/staff/ops/${o.id}/delete"><button type="submit" class="text-red-400 hover:text-red-600 text-xs" onclick="return confirm('削除しますか？')">削除</button></form>
            </div>
          `).join('')}
        </div>
        <form method="POST" action="/admin/staff/ops" class="flex gap-2">
          <select name="user_id" required class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            <option value="">ユーザーを選択</option>
            ${(allUsers.results as any[]).map(u => `<option value="${u.id}">${u.name}</option>`).join('')}
          </select>
          <select name="is_primary" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            <option value="1">担当</option>
            <option value="0">予備</option>
          </select>
          <button type="submit" class="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 transition">追加</button>
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
          <select name="user_id" required class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            <option value="">ユーザーを選択</option>
            ${(allUsers.results as any[]).map(u => `<option value="${u.id}">${u.name}</option>`).join('')}
          </select>
          <button type="submit" class="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 transition">追加</button>
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
      <div class="bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-start gap-3">
        <svg class="w-5 h-5 text-blue-500 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.910 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/>
        </svg>
        <div>
          <p class="text-sm font-semibold text-blue-800">Gmail送信設定</p>
          <p class="text-xs text-blue-600 mt-0.5">送信元アカウント：<strong>tokyo.defense.mail@gmail.com</strong></p>
          <p class="text-xs text-blue-500 mt-0.5">メール送信には MailChannels API を経由してGmail認証を行います。</p>
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
                  class="w-full pl-9 pr-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-gray-50"
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
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
              <p class="text-xs text-gray-400 mt-1">
                現在のパスワードは設定済みです。変更する場合のみ入力してください。
              </p>
            </div>

            <!-- 送信者名 -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">送信者名（メールの差出人表示）</label>
              <input type="text" name="from_name"
                value="${smtp?.from_name || '請求書回覧システム（東京ディフェンス）'}"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
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
              class="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-2.5 rounded-lg transition text-sm">
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

  const existing = await db.prepare('SELECT id FROM smtp_settings LIMIT 1').first()

  if (existing) {
    let sql = 'UPDATE smtp_settings SET host=?, port=?, username=?, from_email=?, from_name=?, use_tls=?, updated_at=datetime("now")'
    const params: any[] = [host, port, username, from_email, from_name, use_tls]
    if (body.password) { sql += ', password=?'; params.push(body.password) }
    sql += ' WHERE id=?'; params.push((existing as any).id)
    await db.prepare(sql).bind(...params).run()
  } else {
    await db.prepare(
      'INSERT INTO smtp_settings (host, port, username, password, from_email, from_name, use_tls) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(host, port, username, body.password || null, from_email, from_name, use_tls).run()
  }
  return c.redirect('/admin/smtp?saved=1')
})

export default admin
