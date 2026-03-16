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

// 承認者プレビューAPI
applications.get('/preview-reviewers', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.json({ error: 'unauthorized' }, 401)

  const db = c.env.DB
  const mansionId = c.req.query('mansion_id') ? parseInt(c.req.query('mansion_id')!) : null
  const paymentTarget = c.req.query('payment_target') || ''

  const reviewers: { step: number; label: string; name: string; role: string }[] = []

  // Step1: 申請者の直属上長
  const supervisor = await db.prepare(
    'SELECT u2.id, u2.name, u2.role FROM users u1 JOIN users u2 ON u1.supervisor_id = u2.id WHERE u1.id = ?'
  ).bind(user.uid).first() as any
  if (supervisor) {
    reviewers.push({ step: 1, label: '上長', name: supervisor.name, role: supervisor.role })
  } else {
    reviewers.push({ step: 1, label: '上長', name: '未設定', role: '' })
  }

  // Step2: 業務管理課（担当1名）
  const opStaff = await db.prepare(
    'SELECT u.id, u.name, u.role FROM operations_staff os JOIN users u ON os.user_id = u.id WHERE os.is_primary = 1 LIMIT 1'
  ).first() as any
  if (opStaff) {
    reviewers.push({ step: 2, label: '業務管理課', name: opStaff.name, role: opStaff.role })
  } else {
    reviewers.push({ step: 2, label: '業務管理課', name: '未設定', role: '' })
  }

  // Step3: 支払先による分岐
  if (paymentTarget === 'kumiai' && mansionId) {
    const mansion = await db.prepare(
      'SELECT u.id, u.name, u.role FROM mansions m JOIN users u ON m.accounting_user_id = u.id WHERE m.id = ?'
    ).bind(mansionId).first() as any
    if (mansion) {
      reviewers.push({ step: 3, label: '会計担当（マンション）', name: mansion.name, role: mansion.role })
    } else {
      reviewers.push({ step: 3, label: '会計担当（マンション）', name: '未設定', role: '' })
    }
  } else if (paymentTarget === 'td') {
    const honsha = await db.prepare(
      'SELECT u.id, u.name, u.role FROM honsha_staff hs JOIN users u ON hs.user_id = u.id LIMIT 1'
    ).first() as any
    if (honsha) {
      reviewers.push({ step: 3, label: '本社経理', name: honsha.name, role: honsha.role })
    } else {
      reviewers.push({ step: 3, label: '本社経理', name: '未設定', role: '' })
    }
  }

  return c.json({ reviewers })
})

