import { Hono } from 'hono'
import { getSessionUser, getSessionIdFromCookie, generateApplicationNumber } from '../lib/auth'
import { layout, statusBadge, paymentLabel } from './layout'
import { buildMailSubject, buildMailBody, sendMail } from '../lib/mail'

type Bindings = { DB: D1Database; R2: R2Bucket }
const applications = new Hono<{ Bindings: Bindings }>()

// 申請一覧・検索
applications.get('/', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const q = c.req.query('q') || ''
  const status = c.req.query('status') || ''
  const from = c.req.query('from') || ''
  const to = c.req.query('to') || ''

  let sql = `SELECT a.*, m.name as mansion_name, u.name as applicant_name
    FROM applications a
    LEFT JOIN mansions m ON a.mansion_id = m.id
    LEFT JOIN users u ON a.applicant_id = u.id
    WHERE 1=1`
  const params: any[] = []

  if (q) { sql += ` AND (m.name LIKE ? OR a.title LIKE ? OR a.application_number LIKE ?)`; params.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  if (status) { sql += ` AND a.status = ?`; params.push(status) }
  if (from) { sql += ` AND a.created_at >= ?`; params.push(from) }
  if (to) { sql += ` AND a.created_at <= ?`; params.push(to + ' 23:59:59') }
  sql += ` ORDER BY a.created_at DESC LIMIT 100`

  const apps = await db.prepare(sql).bind(...params).all()

  const content = `
    <!-- 検索フォーム -->
    <form method="GET" action="/applications" class="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-6">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
        <input type="text" name="q" value="${q}" placeholder="マンション名・申請番号で検索"
          class="col-span-2 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
        <select name="status" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
          <option value="">すべての状態</option>
          <option value="circulating" ${status==='circulating'?'selected':''}>回覧中</option>
          <option value="completed" ${status==='completed'?'selected':''}>完了</option>
          <option value="rejected" ${status==='rejected'?'selected':''}>差し戻し</option>
          <option value="on_hold" ${status==='on_hold'?'selected':''}>保留中</option>
          <option value="draft" ${status==='draft'?'selected':''}>下書き</option>
        </select>
        <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition">検索</button>
      </div>
      <div class="grid grid-cols-2 gap-3 mt-3">
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-500 whitespace-nowrap">期間（開始）</label>
          <input type="date" name="from" value="${from}" class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
        </div>
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-500 whitespace-nowrap">期間（終了）</label>
          <input type="date" name="to" value="${to}" class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
        </div>
      </div>
    </form>

    <!-- 結果一覧 -->
    <div class="bg-white rounded-xl shadow-sm border border-gray-100">
      <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 class="font-semibold text-gray-800">検索結果 <span class="text-blue-600">${apps.results.length}件</span></h2>
        <a href="/applications/new" class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition">＋ 新規申請</a>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">申請番号</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">マンション名</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">申請者</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">支払先</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">金額</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">申請日</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            ${apps.results.length === 0 ? `<tr><td colspan="8" class="px-4 py-8 text-center text-gray-400">該当する申請はありません</td></tr>` :
              (apps.results as any[]).map(app => `
                <tr class="hover:bg-gray-50">
                  <td class="px-4 py-3 text-gray-500 text-xs">${app.application_number}${app.resubmit_count > 0 ? `<span class="ml-1 bg-purple-100 text-purple-600 text-xs px-1.5 rounded">再提出</span>` : ''}</td>
                  <td class="px-4 py-3 font-medium text-gray-800">${app.mansion_name || app.title}</td>
                  <td class="px-4 py-3 text-gray-600">${app.applicant_name}</td>
                  <td class="px-4 py-3">${app.payment_target === 'kumiai' ? '<span class="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full">管理組合</span>' : '<span class="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full">会社(TD)</span>'}</td>
                  <td class="px-4 py-3 text-gray-700">${Number(app.budget_amount).toLocaleString()}円</td>
                  <td class="px-4 py-3">${statusBadge(app.status)}</td>
                  <td class="px-4 py-3 text-gray-400 text-xs">${app.created_at?.substring(0,10)}</td>
                  <td class="px-4 py-3"><a href="/applications/${app.id}" class="text-blue-600 hover:underline text-xs">詳細</a></td>
                </tr>
              `).join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `
  return c.html(layout('申請一覧', content, user))
})

