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
    accounting: '会計担当', honsha: '本社明利', admin: '管理者'
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
                <td class="px-4 py-3"><a href="/admin/users/${u.id}/edit" class="text-blue-600 hover:underline text-xs">編集</a></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `
  return c.html(layout('ユーザー管理', content, user))
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
    { value: 'honsha', label: '本社明利' },
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

// 担当者設定（業務管理課・本社明利）
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

      <!-- 本社明利 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 class="font-semibold text-gray-800 mb-4">本社明利担当者設定</h2>
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

// SMTP設定
admin.get('/smtp', async (c) => {
  const user = (c as any).get('user')
  const smtp = await c.env.DB.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any

  const content = `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6 max-w-xl">
      <form method="POST" action="/admin/smtp">
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-4">
            <div class="col-span-2">
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">SMTPサーバー <span class="text-red-500">*</span></label>
              <input type="text" name="host" value="${smtp?.host || ''}" required placeholder="mail.example.co.jp"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">ポート番号</label>
              <input type="number" name="port" value="${smtp?.port || 587}"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">TLS使用</label>
              <select name="use_tls" class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                <option value="1" ${smtp?.use_tls ? 'selected' : ''}>使用する</option>
                <option value="0" ${!smtp?.use_tls ? 'selected' : ''}>使用しない</option>
              </select>
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">認証ユーザー名</label>
              <input type="text" name="username" value="${smtp?.username || ''}" placeholder="任意"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">認証パスワード</label>
              <input type="password" name="password" placeholder="変更する場合のみ入力"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">送信元メールアドレス <span class="text-red-500">*</span></label>
              <input type="email" name="from_email" value="${smtp?.from_email || ''}" required
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">送信者名</label>
              <input type="text" name="from_name" value="${smtp?.from_name || '請求書回覧システム'}"
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            </div>
          </div>
        </div>
        <div class="flex gap-3 mt-6">
          <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-2.5 rounded-lg transition text-sm">保存する</button>
        </div>
      </form>
    </div>
  `
  return c.html(layout('メール設定（SMTP）', content, user))
})

admin.post('/smtp', async (c) => {
  const db = c.env.DB
  const body = await c.req.parseBody() as any
  const existing = await db.prepare('SELECT id FROM smtp_settings LIMIT 1').first()

  if (existing) {
    let sql = 'UPDATE smtp_settings SET host=?, port=?, username=?, from_email=?, from_name=?, use_tls=?, updated_at=datetime("now")'
    const params: any[] = [body.host, parseInt(body.port), body.username || null, body.from_email, body.from_name, body.use_tls === '1' ? 1 : 0]
    if (body.password) { sql += ', password=?'; params.push(body.password) }
    sql += ' WHERE id=?'; params.push((existing as any).id)
    await db.prepare(sql).bind(...params).run()
  } else {
    await db.prepare('INSERT INTO smtp_settings (host, port, username, password, from_email, from_name, use_tls) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(body.host, parseInt(body.port), body.username || null, body.password || null, body.from_email, body.from_name, body.use_tls === '1' ? 1 : 0).run()
  }
  return c.redirect('/admin/smtp')
})

export default admin