// 新規申請フォーム
applications.get('/new', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const mansions = await db.prepare(
    'SELECT * FROM mansions WHERE is_active = 1 ORDER BY CAST(mansion_number AS INTEGER)'
  ).all()

  // 回覧先候補取得
  // 上長候補：担当者/上司（front_supervisor）ロールのアクティブユーザー
  const supervisorCandidates = await db.prepare(
    "SELECT id, name FROM users WHERE role = 'front_supervisor' AND is_active = 1 ORDER BY name"
  ).all()

  // 業務管理課：operations ロールのアクティブユーザー（プルダウン）
  const opStaffCandidates = await db.prepare(
    "SELECT id, name FROM users WHERE role = 'operations' AND is_active = 1 ORDER BY name"
  ).all()

  // 会計課ユーザー
  const accountingUsers = await db.prepare(
    "SELECT id, name FROM users WHERE role = 'accounting' AND is_active = 1 ORDER BY name"
  ).all()

  // 本社経理ユーザー
  const honshaUsers = await db.prepare(
    "SELECT id, name FROM users WHERE role = 'honsha' AND is_active = 1 ORDER BY name"
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

      <form method="POST" action="/applications" enctype="multipart/form-data" id="appForm" onsubmit="return checkFeeRequired()">
        <div class="space-y-5">
          <!-- 標題（マンション番号入力→名称表示） -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">標題（マンション） <span class="text-red-500">*</span></label>
            <div class="flex gap-2 items-start">
              <!-- 番号入力 -->
              <div class="w-28">
                <input type="number" id="mansionNumberInput" placeholder="番号" min="1"
                  class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none text-center"
                  oninput="searchMansion(this.value)">
                <p class="text-xs text-gray-400 mt-1 text-center">番号を入力</p>
              </div>
              <!-- 検索結果表示 -->
              <div class="flex-1">
                <div id="mansionResult" class="px-3 py-2.5 border border-dashed border-gray-300 rounded-lg text-sm text-gray-400 bg-gray-50 min-h-[42px] flex items-center">
                  番号を入力するとマンション名が表示されます
                </div>
                <div id="mansionNotFound" class="hidden px-3 py-2 text-sm text-red-500 mt-1">⚠ 該当するマンションが見つかりません</div>
              </div>
            </div>
            <!-- hidden inputs -->
            <input type="hidden" name="mansion_id" id="mansionIdInput" required>
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

          <!-- 回覧・承認先 -->
          <div class="border border-purple-200 bg-purple-50 rounded-lg p-4 space-y-4">
            <div class="flex items-center gap-2 mb-1">
              <svg class="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0"/>
              </svg>
              <span class="text-sm font-semibold text-purple-700">回覧・承認先</span>
            </div>

            <!-- Step1: 上長 -->
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1.5">
                <span class="inline-flex items-center justify-center w-5 h-5 bg-blue-100 text-blue-700 rounded-full text-xs font-bold mr-1">1</span>
                回覧・承認先（上長） <span class="text-red-500">*</span>
              </label>
              <select name="reviewer_step1" required
                class="w-full px-3 py-2.5 border border-gray-300 bg-white rounded-lg text-sm focus:ring-2 focus:ring-purple-500 outline-none">
                <option value="">選択してください</option>
                ${(supervisorCandidates.results as any[]).map((u: any) =>
                  `<option value="${u.id}">${u.name}</option>`
                ).join('')}
              </select>
            </div>

            <!-- Step2: 業務管理課 -->
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1.5">
                <span class="inline-flex items-center justify-center w-5 h-5 bg-orange-100 text-orange-700 rounded-full text-xs font-bold mr-1">2</span>
                回覧・承認先（業務管理課） <span class="text-red-500">*</span>
              </label>
              <select name="reviewer_step2" required
                class="w-full px-3 py-2.5 border border-gray-300 bg-white rounded-lg text-sm focus:ring-2 focus:ring-purple-500 outline-none">
                <option value="">選択してください</option>
                ${(opStaffCandidates.results as any[]).map((u: any) =>
                  `<option value="${u.id}">${u.name}</option>`
                ).join('')}
              </select>
            </div>

            <!-- Step3: 最終承認 -->
            <div class="space-y-3">
              <label class="block text-sm font-medium text-gray-700">
                <span class="inline-flex items-center justify-center w-5 h-5 bg-green-100 text-green-700 rounded-full text-xs font-bold mr-1">3</span>
                回覧・承認先（最終） <span class="text-red-500">*</span>
              </label>
              <!-- 役割選択 -->
              <div class="flex gap-4">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="reviewer_step3_role" value="accounting" required
                    onchange="updateStep3Users(); setPaymentTarget('kumiai')"
                    class="w-4 h-4 text-purple-600">
                  <span class="text-sm">マンション会計課</span>
                </label>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="reviewer_step3_role" value="honsha"
                    onchange="updateStep3Users(); setPaymentTarget('td')"
                    class="w-4 h-4 text-purple-600">
                  <span class="text-sm">本社経理</span>
                </label>
              </div>
              <!-- 担当者プルダウン -->
              <select name="reviewer_step3" id="step3UserSelect" required
                class="w-full px-3 py-2.5 border border-gray-300 bg-white rounded-lg text-sm focus:ring-2 focus:ring-purple-500 outline-none">
                <option value="">先に役割を選択してください</option>
              </select>
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
          <div id="amountFields">
            <p class="text-xs text-gray-500 mb-2">手数料（円）または手数料（％）のどちらか一方を必ず入力してください <span class="text-red-500">*</span></p>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-1.5">手数料（円）</label>
                <div class="relative">
                  <input type="number" id="budgetAmountInput" name="budget_amount" min="0"
                    class="w-full px-3 py-2.5 pr-8 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="0" oninput="validateFeeFields()">
                  <span class="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">円</span>
                </div>
              </div>
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-1.5">手数料（％）</label>
                <div class="relative">
                  <input type="number" id="commissionRateInput" name="commission_rate" min="0" max="100" step="0.1"
                    class="w-full px-3 py-2.5 pr-8 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="0" oninput="validateFeeFields()">
                  <span class="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
                </div>
              </div>
            </div>
            <p id="feeValidationMsg" class="hidden text-xs text-red-500 mt-1.5">⚠ 手数料（円）または手数料（％）のいずれかを入力してください</p>
          </div>

          <!-- 添付ファイル（請求書） -->
          <div class="border border-gray-200 rounded-lg p-4 space-y-3">
            <h3 class="text-sm font-semibold text-gray-700">添付ファイル（請求書）</h3>
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
          </div>

          <!-- 送信先（承認者）プレビュー -->
          <div id="reviewerPreview" class="hidden border border-indigo-200 bg-indigo-50 rounded-lg p-4">
            <div class="flex items-center gap-2 mb-3">
              <svg class="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
              </svg>
              <span class="text-sm font-semibold text-indigo-700">送信先（承認順）</span>
            </div>
            <div id="reviewerList" class="space-y-2"></div>
          </div>

          <!-- 備考 -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">備考</label>
            <textarea name="remarks" rows="3"
              class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none"
              placeholder="備考があれば入力してください"></textarea>
          </div>

          <!-- 添付資料（その他） -->
          <div class="border border-gray-200 rounded-lg p-4 space-y-3">
            <h3 class="text-sm font-semibold text-gray-700">添付資料</h3>
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
      // マンションデータをJSに埋め込み
      const MANSIONS = ${JSON.stringify(
        (mansions.results as any[]).map((m: any) => ({
          id: m.id,
          number: m.mansion_number,
          name: m.name
        }))
      )};

      // 会計課・本社経理ユーザーをJSに埋め込み
      const ACCOUNTING_USERS = ${JSON.stringify(
        (accountingUsers.results as any[]).map((u: any) => ({ id: u.id, name: u.name }))
      )};
      const HONSHA_USERS = ${JSON.stringify(
        (honshaUsers.results as any[]).map((u: any) => ({ id: u.id, name: u.name }))
      )};

      function updateStep3Users() {
        const role = document.querySelector('input[name="reviewer_step3_role"]:checked')?.value
        const sel = document.getElementById('step3UserSelect')
        const users = role === 'accounting' ? ACCOUNTING_USERS : role === 'honsha' ? HONSHA_USERS : []
        sel.innerHTML = users.length === 0
          ? '<option value="">先に役割を選択してください</option>'
          : '<option value="">担当者を選択してください</option>' +
            users.map(u => '<option value="' + u.id + '">' + u.name + '</option>').join('')
      }

      function setPaymentTarget(val) {
        // 支払先ラジオを自動選択
        const radio = document.querySelector('input[name="payment_target"][value="' + val + '"]')
        if (radio) { radio.checked = true; togglePaymentFields() }
      }

      function searchMansion(val) {
        const num = parseInt(val);
        const resultEl = document.getElementById('mansionResult');
        const notFoundEl = document.getElementById('mansionNotFound');
        const idInput = document.getElementById('mansionIdInput');
        const titleInput = document.getElementById('titleInput');

        if (!val || isNaN(num)) {
          resultEl.textContent = '番号を入力するとマンション名が表示されます';
          resultEl.className = 'px-3 py-2.5 border border-dashed border-gray-300 rounded-lg text-sm text-gray-400 bg-gray-50 min-h-[42px] flex items-center';
          notFoundEl.classList.add('hidden');
          idInput.value = '';
          titleInput.value = '';
          return;
        }

        const found = MANSIONS.find(m => m.number === num);
        if (found) {
          resultEl.innerHTML = '<span class="text-blue-700 font-bold text-base mr-2">' + found.number + '</span><span class="font-semibold text-gray-800">' + found.name + '</span>';
          resultEl.className = 'px-3 py-2.5 border-2 border-blue-400 rounded-lg text-sm bg-blue-50 min-h-[42px] flex items-center gap-1';
          notFoundEl.classList.add('hidden');
          idInput.value = found.id;
          titleInput.value = found.name;
          updateReviewerPreview();
        } else {
          resultEl.textContent = '番号を入力するとマンション名が表示されます';
          resultEl.className = 'px-3 py-2.5 border border-dashed border-gray-300 rounded-lg text-sm text-gray-400 bg-gray-50 min-h-[42px] flex items-center';
          notFoundEl.classList.remove('hidden');
          idInput.value = '';
          titleInput.value = '';
          updateReviewerPreview();
        }
      }

      function togglePaymentFields() {
        const val = document.querySelector('input[name="payment_target"]:checked')?.value
        document.getElementById('kumiaiFields').classList.toggle('hidden', val !== 'kumiai')
        document.getElementById('tdFields').classList.toggle('hidden', val !== 'td')
        if (val !== 'td') document.getElementById('motoukeFields').classList.add('hidden')
        // 会社（TD）選択時は手数料を非表示
        document.getElementById('amountFields').classList.toggle('hidden', val === 'td')
        // TD選択時はrequiredを解除、それ以外は必須に
        const budgetInput = document.querySelector('input[name="budget_amount"]')
        if (budgetInput) budgetInput.required = (val !== 'td')
        updateReviewerPreview()
      }
      function toggleMotouke() {
        const val = document.querySelector('input[name="td_type"]:checked')?.value
        document.getElementById('motoukeFields').classList.toggle('hidden', val !== 'motouke')
      }

      function validateFeeFields() {
        const amountFields = document.getElementById('amountFields')
        if (amountFields.classList.contains('hidden')) return
        const budget = document.getElementById('budgetAmountInput')?.value
        const commission = document.getElementById('commissionRateInput')?.value
        const msg = document.getElementById('feeValidationMsg')
        const hasValue = (budget !== '' && budget !== null) || (commission !== '' && commission !== null)
        const budgetEl = document.getElementById('budgetAmountInput')
        const commissionEl = document.getElementById('commissionRateInput')
        if (!hasValue) {
          msg.classList.remove('hidden')
          budgetEl.classList.add('border-red-400')
          commissionEl.classList.add('border-red-400')
        } else {
          msg.classList.add('hidden')
          budgetEl.classList.remove('border-red-400')
          commissionEl.classList.remove('border-red-400')
        }
      }

      function checkFeeRequired() {
        const amountFields = document.getElementById('amountFields')
        if (amountFields.classList.contains('hidden')) return true
        const budget = document.getElementById('budgetAmountInput')?.value
        const commission = document.getElementById('commissionRateInput')?.value
        const hasValue = (budget !== '' && budget !== null) || (commission !== '' && commission !== null)
        if (!hasValue) {
          validateFeeFields()
          document.getElementById('budgetAmountInput').focus()
          return false
        }
        return true
      }

      async function updateReviewerPreview() {
        const mansionId = document.getElementById('mansionIdInput').value
        const paymentTarget = document.querySelector('input[name="payment_target"]:checked')?.value
        const previewEl = document.getElementById('reviewerPreview')
        const listEl = document.getElementById('reviewerList')

        if (!mansionId || !paymentTarget) {
          previewEl.classList.add('hidden')
          return
        }

        try {
          const res = await fetch('/applications/preview-reviewers?mansion_id=' + mansionId + '&payment_target=' + paymentTarget)
          const data = await res.json()
          if (!data.reviewers) return

          listEl.innerHTML = data.reviewers.map((r, i) => {
            const isUnset = r.name === '未設定'
            const stepColors = ['bg-blue-100 text-blue-700', 'bg-orange-100 text-orange-700', 'bg-green-100 text-green-700']
            const color = stepColors[i] || 'bg-gray-100 text-gray-600'
            return '<div class="flex items-center gap-3">' +
              '<span class="text-xs font-bold text-indigo-400 w-5 text-center">Step ' + r.step + '</span>' +
              '<svg class="w-3 h-3 text-indigo-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>' +
              '<span class="text-xs px-2 py-0.5 rounded-full font-medium ' + color + '">' + r.label + '</span>' +
              '<span class="text-sm font-medium ' + (isUnset ? 'text-red-400 italic' : 'text-gray-800') + '">' + r.name + '</span>' +
            '</div>'
          }).join('')

          previewEl.classList.remove('hidden')
        } catch (e) {
          previewEl.classList.add('hidden')
        }
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

  // 手数料バリデーション（管理組合の場合、円か％どちらか必須）
  if (body.payment_target !== 'td') {
    const hasBudget = body.budget_amount !== '' && body.budget_amount != null
    const hasCommission = body.commission_rate !== '' && body.commission_rate != null
    if (!hasBudget && !hasCommission) {
      return c.redirect('/applications/new?error=fee_required')
    }
  }

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
    null,
    body.remarks || null
  ).run()

  const appId = result.meta.last_row_id

  // 添付ファイル保存
  for (const [fk, key] of Object.entries(fileKeys)) {
    await db.prepare(
      'INSERT INTO attachments (application_id, file_type, file_name, file_key) VALUES (?, ?, ?, ?)'
    ).bind(appId, fk, fileNames[fk], key).run()
  }

  // 回覧ステップ作成（フォームの選択値を優先）
  const reviewerStep1 = body.reviewer_step1 ? parseInt(body.reviewer_step1) : null
  const reviewerStep2 = body.reviewer_step2 ? parseInt(body.reviewer_step2) : null
  const reviewerStep3 = body.reviewer_step3 ? parseInt(body.reviewer_step3) : null
  await createCirculationSteps(db, appId as number, user.uid, body.payment_target, mansionId, reviewerStep1, reviewerStep2, reviewerStep3)

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
async function createCirculationSteps(
  db: D1Database,
  appId: number,
  applicantId: number,
  paymentTarget: string,
  mansionId: number | null,
  step1UserId: number | null = null,
  step2UserId: number | null = null,
  step3UserId: number | null = null
) {
  // Step1: フォーム指定 → なければ直属上長
  let s1 = step1UserId
  if (!s1) {
    const supervisor = await db.prepare(
      'SELECT supervisor_id FROM users WHERE id = ?'
    ).bind(applicantId).first() as any
    s1 = supervisor?.supervisor_id || null
  }
  if (s1) {
    await db.prepare(
      'INSERT INTO circulation_steps (application_id, step_number, reviewer_id, status) VALUES (?, 1, ?, "pending")'
    ).bind(appId, s1).run()
  }

  // Step2: フォーム指定 → なければ業務管理課primary
  let s2 = step2UserId
  if (!s2) {
    const opStaff = await db.prepare(
      'SELECT user_id FROM operations_staff WHERE is_primary = 1 LIMIT 1'
    ).first() as any
    s2 = opStaff?.user_id || null
  }
  if (s2) {
    await db.prepare(
      'INSERT INTO circulation_steps (application_id, step_number, reviewer_id, status) VALUES (?, 2, ?, "pending")'
    ).bind(appId, s2).run()
  }

  // Step3: フォーム指定 → なければ支払先で自動
  let s3 = step3UserId
  if (!s3) {
    if (paymentTarget === 'kumiai' && mansionId) {
      const mansion = await db.prepare(
        'SELECT accounting_user_id FROM mansions WHERE id = ?'
      ).bind(mansionId).first() as any
      s3 = mansion?.accounting_user_id || null
    } else {
      const honsha = await db.prepare(
        'SELECT user_id FROM honsha_staff LIMIT 1'
      ).first() as any
      s3 = honsha?.user_id || null
    }
  }
  if (s3) {
    await db.prepare(
      'INSERT INTO circulation_steps (application_id, step_number, reviewer_id, status) VALUES (?, 3, ?, "pending")'
    ).bind(appId, s3).run()
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

  // タイムライン用ヘルパー
  const timelineItemClass = (status: string, isCurrent: boolean) => {
    if (status === 'approved') return { dot: 'bg-green-500 border-green-500', card: 'bg-green-50 border-green-200', text: 'text-green-700' }
    if (status === 'rejected') return { dot: 'bg-red-500 border-red-500', card: 'bg-red-50 border-red-200', text: 'text-red-700' }
    if (status === 'on_hold') return { dot: 'bg-yellow-400 border-yellow-400', card: 'bg-yellow-50 border-yellow-200', text: 'text-yellow-700' }
    if (isCurrent) return { dot: 'bg-orange-400 border-orange-400', card: 'bg-orange-50 border-orange-200', text: 'text-orange-700' }
    return { dot: 'bg-gray-300 border-gray-300', card: 'bg-gray-50 border-gray-200', text: 'text-gray-400' }
  }
  const statusLabel: Record<string, string> = {
    approved: '承認済', rejected: '否決', on_hold: '保留中', pending: '待機中'
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
          <div><span class="text-gray-400">手数料（円）</span><p class="font-medium mt-0.5">${Number(app.budget_amount).toLocaleString()}円</p></div>
          ${app.commission_rate != null ? `<div><span class="text-gray-400">手数料（％）</span><p class="font-medium mt-0.5">${app.commission_rate}%</p></div>` : ''}

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

      <!-- 回覧フロー タイムライン -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="font-semibold text-gray-800 mb-5">回覧フロー</h3>
        <div class="relative">
          <!-- 縦線 -->
          <div class="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200"></div>

          <div class="space-y-0">
            <!-- 申請者（回覧開始日） -->
            <div class="relative flex gap-4 pb-6">
              <div class="w-8 h-8 rounded-full bg-blue-500 border-2 border-blue-500 text-white flex items-center justify-center text-xs font-bold z-10 shrink-0">申</div>
              <div class="flex-1 border border-blue-200 bg-blue-50 rounded-lg p-3 ml-1">
                <div class="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <span class="text-sm font-semibold text-gray-800">${app.applicant_name}</span>
                    <span class="ml-2 text-xs text-gray-400">申請者</span>
                  </div>
                  <span class="text-xs font-medium bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">申請</span>
                </div>
                <div class="flex items-center gap-4 mt-1.5 flex-wrap">
                  <span class="text-xs text-gray-500">📅 申請日：${app.created_at?.substring(0,16)}</span>
                  <span class="text-xs text-gray-500">🔄 回覧開始日：${app.circulation_start_date || '-'}</span>
                </div>
              </div>
            </div>

            <!-- 各承認ステップ -->
            ${(steps.results as any[]).map((step: any) => {
              const isCurrent = app.current_step === step.step_number && step.status === 'pending'
              const c2 = timelineItemClass(step.status, isCurrent)
              const iconMap: Record<string, string> = { approved: '✅', rejected: '❌', on_hold: '⏸', pending: isCurrent ? '▶' : '○' }
              const icon = iconMap[step.status] || '○'
              return `
            <div class="relative flex gap-4 pb-6">
              <div class="w-8 h-8 rounded-full ${c2.dot} border-2 text-white flex items-center justify-center text-xs font-bold z-10 shrink-0">${step.step_number}</div>
              <div class="flex-1 border ${c2.card} rounded-lg p-3 ml-1">
                <div class="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <span class="text-sm font-semibold text-gray-800">${step.reviewer_name}</span>
                    <span class="ml-2 text-xs text-gray-400">${stepLabels[step.step_number] || 'レビュー'}</span>
                    ${isCurrent ? '<span class="ml-1 text-xs bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full font-medium">承認待ち</span>' : ''}
                  </div>
                  <span class="text-xs font-medium px-2 py-0.5 rounded-full ${
                    step.status === 'approved' ? 'bg-green-100 text-green-700' :
                    step.status === 'rejected' ? 'bg-red-100 text-red-700' :
                    step.status === 'on_hold'  ? 'bg-yellow-100 text-yellow-700' :
                    isCurrent ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-400'
                  }">${statusLabel[step.status] || '待機中'}</span>
                </div>
                ${step.acted_at ? `
                <div class="mt-1.5">
                  <span class="text-xs text-gray-500">🕐 ${step.status === 'approved' ? '承認日時' : step.status === 'rejected' ? '否決日時' : '対応日時'}：<span class="font-medium text-gray-700">${step.acted_at.substring(0,16)}</span></span>
                </div>` : ''}
                ${step.action_comment ? `<p class="text-xs text-gray-600 mt-2 bg-white rounded p-2 border border-gray-200">${step.status === 'on_hold' ? '❓ ' : '💬 '}${step.action_comment}</p>` : ''}
                ${step.hold_answer ? `<p class="text-xs text-blue-600 mt-1.5 bg-blue-50 rounded p-2 border border-blue-100">📝 回答：${step.hold_answer}</p>` : ''}
              </div>
            </div>`
            }).join('')}
          </div>
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
          <div><span class="text-gray-400">手数料（円）</span><p class="font-medium">${Number(app.budget_amount).toLocaleString()}円</p></div>
          ${app.commission_rate != null ? `<div><span class="text-gray-400">手数料（％）</span><p class="font-medium">${app.commission_rate}%</p></div>` : ''}

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
    null, orig.remarks, (orig.resubmit_count || 0) + 1, orig.id
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