// 新規申請フォーム
applications.get('/new', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const mansions = await db.prepare(
    'SELECT * FROM mansions WHERE is_active = 1 ORDER BY name'
  ).all()

  const today = new Date().toISOString().substring(0, 10)

  const content = `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6 max-w-3xl">
      <!-- ステップ表示 -->
      <div class="flex items-center gap-2 mb-8">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">1</div>
          <span class="text-sm font-semibold text-blue-600">内容の入力</span>
        </div>
        <div class="flex-1 h-px bg-gray-200"></div>
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 bg-gray-200 text-gray-400 rounded-full flex items-center justify-center text-sm font-bold">2</div>
          <span class="text-sm text-gray-400">回覧先の確認</span>
        </div>
        <div class="flex-1 h-px bg-gray-200"></div>
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 bg-gray-200 text-gray-400 rounded-full flex items-center justify-center text-sm font-bold">3</div>
          <span class="text-sm text-gray-400">内容の確認</span>
        </div>
      </div>

      <form method="POST" action="/applications" enctype="multipart/form-data" id="appForm">
        <div class="space-y-5">
          <!-- 標題 -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">標題（マンション名） <span class="text-red-500">*</span></label>
            <select name="mansion_id" required onchange="updateTitle(this)"
              class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">マンションを選択してください</option>
              ${(mansions.results as any[]).map(m =>
                `<option value="${m.id}">${m.name}</option>`
              ).join('')}
            </select>
            <input type="hidden" name="title" id="titleInput">
          </div>

          <!-- 申請者・回覧開始日 -->
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">申請者</label>
              <input type="text" value="${user.name}" disabled
                class="w-full px-3 py-2.5 border border-gray-200 bg-gray-50 rounded-lg text-sm text-gray-500">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">回覧開始日</label>
              <input type="date" name="circulation_start_date" value="${today}" required
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            </div>
          </div>

          <!-- 支払先 -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">支払先 <span class="text-red-500">*</span></label>
            <div class="flex gap-4">
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="payment_target" value="kumiai" required onchange="togglePaymentFields()"
                  class="w-4 h-4 text-blue-600">
                <span class="text-sm">管理組合</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="payment_target" value="td" onchange="togglePaymentFields()"
                  class="w-4 h-4 text-blue-600">
                <span class="text-sm">会社（TD）</span>
              </label>
            </div>
          </div>

          <!-- 管理組合の場合：勘定科目 -->
          <div id="kumiaiFields" class="hidden bg-green-50 border border-green-200 rounded-lg p-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">勘定科目 <span class="text-red-500">*</span></label>
            <select name="account_item"
              class="w-full px-3 py-2.5 border border-gray-300 bg-white rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">選択してください</option>
              <option value="予備費">予備費</option>
              <option value="小修繕費">小修繕費</option>
              <option value="修繕費">修繕費</option>
              <option value="保険修繕費">保険修繕費</option>
              <option value="その他">その他</option>
            </select>
          </div>

          <!-- TD（会社）の場合 -->
          <div id="tdFields" class="hidden bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">区分 <span class="text-red-500">*</span></label>
              <div class="flex gap-4">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="td_type" value="ittaku" onchange="toggleMotouke()"
                    class="w-4 h-4 text-blue-600">
                  <span class="text-sm">委託内</span>
                </label>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="td_type" value="motouke" onchange="toggleMotouke()"
                    class="w-4 h-4 text-blue-600">
                  <span class="text-sm">元請</span>
                </label>
              </div>
            </div>
            <!-- 元請の場合：管理組合への請求金額 -->
            <div id="motoukeFields" class="hidden">
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">管理組合への請求金額（円）</label>
              <input type="number" name="kumiai_amount" min="0"
                class="w-full px-3 py-2.5 border border-gray-300 bg-white rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="0">
            </div>
          </div>

          <!-- 金額 -->
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">予算料（円） <span class="text-red-500">*</span></label>
              <div class="relative">
                <input type="number" name="budget_amount" required min="0"
                  class="w-full px-3 py-2.5 pr-8 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="0">
                <span class="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">円</span>
              </div>
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">手数料（%）キックバック</label>
              <div class="relative">
                <input type="number" name="commission_rate" min="0" max="100" step="0.1"
                  class="w-full px-3 py-2.5 pr-8 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="0.0">
                <span class="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
              </div>
            </div>
          </div>

          <!-- 備考 -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">備考</label>
            <textarea name="remarks" rows="3"
              class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none"
              placeholder="備考があれば入力してください"></textarea>
          </div>

          <!-- 添付ファイル -->
          <div class="border border-gray-200 rounded-lg p-4 space-y-3">
            <h3 class="text-sm font-semibold text-gray-700">添付ファイル</h3>
            <div>
              <label class="block text-xs text-gray-500 mb-1">添付資料（請求書）① <span class="text-red-500">*</span></label>
              <input type="file" name="invoice1" required accept=".pdf,.jpg,.jpeg,.png"
                class="w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-blue-50 file:text-blue-600 hover:file:bg-blue-100">
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">添付資料（請求書）②</label>
              <input type="file" name="invoice2" accept=".pdf,.jpg,.jpeg,.png"
                class="w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-blue-50 file:text-blue-600 hover:file:bg-blue-100">
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">添付資料①</label>
              <input type="file" name="other1" accept=".pdf,.jpg,.jpeg,.png"
                class="w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-blue-50 file:text-blue-600 hover:file:bg-blue-100">
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">添付資料②</label>
              <input type="file" name="other2" accept=".pdf,.jpg,.jpeg,.png"
                class="w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-blue-50 file:text-blue-600 hover:file:bg-blue-100">
            </div>
          </div>
        </div>

        <div class="flex gap-3 mt-8">
          <a href="/" class="flex-1 text-center px-4 py-3 border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition text-sm font-semibold">
            キャンセル
          </a>
          <button type="submit" class="flex-2 flex-grow-[2] bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-8 rounded-lg transition text-sm">
            次へ：回覧先の確認 →
          </button>
        </div>
      </form>
    </div>

    <script>
      function updateTitle(sel) {
        const text = sel.options[sel.selectedIndex]?.text || ''
        document.getElementById('titleInput').value = text
      }
      function togglePaymentFields() {
        const val = document.querySelector('input[name="payment_target"]:checked')?.value
        document.getElementById('kumiaiFields').classList.toggle('hidden', val !== 'kumiai')
        document.getElementById('tdFields').classList.toggle('hidden', val !== 'td')
        if (val !== 'td') document.getElementById('motoukeFields').classList.add('hidden')
      }
      function toggleMotouke() {
        const val = document.querySelector('input[name="td_type"]:checked')?.value
        document.getElementById('motoukeFields').classList.toggle('hidden', val !== 'motouke')
      }
    </script>
  `
  return c.html(layout('新規申請', content, user))
})

// 申請保存（Step2→3はStep1送信後にconfirmページ表示）
applications.post('/', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const body = await c.req.parseBody({ all: true }) as any

  const appNumber = generateApplicationNumber()
  const mansionId = body.mansion_id ? parseInt(body.mansion_id) : null

  // ファイル保存（R2）
  const fileKeys: Record<string, string> = {}
  const fileNames: Record<string, string> = {}
  for (const fileKey of ['invoice1', 'invoice2', 'other1', 'other2']) {
    const file = body[fileKey] as File | undefined
    if (file && file.size > 0) {
      const ext = file.name.split('.').pop()
      const key = `attachments/${appNumber}/${fileKey}.${ext}`
      await c.env.R2.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type }
      })
      fileKeys[fileKey] = key
      fileNames[fileKey] = file.name
    }
  }

  // 申請を保存
  const result = await db.prepare(`
    INSERT INTO applications (
      application_number, title, mansion_id, applicant_id, circulation_start_date,
      payment_target, account_item, td_type, kumiai_amount, budget_amount,
      commission_rate, remarks, status, current_step, resubmit_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'circulating', 1, 0)
  `).bind(
    appNumber,
    body.title || '',
    mansionId,
    user.uid,
    body.circulation_start_date,
    body.payment_target,
    body.account_item || null,
    body.td_type || null,
    body.kumiai_amount ? parseInt(body.kumiai_amount) : null,
    parseInt(body.budget_amount) || 0,
    body.commission_rate ? parseFloat(body.commission_rate) : null,
    body.remarks || null
  ).run()

  const appId = result.meta.last_row_id

  // 添付ファイル保存
  for (const [fk, key] of Object.entries(fileKeys)) {
    await db.prepare(
      'INSERT INTO attachments (application_id, file_type, file_name, file_key) VALUES (?, ?, ?, ?)'
    ).bind(appId, fk, fileNames[fk], key).run()
  }

  // 回覧ステップ作成
  await createCirculationSteps(db, appId as number, user.uid, body.payment_target, mansionId)

  // 最初の承認者にメール通知
  const firstStep = await db.prepare(
    'SELECT cs.*, u.email, u.name FROM circulation_steps cs JOIN users u ON cs.reviewer_id = u.id WHERE cs.application_id = ? AND cs.step_number = 1'
  ).bind(appId).first() as any

  if (firstStep) {
    const smtp = await db.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any
    if (smtp) {
      const appUrl = `${new URL(c.req.url).origin}/applications/${appId}`
      await sendMail(smtp, {
        to: firstStep.email,
        subject: buildMailSubject('review_request', appNumber),
        html: buildMailBody('review_request', { appNumber, title: body.title, applicantName: user.name, appUrl })
      })
      await db.prepare(
        'INSERT INTO notification_logs (application_id, recipient_id, notification_type, email_to, subject) VALUES (?, ?, ?, ?, ?)'
      ).bind(appId, firstStep.reviewer_id, 'review_request', firstStep.email, buildMailSubject('review_request', appNumber)).run()
    }
  }

  return c.redirect(`/applications/${appId}`)
})

// 回覧ステップ作成関数
async function createCirculationSteps(db: D1Database, appId: number, applicantId: number, paymentTarget: string, mansionId: number | null) {
  // Step1: 直属上長
  const supervisor = await db.prepare(
    'SELECT supervisor_id FROM users WHERE id = ?'
  ).bind(applicantId).first() as any

  if (supervisor?.supervisor_id) {
    await db.prepare(
      'INSERT INTO circulation_steps (application_id, step_number, reviewer_id, status) VALUES (?, 1, ?, "pending")'
    ).bind(appId, supervisor.supervisor_id).run()
  }

  // Step2: 業務管理課（担当1名）
  const opStaff = await db.prepare(
    'SELECT user_id FROM operations_staff WHERE is_primary = 1 LIMIT 1'
  ).first() as any
  if (opStaff) {
    await db.prepare(
      'INSERT INTO circulation_steps (application_id, step_number, reviewer_id, status) VALUES (?, 2, ?, "pending")'
    ).bind(appId, opStaff.user_id).run()
  }

  // Step3: 支払先による分岐
  if (paymentTarget === 'kumiai' && mansionId) {
    // A) マンション担当会計担当者
    const mansion = await db.prepare(
      'SELECT accounting_user_id FROM mansions WHERE id = ?'
    ).bind(mansionId).first() as any
    if (mansion?.accounting_user_id) {
      await db.prepare(
        'INSERT INTO circulation_steps (application_id, step_number, reviewer_id, status) VALUES (?, 3, ?, "pending")'
      ).bind(appId, mansion.accounting_user_id).run()
    }
  } else {
    // B) 本社明利
    const honsha = await db.prepare(
      'SELECT user_id FROM honsha_staff LIMIT 1'
    ).first() as any
    if (honsha) {
      await db.prepare(
        'INSERT INTO circulation_steps (application_id, step_number, reviewer_id, status) VALUES (?, 3, ?, "pending")'
      ).bind(appId, honsha.user_id).run()
    }
  }
}

// 申請詳細
applications.get('/:id', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const id = c.req.param('id')

  const app = await db.prepare(`
    SELECT a.*, m.name as mansion_name, u.name as applicant_name, u.email as applicant_email
    FROM applications a
    LEFT JOIN mansions m ON a.mansion_id = m.id
    LEFT JOIN users u ON a.applicant_id = u.id
    WHERE a.id = ?
  `).bind(id).first() as any

  if (!app) return c.notFound()

  const steps = await db.prepare(`
    SELECT cs.*, u.name as reviewer_name, u.role as reviewer_role
    FROM circulation_steps cs
    JOIN users u ON cs.reviewer_id = u.id
    WHERE cs.application_id = ?
    ORDER BY cs.step_number
  `).bind(id).all()

  const attachments = await db.prepare(
    'SELECT * FROM attachments WHERE application_id = ?'
  ).bind(id).all()

  // 自分がレビュアーの保留ステップを確認
  const myHoldStep = (steps.results as any[]).find(
    s => s.reviewer_id === user.uid && s.status === 'on_hold'
  )

  const stepLabels: Record<number, string> = { 1: '上長', 2: '業務管理課', 3: '最終承認者' }
  const stepStatusIcon: Record<string, string> = {
    pending: '⏳',
    approved: '✅',
    rejected: '❌',
    on_hold: '⏸',
  }

  const isApplicant = app.applicant_id === user.uid
  const isRejected = app.status === 'rejected'

  const content = `
    <div class="space-y-6 max-w-3xl">
      <!-- ヘッダー -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div class="flex items-start justify-between mb-4">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs text-gray-400">${app.application_number}</span>
              ${app.resubmit_count > 0 ? `<span class="bg-purple-100 text-purple-600 text-xs font-semibold px-2 py-0.5 rounded-full">再提出 ${app.resubmit_count}回目</span>` : ''}
            </div>
            <h2 class="text-xl font-bold text-gray-800">${app.mansion_name || app.title}</h2>
          </div>
          ${statusBadge(app.status)}
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <div><span class="text-gray-400">申請者</span><p class="font-medium mt-0.5">${app.applicant_name}</p></div>
          <div><span class="text-gray-400">回覧開始日</span><p class="font-medium mt-0.5">${app.circulation_start_date}</p></div>
          <div><span class="text-gray-400">支払先</span><p class="font-medium mt-0.5">${paymentLabel(app.payment_target, app.td_type)}</p></div>
          ${app.account_item ? `<div><span class="text-gray-400">勘定科目</span><p class="font-medium mt-0.5">${app.account_item}</p></div>` : ''}
          <div><span class="text-gray-400">予算料</span><p class="font-medium mt-0.5">${Number(app.budget_amount).toLocaleString()}円</p></div>
          ${app.commission_rate ? `<div><span class="text-gray-400">手数料</span><p class="font-medium mt-0.5">${app.commission_rate}%</p></div>` : ''}
          ${app.kumiai_amount ? `<div><span class="text-gray-400">組合請求金額</span><p class="font-medium mt-0.5">${Number(app.kumiai_amount).toLocaleString()}円</p></div>` : ''}
          ${app.remarks ? `<div class="col-span-2"><span class="text-gray-400">備考</span><p class="font-medium mt-0.5">${app.remarks}</p></div>` : ''}
        </div>
      </div>

      <!-- 添付ファイル -->
      ${(attachments.results as any[]).length > 0 ? `
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="font-semibold text-gray-800 mb-3">添付ファイル</h3>
        <div class="space-y-2">
          ${(attachments.results as any[]).map(att => {
            const labels: Record<string, string> = { invoice1: '請求書①', invoice2: '請求書②', other1: '添付資料①', other2: '添付資料②' }
            return `<div class="flex items-center gap-2">
              <span class="text-xs text-gray-400">${labels[att.file_type] || att.file_type}</span>
              <a href="/files/${att.id}" target="_blank" class="text-sm text-blue-600 hover:underline flex items-center gap-1">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/></svg>
                ${att.file_name}
              </a>
            </div>`
          }).join('')}
        </div>
      </div>
      ` : ''}

      <!-- 回覧フロー -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="font-semibold text-gray-800 mb-4">回覧フロー</h3>
        <div class="space-y-3">
          <div class="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
            <div class="w-8 h-8 bg-green-500 text-white rounded-full flex items-center justify-center text-xs font-bold">申</div>
            <div>
              <p class="text-sm font-semibold">${app.applicant_name}（申請者）</p>
              <p class="text-xs text-gray-400">${app.created_at?.substring(0,16)}</p>
            </div>
            <span class="ml-auto text-green-500 text-lg">✅</span>
          </div>
          ${(steps.results as any[]).map(step => `
            <div class="flex items-start gap-3 p-3 rounded-lg ${step.status === 'pending' && app.current_step === step.step_number ? 'bg-orange-50 border border-orange-200' : 'bg-gray-50'}">
              <div class="w-8 h-8 ${step.status === 'approved' ? 'bg-green-500' : step.status === 'rejected' ? 'bg-red-500' : step.status === 'on_hold' ? 'bg-yellow-500' : 'bg-gray-300'} text-white rounded-full flex items-center justify-center text-xs font-bold shrink-0">${step.step_number}</div>
              <div class="flex-1">
                <p class="text-sm font-semibold">${step.reviewer_name} <span class="text-xs text-gray-400">(${stepLabels[step.step_number] || 'レビュー'})</span></p>
                ${step.action_comment ? `<p class="text-xs text-gray-600 mt-0.5 bg-white rounded p-2 mt-1">${step.status === 'on_hold' ? '❓ ' : '💬 '}${step.action_comment}</p>` : ''}
                ${step.hold_answer ? `<p class="text-xs text-blue-600 mt-1 bg-blue-50 rounded p-2">📝 回答: ${step.hold_answer}</p>` : ''}
                ${step.acted_at ? `<p class="text-xs text-gray-400 mt-0.5">${step.acted_at?.substring(0,16)}</p>` : ''}
              </div>
              <span class="text-lg">${stepStatusIcon[step.status] || '⏳'}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- 保留回答フォーム（自分が申請者で保留中の場合） -->
      ${myHoldStep && isApplicant ? `
      <div class="bg-yellow-50 border border-yellow-300 rounded-xl p-6">
        <h3 class="font-semibold text-yellow-800 mb-2">⏸ 保留中 - 回答が必要です</h3>
        <p class="text-sm text-yellow-700 mb-3 bg-white rounded p-3">${myHoldStep.action_comment}</p>
        <form method="POST" action="/applications/${id}/answer/${myHoldStep.id}">
          <textarea name="answer" required rows="3" placeholder="回答を入力してください"
            class="w-full px-3 py-2 border border-yellow-300 rounded-lg text-sm focus:ring-2 focus:ring-yellow-400 outline-none resize-none mb-3"></textarea>
          <button type="submit" class="bg-yellow-500 hover:bg-yellow-600 text-white font-semibold px-6 py-2 rounded-lg transition text-sm">
            回答を送信
          </button>
        </form>
      </div>
      ` : ''}

      <!-- 差し戻し後の再提出 -->
      ${isApplicant && isRejected ? `
      <div class="bg-red-50 border border-red-200 rounded-xl p-6">
        <h3 class="font-semibold text-red-800 mb-2">❌ 差し戻し</h3>
        <p class="text-sm text-red-600 mb-4">この申請は差し戻されました。同じ内容で再提出できます。</p>
        <form method="POST" action="/applications/${id}/resubmit">
          <button type="submit" class="bg-red-500 hover:bg-red-600 text-white font-semibold px-6 py-2 rounded-lg transition text-sm"
            onclick="return confirm('同じ内容で再提出しますか？')">
            再提出する
          </button>
        </form>
      </div>
      ` : ''}

      <div class="flex gap-3">
        <a href="/applications" class="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1">
          ← 一覧に戻る
        </a>
      </div>
    </div>
  `
  return c.html(layout(`申請詳細: ${app.mansion_name || app.title}`, content, user))
})

// 承認アクション画面
applications.get('/:id/review/:stepId', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const { id, stepId } = c.req.param()

  const step = await db.prepare(
    'SELECT cs.*, u.name as reviewer_name FROM circulation_steps cs JOIN users u ON cs.reviewer_id = u.id WHERE cs.id = ? AND cs.application_id = ?'
  ).bind(stepId, id).first() as any

  if (!step || step.reviewer_id !== user.uid || step.status !== 'pending') {
    return c.redirect(`/applications/${id}`)
  }

  const app = await db.prepare(`
    SELECT a.*, m.name as mansion_name, u.name as applicant_name
    FROM applications a LEFT JOIN mansions m ON a.mansion_id = m.id
    LEFT JOIN users u ON a.applicant_id = u.id WHERE a.id = ?
  `).bind(id).first() as any

  const attachments = await db.prepare('SELECT * FROM attachments WHERE application_id = ?').bind(id).all()

  const content = `
    <div class="max-w-2xl space-y-6">
      <!-- 申請概要 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div class="flex items-center gap-2 mb-4">
          <span class="text-xs text-gray-400">${app.application_number}</span>
          ${app.resubmit_count > 0 ? `<span class="bg-purple-100 text-purple-600 text-xs font-semibold px-2 py-0.5 rounded-full">再提出 ${app.resubmit_count}回目</span>` : ''}
        </div>
        <h2 class="text-lg font-bold text-gray-800 mb-4">${app.mansion_name || app.title}</h2>
        <div class="grid grid-cols-2 gap-3 text-sm">
          <div><span class="text-gray-400">申請者</span><p class="font-medium">${app.applicant_name}</p></div>
          <div><span class="text-gray-400">支払先</span><p class="font-medium">${paymentLabel(app.payment_target, app.td_type)}</p></div>
          ${app.account_item ? `<div><span class="text-gray-400">勘定科目</span><p class="font-medium">${app.account_item}</p></div>` : ''}
          <div><span class="text-gray-400">予算料</span><p class="font-medium">${Number(app.budget_amount).toLocaleString()}円</p></div>
          ${app.commission_rate ? `<div><span class="text-gray-400">手数料</span><p class="font-medium">${app.commission_rate}%</p></div>` : ''}
          ${app.kumiai_amount ? `<div><span class="text-gray-400">組合請求金額</span><p class="font-medium">${Number(app.kumiai_amount).toLocaleString()}円</p></div>` : ''}
          ${app.remarks ? `<div class="col-span-2"><span class="text-gray-400">備考</span><p class="font-medium">${app.remarks}</p></div>` : ''}
        </div>
        ${(attachments.results as any[]).length > 0 ? `
          <div class="mt-4 pt-4 border-t border-gray-100">
            <p class="text-xs text-gray-400 mb-2">添付ファイル</p>
            <div class="flex flex-wrap gap-2">
              ${(attachments.results as any[]).map(att => {
                const labels: Record<string, string> = { invoice1: '請求書①', invoice2: '請求書②', other1: '添付①', other2: '添付②' }
                return `<a href="/files/${att.id}" target="_blank" class="text-xs text-blue-600 hover:underline bg-blue-50 px-2 py-1 rounded">${labels[att.file_type]}: ${att.file_name}</a>`
              }).join('')}
            </div>
          </div>
        ` : ''}
      </div>

      <!-- アクションフォーム -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="font-semibold text-gray-800 mb-4">承認アクション</h3>
        <form method="POST" action="/applications/${id}/review/${stepId}" id="reviewForm">
          <input type="hidden" name="action" id="actionInput">
          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">コメント（差し戻し・保留の場合は必須）</label>
            <textarea name="comment" id="commentArea" rows="4"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none"
              placeholder="差し戻し理由または質問を入力してください"></textarea>
          </div>
          <div class="flex gap-3">
            <button type="button" onclick="submitAction('approve')"
              class="flex-1 bg-green-500 hover:bg-green-600 text-white font-semibold py-3 rounded-lg transition text-sm flex items-center justify-center gap-2">
              ✅ 承認
            </button>
            <button type="button" onclick="submitAction('reject')"
              class="flex-1 bg-red-500 hover:bg-red-600 text-white font-semibold py-3 rounded-lg transition text-sm flex items-center justify-center gap-2">
              ❌ 差し戻し
            </button>
            <button type="button" onclick="submitAction('hold')"
              class="flex-1 bg-yellow-500 hover:bg-yellow-600 text-white font-semibold py-3 rounded-lg transition text-sm flex items-center justify-center gap-2">
              ⏸ 保留
            </button>
          </div>
        </form>
      </div>

      <a href="/applications/${id}" class="text-sm text-gray-500 hover:text-gray-700">← 詳細に戻る</a>
    </div>

    <script>
      function submitAction(action) {
        const comment = document.getElementById('commentArea').value.trim()
        if ((action === 'reject' || action === 'hold') && !comment) {
          alert(action === 'reject' ? '差し戻し理由を入力してください' : '質問内容を入力してください')
          return
        }
        if (action === 'approve' && !confirm('この申請を承認しますか？')) return
        document.getElementById('actionInput').value = action
        document.getElementById('reviewForm').submit()
      }
    </script>
  `
  return c.html(layout('承認・差し戻し', content, user))
})

// 承認アクション処理
applications.post('/:id/review/:stepId', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const { id, stepId } = c.req.param()
  const body = await c.req.parseBody() as any
  const { action, comment } = body

  const step = await db.prepare(
    'SELECT * FROM circulation_steps WHERE id = ? AND application_id = ?'
  ).bind(stepId, id).first() as any
  if (!step || step.reviewer_id !== user.uid) return c.redirect(`/applications/${id}`)

  const app = await db.prepare(`
    SELECT a.*, u.email as applicant_email, u.name as applicant_name
    FROM applications a JOIN users u ON a.applicant_id = u.id WHERE a.id = ?
  `).bind(id).first() as any

  const smtp = await db.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any
  const appUrl = `${new URL(c.req.url).origin}/applications/${id}`

  if (action === 'approve') {
    // ステップを承認
    await db.prepare(
      'UPDATE circulation_steps SET status = "approved", acted_at = datetime("now") WHERE id = ?'
    ).bind(stepId).run()

    // 次のステップへ
    const nextStep = await db.prepare(
      'SELECT cs.*, u.email, u.name FROM circulation_steps cs JOIN users u ON cs.reviewer_id = u.id WHERE cs.application_id = ? AND cs.step_number = ? AND cs.status = "pending"'
    ).bind(id, step.step_number + 1).first() as any

    if (nextStep) {
      await db.prepare('UPDATE applications SET current_step = ?, updated_at = datetime("now") WHERE id = ?').bind(step.step_number + 1, id).run()
      if (smtp) {
        await sendMail(smtp, { to: nextStep.email, subject: buildMailSubject('review_request', app.application_number), html: buildMailBody('review_request', { appNumber: app.application_number, title: app.title, applicantName: app.applicant_name, appUrl }) })
      }
    } else {
      // 全ステップ完了
      await db.prepare('UPDATE applications SET status = "completed", updated_at = datetime("now") WHERE id = ?').bind(id).run()
      if (smtp) {
        await sendMail(smtp, { to: app.applicant_email, subject: buildMailSubject('completed', app.application_number), html: buildMailBody('completed', { appNumber: app.application_number, title: app.title, applicantName: app.applicant_name, appUrl }) })
      }
    }

  } else if (action === 'reject') {
    await db.prepare(
      'UPDATE circulation_steps SET status = "rejected", action_comment = ?, acted_at = datetime("now") WHERE id = ?'
    ).bind(comment, stepId).run()
    await db.prepare('UPDATE applications SET status = "rejected", updated_at = datetime("now") WHERE id = ?').bind(id).run()
    if (smtp) {
      await sendMail(smtp, { to: app.applicant_email, subject: buildMailSubject('rejected', app.application_number), html: buildMailBody('rejected', { appNumber: app.application_number, title: app.title, applicantName: app.applicant_name, comment, appUrl }) })
    }

  } else if (action === 'hold') {
    await db.prepare(
      'UPDATE circulation_steps SET status = "on_hold", action_comment = ?, acted_at = datetime("now") WHERE id = ?'
    ).bind(comment, stepId).run()
    await db.prepare('UPDATE applications SET status = "on_hold", updated_at = datetime("now") WHERE id = ?').bind(id).run()
    if (smtp) {
      await sendMail(smtp, { to: app.applicant_email, subject: buildMailSubject('on_hold', app.application_number), html: buildMailBody('on_hold', { appNumber: app.application_number, title: app.title, applicantName: app.applicant_name, comment, appUrl }) })
    }
  }

  return c.redirect(`/applications/${id}`)
})

// 保留回答
applications.post('/:id/answer/:stepId', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const { id, stepId } = c.req.param()
  const body = await c.req.parseBody() as any

  await db.prepare(
    'UPDATE circulation_steps SET hold_answer = ?, status = "pending", acted_at = datetime("now") WHERE id = ?'
  ).bind(body.answer, stepId).run()
  await db.prepare('UPDATE applications SET status = "circulating", updated_at = datetime("now") WHERE id = ?').bind(id).run()

  const step = await db.prepare(
    'SELECT cs.*, u.email FROM circulation_steps cs JOIN users u ON cs.reviewer_id = u.id WHERE cs.id = ?'
  ).bind(stepId).first() as any
  const app = await db.prepare('SELECT * FROM applications WHERE id = ?').bind(id).first() as any
  const smtp = await db.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any

  if (step && app && smtp) {
    const appUrl = `${new URL(c.req.url).origin}/applications/${id}`
    await sendMail(smtp, { to: (step as any).email, subject: buildMailSubject('answered', (app as any).application_number), html: buildMailBody('answered', { appNumber: (app as any).application_number, title: (app as any).title, applicantName: user.name, comment: body.answer, appUrl }) })
  }

  return c.redirect(`/applications/${id}`)
})

// 再提出
applications.post('/:id/resubmit', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const id = c.req.param('id')

  const orig = await db.prepare('SELECT * FROM applications WHERE id = ? AND applicant_id = ? AND status = "rejected"').bind(id, user.uid).first() as any
  if (!orig) return c.redirect(`/applications/${id}`)

  const newNumber = generateApplicationNumber()
  const result = await db.prepare(`
    INSERT INTO applications (
      application_number, title, mansion_id, applicant_id, circulation_start_date,
      payment_target, account_item, td_type, kumiai_amount, budget_amount,
      commission_rate, remarks, status, current_step, resubmit_count, original_application_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'circulating', 1, ?, ?)
  `).bind(
    newNumber, orig.title, orig.mansion_id, orig.applicant_id, orig.circulation_start_date,
    orig.payment_target, orig.account_item, orig.td_type, orig.kumiai_amount, orig.budget_amount,
    orig.commission_rate, orig.remarks, (orig.resubmit_count || 0) + 1, orig.id
  ).run()

  const newId = result.meta.last_row_id

  // 添付ファイルもコピー
  const attachments = await db.prepare('SELECT * FROM attachments WHERE application_id = ?').bind(id).all()
  for (const att of attachments.results as any[]) {
    await db.prepare('INSERT INTO attachments (application_id, file_type, file_name, file_key) VALUES (?, ?, ?, ?)').bind(newId, att.file_type, att.file_name, att.file_key).run()
  }

  await createCirculationSteps(db, newId as number, user.uid, orig.payment_target, orig.mansion_id)

  return c.redirect(`/applications/${newId}`)
})

// ファイルダウンロード
applications.get('/files/:attachId', async (c) => {
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

export default applications
