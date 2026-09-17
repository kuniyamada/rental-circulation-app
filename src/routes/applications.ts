import { Hono } from 'hono'
import { getSessionUser, getSessionIdFromCookie, generateApplicationNumber } from '../lib/auth'
import { layout, statusBadge, paymentLabel } from './layout'
import { buildMailSubject, buildMailBody, sendMail } from '../lib/mail'
import { sendLineWorksMessage, buildLineWorksMessage, rowToConfig, type LineWorksConfigRow } from '../lib/lineworks'

type Bindings = { DB: D1Database; R2: R2Bucket }
const applications = new Hono<{ Bindings: Bindings }>()

// ============================================================
// 統合通知ヘルパー: メール + LINE WORKS を通知設定に応じて送信
// ============================================================
async function sendNotification(
  db: D1Database,
  type: string,
  recipientId: number,
  data: {
    appNumber: string
    title: string
    applicantName: string
    comment?: string
    returnedReason?: string
    reapplyReason?: string
    returnedByName?: string
    returnedFromStep?: number
    appUrl: string
    isTest?: boolean
  }
): Promise<void> {
  // 受信者の通知設定とLINE WORKS IDを取得
  const recipient = await db.prepare(
    'SELECT email, notify_method, lineworks_user_id FROM users WHERE id = ?'
  ).bind(recipientId).first() as { email: string; notify_method: string; lineworks_user_id: string | null } | null

  if (!recipient) return

  const method = recipient.notify_method || 'email'

  // テスト申請の場合は件名にプレフィックス
  const mailPrefix = data.isTest ? '[TEST] ' : ''
  const lwPrefix = data.isTest ? '🧪TEST ' : ''

  // メール送信
  if (method === 'email' || method === 'both') {
    const smtp = await db.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any
    if (smtp && recipient.email) {
      await sendMail(smtp, {
        to: recipient.email,
        subject: mailPrefix + buildMailSubject(type, data.appNumber),
        html: (data.isTest ? '<div style="background:#fef3c7;border:2px solid #f59e0b;padding:10px 16px;margin:0 0 12px;border-radius:6px;color:#92400e;font-weight:bold;">🧪 テスト申請 - 本番運用ではありません</div>' : '') + buildMailBody(type, data),
      })
    }
  }

  // LINE WORKS送信
  if (method === 'lineworks' || method === 'both') {
    const lwConfig = await db.prepare('SELECT * FROM lineworks_config WHERE is_active = 1 LIMIT 1').first() as LineWorksConfigRow | null
    if (lwConfig && recipient.lineworks_user_id) {
      const config = rowToConfig(lwConfig)
      // テスト時は件名にプレフィックス付与するため、appNumberに🧪TESTを先頭付加
      const dataForLW = data.isTest
        ? { ...data, appNumber: lwPrefix + data.appNumber }
        : data
      const message = buildLineWorksMessage(type, dataForLW)
      const lwResult = await sendLineWorksMessage(config, recipient.lineworks_user_id, message,
        // Refresh Token でトークンが更新された場合に DB を更新するコールバック
        async (tokenData) => {
          const expiresAt = Math.floor(Date.now() / 1000) + Number(tokenData.expires_in || 86400)
          await db.prepare(`
            UPDATE lineworks_config
            SET access_token=?, refresh_token=?, token_expires_at=?, updated_at=datetime("now")
            WHERE is_active=1
          `).bind(
            tokenData.access_token,
            tokenData.refresh_token || config.refreshToken || null,
            expiresAt
          ).run()
          console.log('[LW] DBのアクセストークンを更新しました')
        }
      )
      if (lwResult !== true) {
        console.error(`[LW] 通知失敗 type=${type} userId=${recipient.lineworks_user_id}: ${lwResult}`)
      }
    }
  }
}

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

  let sql = `SELECT a.*, m.name as mansion_name, u.name as applicant_name,
      (SELECT COUNT(*) FROM applications a2 WHERE a2.original_application_id = a.id) as successor_count
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

  // 保留中案件が存在するかを確認（存在する場合のみ、絞り込みプルダウンに「保留中」を表示）
  const holdCountRow = await db.prepare("SELECT COUNT(*) as c FROM applications WHERE status = 'on_hold'").first() as any
  const hasHoldApps = (holdCountRow?.c || 0) > 0

  const content = `
    <!-- 検索フォーム -->
    <form method="GET" action="/applications" class="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-6">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
        <input type="text" name="q" value="${q}" placeholder="マンション名・申請番号で検索"
          class="col-span-2 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
        <select name="status" class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
          <option value="">すべての状態</option>
          <option value="circulating" ${status==='circulating'?'selected':''}>回覧中</option>
          <option value="completed" ${status==='completed'?'selected':''}>完了</option>
          <option value="rejected" ${status==='rejected'?'selected':''}>差し戻し</option>
          ${(hasHoldApps || status === 'on_hold') ? `<option value="on_hold" ${status==='on_hold'?'selected':''}>保留中</option>` : ''}
          <option value="draft" ${status==='draft'?'selected':''}>下書き</option>
        </select>
        <button type="submit" class="bg-[#396999] hover:bg-[#2E5580] text-white text-sm font-semibold px-4 py-2 rounded-lg transition">検索</button>
      </div>
      <div class="grid grid-cols-2 gap-3 mt-3">
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-500 whitespace-nowrap">期間（開始）</label>
          <input type="date" name="from" value="${from}" class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
        </div>
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-500 whitespace-nowrap">期間（終了）</label>
          <input type="date" name="to" value="${to}" class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
        </div>
      </div>
    </form>

    <!-- 結果一覧 -->
    <div class="bg-white rounded-xl shadow-sm border border-gray-100">
      <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 class="font-semibold text-gray-800">検索結果 <span class="text-[#396999]">${apps.results.length}件</span></h2>
        ${(['admin','front','front_supervisor'].includes(user.role)) ? `<a href="/applications/new" class="bg-[#396999] hover:bg-[#2E5580] text-white text-sm font-semibold px-4 py-2 rounded-lg transition">＋ 新規申請</a>` : ''}
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
              (apps.results as any[]).map(app => {
                const motoukeAbadge = (app.payment_target === 'td' && app.td_type === 'motouke') ? '<span class="ml-1 bg-amber-100 text-amber-700 text-xs px-1.5 rounded" title="元請セット申請A">🔗A</span>' : ''
                const motoukeBbadge = app.original_application_id ? '<span class="ml-1 bg-emerald-100 text-emerald-700 text-xs px-1.5 rounded" title="元請セット申請B（後続）">🔗B</span>' : ''
                const resubmitBadge = app.resubmit_count > 0 ? `<span class="ml-1 bg-purple-100 text-purple-600 text-xs px-1.5 rounded">再提出</span>` : ''
                const testBadge = app.is_test ? '<span class="ml-1 bg-yellow-100 text-yellow-700 text-xs px-1.5 rounded font-semibold" title="テスト申請">🧪TEST</span>' : ''
                // ★案D: 申請者本人＆差し戻し/否決＆後続未作成の場合、「編集して再申請」への直リンクを表示
                // 後続が既に作成されている場合はボタン非表示（背景も通常色に）
                const hasSuccessor = (app.successor_count || 0) > 0
                const isMyReturned = app.status === 'returned' && app.applicant_id === user.uid && !hasSuccessor
                const isMyRejected = app.status === 'rejected' && app.applicant_id === user.uid && !hasSuccessor
                const rowClass = app.is_test ? 'hover:bg-yellow-50 bg-yellow-50/40'
                  : isMyReturned ? 'hover:bg-orange-100 bg-orange-50/60'
                  : isMyRejected ? 'hover:bg-red-100 bg-red-50/60'
                  : 'hover:bg-gray-50'
                const resubmitLink = isMyReturned
                  ? `<a href="/applications/new?resubmit_id=${app.id}" class="inline-flex items-center gap-1 bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold px-2 py-1 rounded transition whitespace-nowrap" title="編集して再申請">✏ 再申請</a>`
                  : isMyRejected
                  ? `<a href="/applications/new?resubmit_id=${app.id}" class="inline-flex items-center gap-1 bg-red-500 hover:bg-red-600 text-white text-xs font-semibold px-2 py-1 rounded transition whitespace-nowrap" title="編集して再提出">✏ 再提出</a>`
                  : hasSuccessor && app.applicant_id === user.uid && (app.status === 'returned' || app.status === 'rejected')
                  ? `<span class="inline-flex items-center gap-1 bg-gray-100 text-gray-500 text-xs font-semibold px-2 py-1 rounded whitespace-nowrap" title="この申請は既に再申請済です">✅ 再申請済</span>`
                  : ''
                return `
                <tr class="${rowClass}">
                  <td class="px-4 py-3 text-gray-500 text-xs">${app.application_number}${testBadge}${resubmitBadge}${motoukeAbadge}${motoukeBbadge}</td>
                  <td class="px-4 py-3 font-medium text-gray-800">${app.mansion_name || app.title}</td>
                  <td class="px-4 py-3 text-gray-600">${app.applicant_name}</td>
                  <td class="px-4 py-3">${app.payment_target === 'kumiai' ? '<span class="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full">管理組合</span>' : '<span class="bg-[#D5E5F2] text-[#2E5580] text-xs px-2 py-0.5 rounded-full">会社(TD)</span>'}</td>
                  <td class="px-4 py-3 text-gray-700">${Number(app.budget_amount).toLocaleString()}円</td>
                  <td class="px-4 py-3">${statusBadge(app.status)}</td>
                  <td class="px-4 py-3 text-gray-400 text-xs">${app.created_at?.substring(0,10)}</td>
                  <td class="px-4 py-3">
                    <div class="flex items-center gap-2 justify-end">
                      ${resubmitLink}
                      <a href="/applications/${app.id}" class="text-[#396999] hover:underline text-xs whitespace-nowrap">詳細</a>
                    </div>
                  </td>
                </tr>
                `
              }).join('')
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

// 新規申請を許可するロール（管理者・担当者・担当者/上司）
const ALLOWED_NEW_APP_ROLES = ['admin', 'front', 'front_supervisor']

// 新規申請フォーム
applications.get('/new', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB

  // === 差し戻し再申請の引き継ぎ ===
  // resubmit_id が指定されている場合、元申請の申請者本人（または管理者）のみ許可
  // returned または rejected の状態のもののみ再申請可能
  const resubmitId = c.req.query('resubmit_id') ? parseInt(c.req.query('resubmit_id')!) : null
  let resubmitSource: any = null
  let resubmitAttachments: any[] = []
  if (resubmitId) {
    resubmitSource = await db.prepare(`
      SELECT a.*, m.name as mansion_name, m.mansion_number
      FROM applications a LEFT JOIN mansions m ON a.mansion_id = m.id
      WHERE a.id = ? AND (a.status = 'returned' OR a.status = 'rejected')
    `).bind(resubmitId).first() as any
    if (!resubmitSource) {
      return c.html(`<p style="padding:2rem;font-family:sans-serif;color:#dc2626">⛔ 指定された申請は再申請できません（差し戻し・否決状態の申請のみ対象です）。</p>`, 404)
    }
    if (resubmitSource.applicant_id !== user.uid && !user.is_admin) {
      return c.html(`<p style="padding:2rem;font-family:sans-serif;color:#dc2626">⛔ 再申請の権限がありません（申請者本人のみ再申請できます）。</p>`, 403)
    }
    // 元申請の添付ファイル一覧
    const attRes = await db.prepare(
      'SELECT * FROM attachments WHERE application_id = ? ORDER BY id'
    ).bind(resubmitId).all()
    resubmitAttachments = (attRes.results || []) as any[]
    // 元申請の回覧ステップ（Step1-3 のreviewer_id）
    const stepsRes = await db.prepare(
      'SELECT step_number, reviewer_id FROM circulation_steps WHERE application_id = ? ORDER BY step_number'
    ).bind(resubmitId).all()
    resubmitSource._steps = (stepsRes.results || []) as any[]
  }

  // 新規申請の権限チェックは、差し戻し再申請の場合はスキップ（申請者本人であればOK）
  if (!resubmitSource && !user.is_admin && !ALLOWED_NEW_APP_ROLES.includes(user.role)) {
    return c.html(`<p style="padding:2rem;font-family:sans-serif;color:#dc2626">⛔ この画面へのアクセス権限がありません。</p>`, 403)
  }

  const mansions = await db.prepare(
    'SELECT * FROM mansions WHERE is_active = 1 ORDER BY CAST(mansion_number AS INTEGER)'
  ).all()

  // inboxからの引き継ぎデータ取得
  const inboxId = c.req.query('inbox_id') ? parseInt(c.req.query('inbox_id')!) : null
  let inboxData: any = null
  if (inboxId) {
    inboxData = await db.prepare(`
      SELECT ii.*, m.name as mansion_name, m.mansion_number, f.name as front_name
      FROM invoice_inbox ii
      LEFT JOIN mansions m ON ii.mansion_id = m.id
      LEFT JOIN users f ON ii.front_user_id = f.id
      WHERE ii.id = ? AND ii.status = 'pending'
    `).bind(inboxId).first()
  }

  // === 元請セット申請Bの引き継ぎ ===
  const fromMotoukeId = c.req.query('from_motouke') ? parseInt(c.req.query('from_motouke')!) : null
  let motoukeSource: any = null
  let motoukeKumiaiAtt: any = null
  if (fromMotoukeId) {
    motoukeSource = await db.prepare(`
      SELECT a.*, m.name as mansion_name, m.mansion_number
      FROM applications a
      LEFT JOIN mansions m ON a.mansion_id = m.id
      WHERE a.id = ? AND a.payment_target = 'td' AND a.td_type = 'motouke'
    `).bind(fromMotoukeId).first() as any
    if (motoukeSource) {
      // 申請作成者本人か管理者のみアクセス可
      if (motoukeSource.applicant_id !== user.uid && !user.is_admin) {
        return c.html(`<p style="padding:2rem;font-family:sans-serif;color:#dc2626">⛔ この元請セット申請の作成権限がありません（元申請の申請者本人のみ作成できます）。</p>`, 403)
      }
      // 既に申請Bが作成されていたらそちらへリダイレクト
      const existingB = await db.prepare(
        'SELECT id FROM applications WHERE original_application_id = ? LIMIT 1'
      ).bind(fromMotoukeId).first() as any
      if (existingB) {
        return c.redirect(`/applications/${existingB.id}?motouke_dup=1`)
      }
      // 管理組合宛請求書PDFを取得
      motoukeKumiaiAtt = await db.prepare(
        'SELECT * FROM attachments WHERE application_id = ? AND file_type = ? ORDER BY id DESC LIMIT 1'
      ).bind(fromMotoukeId, 'kumiai_invoice').first() as any
      if (!motoukeKumiaiAtt) {
        return c.html(`<p style="padding:2rem;font-family:sans-serif;color:#dc2626">⛔ 元申請にまだ管理組合宛請求書PDFがアップロードされていません。本橋さんのアップロード完了をお待ちください。</p>`, 400)
      }
    }
  }

  // === テストモード判定（管理者のみ・自分の申請にのみ適用） ===
  const isTestMode = user.is_admin && user.test_mode === 1

  // 回覧先候補取得
  // テストモード時は全アクティブユーザーを候補に、通常時は役割で絞る
  const supervisorCandidates = isTestMode
    ? await db.prepare("SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name").all()
    : await db.prepare("SELECT id, name FROM users WHERE role = 'front_supervisor' AND is_active = 1 ORDER BY name").all()

  const opStaffCandidates = isTestMode
    ? await db.prepare("SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name").all()
    : await db.prepare("SELECT id, name FROM users WHERE role = 'operations' AND is_active = 1 ORDER BY name").all()

  // 業務管理課デフォルト：本橋 美由紀（employee_number=030）
  const defaultStep2User = await db.prepare(
    "SELECT id FROM users WHERE employee_number = '030' AND is_active = 1 LIMIT 1"
  ).first() as any

  // 会計課ユーザー
  const accountingUsers = isTestMode
    ? await db.prepare("SELECT id, name FROM users WHERE is_active = 1 ORDER BY name").all()
    : await db.prepare("SELECT id, name FROM users WHERE role = 'accounting' AND is_active = 1 ORDER BY name").all()

  // 本社経理ユーザー
  const honshaUsers = isTestMode
    ? await db.prepare("SELECT id, name FROM users WHERE is_active = 1 ORDER BY name").all()
    : await db.prepare("SELECT id, name FROM users WHERE role = 'honsha' AND is_active = 1 ORDER BY name").all()

  // 本社経理デフォルト：山崎 修（employee_number=049）
  const defaultHonshaUser = await db.prepare(
    "SELECT id FROM users WHERE employee_number = '049' AND is_active = 1 LIMIT 1"
  ).first() as any

  const today = new Date().toISOString().substring(0, 10)

  const content = `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6 max-w-3xl">
      <!-- ステップ表示 -->
      <div class="flex items-center gap-2 mb-8">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 bg-[#396999] text-white rounded-full flex items-center justify-center text-sm font-bold">1</div>
          <span class="text-sm font-semibold text-[#396999]">内容の入力</span>
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

      <form method="POST" action="${resubmitSource ? `/applications/${resubmitSource.id}/resubmit` : '/applications'}" enctype="multipart/form-data" id="appForm" onsubmit="return checkFeeRequired()">
        ${resubmitSource ? `
        <!-- 差し戻し再申請バナー -->
        <div class="mb-5 bg-orange-50 border-2 border-orange-300 rounded-lg p-4">
          <div class="flex items-start gap-3">
            <span class="text-2xl">↩</span>
            <div class="flex-1">
              <p class="text-sm font-bold text-orange-900">
                ${resubmitSource.status === 'returned' ? '差し戻し再申請' : '否決後の再申請'}
                <span class="ml-2 text-xs font-normal text-orange-700">元申請: <a href="/applications/${resubmitSource.id}" class="underline font-mono">${resubmitSource.application_number}</a></span>
              </p>
              ${resubmitSource.returned_reason ? `
              <div class="mt-2 bg-white border border-orange-200 rounded-lg p-3">
                <p class="text-xs font-semibold text-orange-600 mb-1">差し戻し理由</p>
                <p class="text-sm text-gray-800 whitespace-pre-wrap">${resubmitSource.returned_reason}</p>
              </div>
              ` : ''}
              <p class="text-xs text-orange-700 mt-2">
                ✓ 元申請の内容を引き継いでいます。必要な項目を修正してください。<br>
                ✓ 添付ファイルは元申請から自動引き継ぎされます（新しいファイルを選択した場合のみ上書きされます）。
              </p>
            </div>
          </div>
        </div>
        <input type="hidden" name="resubmit_id" value="${resubmitSource.id}">
        <!-- 再申請理由・修正内容 -->
        <div class="mb-5">
          <label class="block text-sm font-semibold text-orange-700 mb-1.5">再申請理由・修正内容 <span class="text-red-500">*</span></label>
          <textarea name="reapply_reason" required rows="3"
            class="w-full px-3 py-2.5 border border-orange-300 rounded-lg text-sm focus:ring-2 focus:ring-orange-400 outline-none resize-none"
            placeholder="差し戻し理由に対してどのように修正・対応したかを記入してください"></textarea>
        </div>
        ` : ''}
        ${isTestMode && !resubmitSource ? `
        <!-- テストモード稼働中バナー -->
        <div class="mb-5 bg-yellow-50 border-2 border-yellow-300 rounded-lg p-4">
          <div class="flex items-start gap-3">
            <span class="text-2xl">🧪</span>
            <div class="flex-1">
              <p class="text-sm font-bold text-yellow-900">テストモード稼働中</p>
              <ul class="text-xs text-yellow-800 mt-1.5 space-y-0.5 list-disc list-inside">
                <li>回覧・承認先を<strong>全ユーザーから自由に選択</strong>できます（役割制限なし）</li>
                <li>この申請は <span class="inline-block bg-yellow-200 text-yellow-900 text-xs font-semibold px-1.5 py-0.5 rounded">🧪TEST</span> バッジ付きで作成されます</li>
                <li>通知メール件名に <code class="bg-yellow-100 px-1 rounded">[TEST]</code>、LINE WORKSに <code class="bg-yellow-100 px-1 rounded">🧪TEST</code> が付きます</li>
              </ul>
              <a href="/admin/test-mode" class="text-xs text-yellow-700 hover:underline mt-1 inline-block">→ テストモードを OFF にする</a>
            </div>
          </div>
        </div>
        <input type="hidden" name="_test_mode" value="1">
        ` : ''}
        ${inboxData ? `
        <!-- inboxからの引き継ぎバナー -->
        <div class="mb-5 bg-[#EEF4FA] border border-[#AECBE5] rounded-lg p-4 flex items-start gap-3">
          <span class="text-2xl">📥</span>
          <div class="flex-1">
            <p class="text-sm font-semibold text-[#234166]">業務管理課から請求書が転送されています</p>
            <p class="text-xs text-[#396999] mt-1">マンション・請求書を引き継ぎました。内容を確認のうえ申請してください。</p>
            <div class="flex flex-wrap gap-3 mt-2 text-xs text-[#2E5580]">
              <span>🏢 ${inboxData.mansion_name}</span>
              ${inboxData.attachment_name ? `<span>📎 ${inboxData.attachment_name}</span>` : ''}
              ${inboxData.note ? `<span>💬 ${inboxData.note}</span>` : ''}
            </div>
          </div>
        </div>
        ` : ''}
        ${motoukeSource ? `
        <!-- 元請セット申請Bの引き継ぎバナー -->
        <div class="mb-5 bg-amber-50 border-2 border-amber-300 rounded-lg p-4 flex items-start gap-3">
          <span class="text-2xl">🔗</span>
          <div class="flex-1">
            <p class="text-sm font-bold text-amber-900">元請セット申請B（管理組合宛請求書の回覧）</p>
            <p class="text-xs text-amber-800 mt-1">
              元申請 <a href="/applications/${motoukeSource.id}" class="underline font-mono">${motoukeSource.application_number}</a>
              （業者請求書 / ${motoukeSource.mansion_name}）に紐づく後続申請です。
            </p>
            <div class="flex flex-wrap gap-3 mt-2 text-xs text-amber-900">
              <span>🏢 ${motoukeSource.mansion_name}</span>
              <span>💴 管理組合請求金額: ${motoukeSource.kumiai_amount ? Number(motoukeSource.kumiai_amount).toLocaleString() : '-'}円</span>
              <span>📎 ${motoukeKumiaiAtt.file_name}</span>
            </div>
            <p class="text-xs text-amber-700 mt-2">
              ✓ マンション・支払先（管理組合）・金額・PDFは元申請から自動引き継ぎ済です<br>
              ✓ 回覧経路は「上長 → 本橋（業務管理課） → マンション会計」の短縮フローになります
            </p>
          </div>
        </div>
        <input type="hidden" name="from_motouke" value="${motoukeSource.id}">
        <input type="hidden" name="motouke_kumiai_att_id" value="${motoukeKumiaiAtt.id}">
        ` : ''}
        <input type="hidden" name="inbox_id" value="${inboxId || ''}">
        <div class="space-y-5">
          <!-- 標題（マンション番号入力→名称表示） -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">標題（マンション） <span class="text-red-500">*</span></label>
            <div class="flex gap-2 items-start">
              <!-- 番号入力 -->
              <div class="w-28">
                <input type="number" id="mansionNumberInput" placeholder="番号" min="1"
                  class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none text-center"
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
              <input type="date" name="circulation_start_date" value="${resubmitSource ? today : today}" required
                class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            </div>
          </div>

          <!-- 添付ファイル（請求書）① ※必須 -->
          <div class="border border-gray-200 rounded-lg p-4">
            <h3 class="text-sm font-semibold text-gray-700 mb-3">添付ファイル（請求書）</h3>
            <div>
              <label class="block text-xs text-gray-500 mb-1">添付資料（請求書）① <span class="text-red-500">*</span></label>
              ${(() => {
                const resubmitInv1 = resubmitAttachments.find(a => a.file_type === 'invoice1')
                if (resubmitInv1) {
                  return `
              <div class="mb-2 flex items-center gap-2 px-3 py-2 bg-orange-50 border border-orange-200 rounded-lg">
                <span class="text-orange-700 text-xs">📎 元申請から引き継ぎ：${resubmitInv1.file_name}</span>
                <a href="/applications/files/${resubmitInv1.id}" target="_blank" class="text-xs text-[#396999] underline">確認</a>
                <span class="text-xs text-gray-400 ml-auto">（別ファイルを選択すると上書きされます）</span>
              </div>
              <div class="flex items-center gap-2">
                <input type="file" name="invoice1" accept=".pdf,.jpg,.jpeg,.png" id="invoice1Input"
                  onchange="handleFilePreview(this, 'invoice1Preview')"
                  class="flex-1 text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-[#EEF4FA] file:text-[#396999] hover:file:bg-[#D5E5F2]">
                <button type="button" id="invoice1Preview" onclick="openFilePreview('invoice1Input')"
                  class="hidden items-center gap-1 px-3 py-1.5 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580]">
                  👁 確認
                </button>
              </div>
                  `
                }
                if (inboxData?.attachment_key) {
                  return `
              <div class="mb-2 flex items-center gap-2 px-3 py-2 bg-[#EEF4FA] border border-[#AECBE5] rounded-lg">
                <span class="text-[#396999] text-xs">📎 引き継ぎ：${inboxData.attachment_name || 'invoice.pdf'}</span>
                <input type="hidden" name="inbox_attachment_key" value="${inboxData.attachment_key}">
                <input type="hidden" name="inbox_attachment_name" value="${inboxData.attachment_name || ''}">
                <span class="text-xs text-gray-400">（別ファイルを選択すると上書きされます）</span>
              </div>
              <div class="flex items-center gap-2">
                <input type="file" name="invoice1" accept=".pdf,.jpg,.jpeg,.png" id="invoice1Input"
                  onchange="handleFilePreview(this, 'invoice1Preview')"
                  class="flex-1 text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-[#EEF4FA] file:text-[#396999] hover:file:bg-[#D5E5F2]">
                <button type="button" id="invoice1Preview" onclick="openFilePreview('invoice1Input')"
                  class="hidden items-center gap-1 px-3 py-1.5 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580]">
                  👁 確認
                </button>
              </div>
                  `
                }
                return `
              <div class="flex items-center gap-2">
                <input type="file" name="invoice1" required accept=".pdf,.jpg,.jpeg,.png" id="invoice1Input"
                  onchange="handleFilePreview(this, 'invoice1Preview')"
                  class="flex-1 text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-[#EEF4FA] file:text-[#396999] hover:file:bg-[#D5E5F2]">
                <button type="button" id="invoice1Preview" onclick="openFilePreview('invoice1Input')"
                  class="hidden items-center gap-1 px-3 py-1.5 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580]">
                  👁 確認
                </button>
              </div>
                `
              })()}
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
                <span class="inline-flex items-center justify-center w-5 h-5 bg-[#D5E5F2] text-[#2E5580] rounded-full text-xs font-bold mr-1">1</span>
                回覧・承認先（上長） <span class="text-red-500">*</span>
                ${isTestMode ? '<span class="ml-2 text-xs text-yellow-700">🧪 全ユーザーから選択可</span>' : ''}
              </label>
              <select name="reviewer_step1" required
                onchange="updateReviewerPreview()"
                class="w-full px-3 py-2.5 border ${isTestMode ? 'border-yellow-300 bg-yellow-50' : 'border-gray-300 bg-white'} rounded-lg text-sm focus:ring-2 focus:ring-purple-500 outline-none">
                <option value="">選択してください</option>
                ${(supervisorCandidates.results as any[]).map((u: any) => {
                  const roleTag = isTestMode && u.role ? ` [${u.role}]` : ''
                  return `<option value="${u.id}">${u.name}${roleTag}</option>`
                }).join('')}
              </select>
            </div>

            <!-- Step2: 業務管理課 -->
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1.5">
                <span class="inline-flex items-center justify-center w-5 h-5 bg-orange-100 text-orange-700 rounded-full text-xs font-bold mr-1">2</span>
                回覧・承認先（業務管理課） <span class="text-red-500">*</span>
                ${isTestMode ? '<span class="ml-2 text-xs text-yellow-700">🧪 全ユーザーから選択可</span>' : ''}
              </label>
              <select name="reviewer_step2" required
                onchange="updateReviewerPreview()"
                class="w-full px-3 py-2.5 border ${isTestMode ? 'border-yellow-300 bg-yellow-50' : 'border-gray-300 bg-white'} rounded-lg text-sm focus:ring-2 focus:ring-purple-500 outline-none">
                <option value="">選択してください</option>
                ${(opStaffCandidates.results as any[]).map((u: any) => {
                  const roleTag = isTestMode && u.role ? ` [${u.role}]` : ''
                  return `<option value="${u.id}"${defaultStep2User && u.id === defaultStep2User.id ? ' selected' : ''}>${u.name}${roleTag}</option>`
                }).join('')}
              </select>
            </div>

            <!-- Step3: 最終承認 -->
            <div class="space-y-3">
              <label class="block text-sm font-medium text-gray-700">
                <span class="inline-flex items-center justify-center w-5 h-5 bg-green-100 text-green-700 rounded-full text-xs font-bold mr-1">3</span>
                回覧・承認先（最終） <span class="text-red-500">*</span>
                ${isTestMode ? '<span class="ml-2 text-xs text-yellow-700">🧪 全ユーザーから選択可</span>' : ''}
              </label>
              <!-- 役割選択 -->
              <div class="flex gap-4">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="reviewer_step3_role" value="accounting" required
                    onchange="updateStep3Users(); setPaymentTarget('kumiai'); updateReviewerPreview()"
                    class="w-4 h-4 text-purple-600">
                  <span class="text-sm">マンション会計課</span>
                </label>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="reviewer_step3_role" value="honsha"
                    onchange="updateStep3Users(); setPaymentTarget('td'); updateReviewerPreview()"
                    class="w-4 h-4 text-purple-600">
                  <span class="text-sm">本社経理</span>
                </label>
              </div>
              <!-- 担当者プルダウン -->
              <select name="reviewer_step3" id="step3UserSelect" required
                onchange="updateReviewerPreview()"
                class="w-full px-3 py-2.5 border ${isTestMode ? 'border-yellow-300 bg-yellow-50' : 'border-gray-300 bg-white'} rounded-lg text-sm focus:ring-2 focus:ring-purple-500 outline-none">
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
                  class="w-4 h-4 text-[#396999]">
                <span class="text-sm">管理組合</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="payment_target" value="td" onchange="togglePaymentFields()"
                  class="w-4 h-4 text-[#396999]">
                <span class="text-sm">会社（TD）</span>
              </label>
            </div>
          </div>

          <!-- 管理組合の場合：勘定科目 -->
          <div id="kumiaiFields" class="hidden bg-green-50 border border-green-200 rounded-lg p-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">勘定科目 <span class="text-red-500">*</span></label>
            <select name="account_item"
              class="w-full px-3 py-2.5 border border-gray-300 bg-white rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
              <option value="">選択してください</option>
              <option value="予備費">予備費</option>
              <option value="小修繕費">小修繕費</option>
              <option value="修繕費">修繕費</option>
              <option value="保険修繕費">保険修繕費</option>
              <option value="その他">その他</option>
            </select>
          </div>

          <!-- TD（会社）の場合 -->
          <div id="tdFields" class="hidden bg-[#EEF4FA] border border-[#AECBE5] rounded-lg p-4 space-y-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1.5">区分 <span class="text-red-500">*</span></label>
              <div class="flex gap-4">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="td_type" value="ittaku" onchange="toggleMotouke()"
                    class="w-4 h-4 text-[#396999]">
                  <span class="text-sm">委託内</span>
                </label>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="td_type" value="motouke" onchange="toggleMotouke()"
                    class="w-4 h-4 text-[#396999]">
                  <span class="text-sm">元請</span>
                </label>
              </div>
            </div>
            <!-- 元請の場合：管理組合への請求金額 + 業者への支払金額 -->
            <div id="motoukeFields" class="hidden space-y-3">
              <!-- 税込表示の注意書き（元請時のみ表示） -->
              <div class="bg-red-50 border border-red-300 rounded-lg px-3 py-2 flex items-center gap-2">
                <span class="text-lg">⚠️</span>
                <p class="text-sm font-bold text-red-600">管理組合への請求金額は<span class="underline">税込</span>で入力してください</p>
              </div>
              <!-- 金額入力（横並び） -->
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-sm font-semibold text-gray-700 mb-1.5">
                    管理組合への請求金額
                    <span class="text-xs font-bold text-red-600 ml-1">※税込</span>
                  </label>
                  <div class="relative">
                    <input type="text" id="kumiaiAmountDisplay" inputmode="numeric"
                      class="w-full px-3 py-2.5 pr-8 border border-red-300 bg-white rounded-lg text-sm focus:ring-2 focus:ring-red-400 outline-none"
                      placeholder="0" oninput="formatComma(this, 'kumiaiAmount'); calcProfit()">
                    <span class="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">円</span>
                  </div>
                  <input type="hidden" name="kumiai_amount" id="kumiaiAmountHidden">
                </div>
                <div>
                  <label class="block text-sm font-semibold text-gray-700 mb-1.5">業者への支払金額</label>
                  <div class="relative">
                    <input type="text" id="gyoshaAmountDisplay" inputmode="numeric"
                      class="w-full px-3 py-2.5 pr-8 border border-gray-300 bg-white rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none"
                      placeholder="0" oninput="formatComma(this, 'gyoshaAmount'); calcProfit()">
                    <span class="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">円</span>
                  </div>
                  <input type="hidden" name="gyosha_amount" id="gyoshaAmountHidden">
                </div>
              </div>
              <!-- 利益額・利益率（自動計算） -->
              <div id="profitDisplay" class="hidden grid grid-cols-2 gap-3">
                <div class="bg-white border border-gray-200 rounded-lg px-3 py-2.5">
                  <p class="text-xs text-gray-400 mb-0.5">利益額</p>
                  <p id="profitAmount" class="text-sm font-semibold text-gray-800">－</p>
                </div>
                <div class="bg-white border border-gray-200 rounded-lg px-3 py-2.5">
                  <p class="text-xs text-gray-400 mb-0.5">利益率</p>
                  <p id="profitRate" class="text-sm font-semibold text-gray-800">－</p>
                </div>
              </div>
            </div>
          </div>

          <!-- 金額 -->
          <div id="amountFields">
            <p class="text-xs text-gray-500 mb-2">手数料（円）または手数料（％）のどちらか一方を必ず入力してください <span class="text-red-500">*</span></p>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-1.5">手数料（円）</label>
                <div class="relative">
                  <input type="text" id="budgetAmountInput" inputmode="numeric"
                    class="w-full px-3 py-2.5 pr-8 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none"
                    placeholder="0" oninput="formatComma(this, 'budget_amount'); validateFeeFields()">
                  <input type="hidden" name="budget_amount" id="budgetAmountHidden">
                  <span class="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">円</span>
                </div>
              </div>
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-1.5">手数料（％）</label>
                <div class="relative">
                  <input type="number" id="commissionRateInput" name="commission_rate" min="0" max="100" step="0.1"
                    class="w-full px-3 py-2.5 pr-8 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none"
                    placeholder="0" oninput="validateFeeFields()">
                  <span class="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
                </div>
              </div>
            </div>
            <p id="feeValidationMsg" class="hidden text-xs text-red-500 mt-1.5">⚠ 手数料（円）または手数料（％）のいずれかを入力してください</p>
          </div>

          <!-- 添付ファイル（請求書）②〜 -->
          <!-- 「請求書②」欄は常時表示。管理組合=最大3枠(②③④) / 委託内=最大5枠(②〜⑥) の追加ボタンが表示される -->
          <div class="border border-gray-200 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-semibold text-gray-700">添付ファイル（請求書）②〜</h3>
              <span id="invoiceExtraHint" class="hidden text-xs text-gray-400"></span>
            </div>
            <div id="invoiceExtraList" class="space-y-2">
              ${(() => {
                // 再申請の場合: 元申請の invoice2〜invoice6 を初期スロットとして展開
                const marks = ['②', '③', '④', '⑤', '⑥']
                const slots: string[] = []
                for (let i = 2; i <= 6; i++) {
                  const att = resubmitAttachments.find(a => a.file_type === `invoice${i}`)
                  const mark = marks[i - 2]
                  if (att) {
                    slots.push(`
              <div class="space-y-1" data-invoice-slot="${i}">
                <div class="flex items-center gap-2 px-3 py-2 bg-orange-50 border border-orange-200 rounded-lg">
                  <span class="text-orange-700 text-xs">📎 元申請から引き継ぎ：${att.file_name}</span>
                  <a href="/applications/files/${att.id}" target="_blank" class="text-xs text-[#396999] underline">確認</a>
                  <span class="text-xs text-gray-400 ml-auto">（別ファイル選択で上書き）</span>
                </div>
                <div class="flex items-center gap-2">
                  <label class="text-xs text-gray-500 w-16 shrink-0">請求書${mark}</label>
                  <input type="file" name="invoice${i}" accept=".pdf,.jpg,.jpeg,.png" id="invoice${i}Input"
                    onchange="handleFilePreview(this, 'invoice${i}Preview')"
                    class="flex-1 text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-[#EEF4FA] file:text-[#396999] hover:file:bg-[#D5E5F2]">
                  <button type="button" id="invoice${i}Preview" onclick="openFilePreview('invoice${i}Input')"
                    class="hidden items-center gap-1 px-3 py-1.5 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580]">
                    👁 確認
                  </button>
                </div>
              </div>
                    `)
                  }
                }
                if (slots.length > 0) return slots.join('')
                // 通常時 or 再申請でも②以降が無い場合: 空の請求書②枠だけ表示
                return `
              <div class="flex items-center gap-2" data-invoice-slot="2">
                <label class="text-xs text-gray-500 w-16 shrink-0">請求書②</label>
                <input type="file" name="invoice2" accept=".pdf,.jpg,.jpeg,.png" id="invoice2Input"
                  onchange="handleFilePreview(this, 'invoice2Preview')"
                  class="flex-1 text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-[#EEF4FA] file:text-[#396999] hover:file:bg-[#D5E5F2]">
                <button type="button" id="invoice2Preview" onclick="openFilePreview('invoice2Input')"
                  class="hidden items-center gap-1 px-3 py-1.5 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580]">
                  👁 確認
                </button>
              </div>
                `
              })()}
              <!-- 請求書③〜⑥ はJSで動的に追加される -->
            </div>
            <!-- 追加ボタン（管理組合=3枠 / 委託内=5枠まで） -->
            <button type="button" id="addInvoiceBtn" onclick="addInvoiceSlot()"
              class="hidden mt-3 inline-flex items-center gap-1 px-3 py-1.5 border border-dashed border-[#396999] text-[#396999] text-xs font-semibold rounded-md hover:bg-[#EEF4FA]">
              ＋ 請求書を追加
            </button>
          </div>

          <!-- 送信先（承認者）プレビュー -->
          <div id="reviewerPreview" class="border border-indigo-200 bg-indigo-50 rounded-lg p-4">
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
              class="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none resize-none"
              placeholder="備考があれば入力してください">${resubmitSource ? (resubmitSource.remarks || '') : ''}</textarea>
          </div>

          <!-- 添付資料（その他） -->
          <div class="border border-gray-200 rounded-lg p-4 space-y-3">
            <h3 class="text-sm font-semibold text-gray-700">添付資料</h3>
            ${(() => {
              const other1Att = resubmitAttachments.find(a => a.file_type === 'other1')
              const other2Att = resubmitAttachments.find(a => a.file_type === 'other2')
              return `
            <div>
              <label class="block text-xs text-gray-500 mb-1">添付資料①</label>
              ${other1Att ? `
              <div class="mb-2 flex items-center gap-2 px-3 py-2 bg-orange-50 border border-orange-200 rounded-lg">
                <span class="text-orange-700 text-xs">📎 元申請から引き継ぎ：${other1Att.file_name}</span>
                <a href="/applications/files/${other1Att.id}" target="_blank" class="text-xs text-[#396999] underline">確認</a>
                <span class="text-xs text-gray-400 ml-auto">（別ファイル選択で上書き）</span>
              </div>` : ''}
              <div class="flex items-center gap-2">
                <input type="file" name="other1" accept=".pdf,.jpg,.jpeg,.png" id="other1Input"
                  onchange="handleFilePreview(this, 'other1Preview')"
                  class="flex-1 text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-[#EEF4FA] file:text-[#396999] hover:file:bg-[#D5E5F2]">
                <button type="button" id="other1Preview" onclick="openFilePreview('other1Input')"
                  class="hidden items-center gap-1 px-3 py-1.5 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580]">
                  👁 確認
                </button>
              </div>
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">添付資料②</label>
              ${other2Att ? `
              <div class="mb-2 flex items-center gap-2 px-3 py-2 bg-orange-50 border border-orange-200 rounded-lg">
                <span class="text-orange-700 text-xs">📎 元申請から引き継ぎ：${other2Att.file_name}</span>
                <a href="/applications/files/${other2Att.id}" target="_blank" class="text-xs text-[#396999] underline">確認</a>
                <span class="text-xs text-gray-400 ml-auto">（別ファイル選択で上書き）</span>
              </div>` : ''}
              <div class="flex items-center gap-2">
                <input type="file" name="other2" accept=".pdf,.jpg,.jpeg,.png" id="other2Input"
                  onchange="handleFilePreview(this, 'other2Preview')"
                  class="flex-1 text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-[#EEF4FA] file:text-[#396999] hover:file:bg-[#D5E5F2]">
                <button type="button" id="other2Preview" onclick="openFilePreview('other2Input')"
                  class="hidden items-center gap-1 px-3 py-1.5 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580]">
                  👁 確認
                </button>
              </div>
            </div>
              `
            })()}
          </div>
        </div>

        <div class="flex gap-3 mt-8">
          <a href="${resubmitSource ? `/applications/${resubmitSource.id}` : '/'}" class="flex-1 text-center px-4 py-3 border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition text-sm font-semibold">
            キャンセル
          </a>
          <button type="submit" class="flex-2 flex-grow-[2] ${resubmitSource ? 'bg-orange-500 hover:bg-orange-600' : 'bg-[#396999] hover:bg-[#2E5580]'} text-white font-semibold py-3 px-8 rounded-lg transition text-sm"
            ${resubmitSource ? `onclick="return confirm('修正内容で再申請します。よろしいですか？')"` : ''}>
            ${resubmitSource ? '↩ 再申請する' : '次へ：回覧先の確認 →'}
          </button>
        </div>
      </form>
    </div>

    <!-- PDFプレビューモーダル（送信前） -->
    <div id="filePreviewModal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/60">
      <div class="relative bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4" style="height:85vh;">
        <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <span id="filePreviewTitle" class="text-sm font-semibold text-gray-700">ファイルプレビュー</span>
          <button onclick="closeFilePreviewModal()" class="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
        </div>
        <div class="w-full" style="height:calc(100% - 52px);">
          <iframe id="filePreviewFrame" src="" class="w-full h-full rounded-b-xl border-0"></iframe>
        </div>
      </div>
    </div>

    <script>
      // ---- PDFプレビュー（送信前）----
      const _previewObjectUrls = {}

      function handleFilePreview(input, btnId) {
        const btn = document.getElementById(btnId)
        if (!btn) return
        if (input.files && input.files[0]) {
          // 既存のObjectURLを解放
          if (_previewObjectUrls[btnId]) {
            URL.revokeObjectURL(_previewObjectUrls[btnId])
          }
          _previewObjectUrls[btnId] = URL.createObjectURL(input.files[0])
          btn.classList.remove('hidden')
          btn.classList.add('inline-flex')
        } else {
          btn.classList.add('hidden')
          btn.classList.remove('inline-flex')
        }
      }

      function openFilePreview(inputId) {
        const input = document.getElementById(inputId)
        if (!input || !input.files || !input.files[0]) return
        const file = input.files[0]
        // ボタンIDを入力IDから逆引き
        const btnId = inputId.replace('Input', 'Preview')
        const url = _previewObjectUrls[btnId] || URL.createObjectURL(file)
        _previewObjectUrls[btnId] = url
        document.getElementById('filePreviewTitle').textContent = file.name
        document.getElementById('filePreviewFrame').src = url
        const modal = document.getElementById('filePreviewModal')
        modal.classList.remove('hidden')
        modal.classList.add('flex')
      }

      function closeFilePreviewModal() {
        const modal = document.getElementById('filePreviewModal')
        modal.classList.add('hidden')
        modal.classList.remove('flex')
        document.getElementById('filePreviewFrame').src = ''
      }

      // 背景クリックで閉じる
      document.getElementById('filePreviewModal').addEventListener('click', function(e) {
        if (e.target === this) closeFilePreviewModal()
      })

      // カンマ区切りフォーマット関数
      function formatComma(el, hiddenId) {
        const raw = el.value.replace(/[^0-9]/g, '')
        el.value = raw === '' ? '' : Number(raw).toLocaleString()
        const hidden = document.getElementById(hiddenId + 'Hidden')
        if (hidden) hidden.value = raw
      }

      // ページ読み込み時に手数料フィールドのrequiredを除去（ブラウザネイティブバリデーション無効化）
      document.addEventListener('DOMContentLoaded', function() {
        const budgetEl = document.getElementById('budgetAmountInput')
        const commissionEl = document.getElementById('commissionRateInput')
        if (budgetEl) budgetEl.required = false
        if (commissionEl) commissionEl.required = false
        // 送信先プレビューを初期表示
        updateReviewerPreview()
      })

      // マンションデータをJSに埋め込み
      const MANSIONS = ${JSON.stringify(
        (mansions.results as any[]).map((m: any) => ({
          id: m.id,
          number: m.mansion_number,
          name: m.name
        }))
      )};

      // inboxからの自動セット
      ${inboxData ? `
      window.addEventListener('DOMContentLoaded', function() {
        // マンションを自動セット
        const numInput = document.getElementById('mansionNumberInput')
        if (numInput) {
          numInput.value = '${inboxData.mansion_number}'
          searchMansion('${inboxData.mansion_number}')
        }
      })
      ` : ''}

      // === 差し戻し再申請: 元申請の値でフォームをprefill ===
      ${resubmitSource ? `
      window.addEventListener('DOMContentLoaded', function() {
        // 1) マンション自動セット
        const numInput = document.getElementById('mansionNumberInput')
        if (numInput && ${resubmitSource.mansion_number != null ? resubmitSource.mansion_number : 'null'} !== null) {
          numInput.value = '${resubmitSource.mansion_number || ''}'
          searchMansion('${resubmitSource.mansion_number || ''}')
        }
        setTimeout(function() {
          // 2) 支払先
          const payTarget = ${JSON.stringify(resubmitSource.payment_target || '')}
          if (payTarget) {
            const payRadio = document.querySelector('input[name="payment_target"][value="' + payTarget + '"]')
            if (payRadio) {
              payRadio.checked = true
              payRadio.dispatchEvent(new Event('change'))
            }
          }
          // 3) TD区分（委託内/元請）
          const tdType = ${JSON.stringify(resubmitSource.td_type || '')}
          if (tdType) {
            setTimeout(function() {
              const tdRadio = document.querySelector('input[name="td_type"][value="' + tdType + '"]')
              if (tdRadio) {
                tdRadio.checked = true
                tdRadio.dispatchEvent(new Event('change'))
              }
            }, 50)
          }
          // 4) 勘定科目（管理組合の場合）
          const accountItem = ${JSON.stringify(resubmitSource.account_item || '')}
          if (accountItem) {
            setTimeout(function() {
              const acctSel = document.querySelector('select[name="account_item"]')
              if (acctSel) acctSel.value = accountItem
            }, 100)
          }
          // 5) 金額系: 元請の場合 kumiai_amount, gyosha_amount
          const kumiaiAmt = ${resubmitSource.kumiai_amount != null ? resubmitSource.kumiai_amount : 'null'}
          const gyoshaAmt = ${resubmitSource.gyosha_amount != null ? resubmitSource.gyosha_amount : 'null'}
          setTimeout(function() {
            if (kumiaiAmt != null) {
              const kD = document.getElementById('kumiaiAmountDisplay')
              const kH = document.getElementById('kumiaiAmountHidden')
              if (kD) kD.value = Number(kumiaiAmt).toLocaleString()
              if (kH) kH.value = String(kumiaiAmt)
            }
            if (gyoshaAmt != null) {
              const gD = document.getElementById('gyoshaAmountDisplay')
              const gH = document.getElementById('gyoshaAmountHidden')
              if (gD) gD.value = Number(gyoshaAmt).toLocaleString()
              if (gH) gH.value = String(gyoshaAmt)
            }
            if (typeof calcProfit === 'function') calcProfit()
          }, 150)
          // 6) 手数料（管理組合の場合の budget_amount / commission_rate）
          const budgetAmt = ${resubmitSource.budget_amount != null ? resubmitSource.budget_amount : 'null'}
          const commissionRate = ${resubmitSource.commission_rate != null ? resubmitSource.commission_rate : 'null'}
          setTimeout(function() {
            if (budgetAmt != null && payTarget !== 'td') {
              const bInput = document.getElementById('budgetAmountInput')
              const bHidden = document.getElementById('budgetAmountHidden')
              if (bInput) bInput.value = Number(budgetAmt).toLocaleString()
              if (bHidden) bHidden.value = String(budgetAmt)
            }
            if (commissionRate != null && payTarget !== 'td') {
              const cInput = document.getElementById('commissionRateInput')
              if (cInput) cInput.value = String(commissionRate)
            }
            if (typeof validateFeeFields === 'function') validateFeeFields()
          }, 200)
          // 7) 回覧・承認先 Step1/Step2/Step3 (元申請から取得済のcirculation_stepsをJSに渡す)
          const rsSteps = ${JSON.stringify(resubmitSource._steps || [])}
          setTimeout(function() {
            const s1 = rsSteps.find(function(s){ return s.step_number === 1 })
            const s2 = rsSteps.find(function(s){ return s.step_number === 2 })
            const s3 = rsSteps.find(function(s){ return s.step_number === 3 })
            if (s1) {
              const sel1 = document.querySelector('select[name="reviewer_step1"]')
              if (sel1) sel1.value = String(s1.reviewer_id)
            }
            if (s2) {
              const sel2 = document.querySelector('select[name="reviewer_step2"]')
              if (sel2) sel2.value = String(s2.reviewer_id)
            }
            if (s3) {
              // Step3のロール判定: accountingユーザーに含まれるか
              const isAccounting = ACCOUNTING_USERS.some(function(u){ return u.id === s3.reviewer_id })
              const roleVal = isAccounting ? 'accounting' : 'honsha'
              const roleRadio = document.querySelector('input[name="reviewer_step3_role"][value="' + roleVal + '"]')
              if (roleRadio) {
                roleRadio.checked = true
                if (typeof updateStep3Users === 'function') updateStep3Users()
                setTimeout(function() {
                  const sel3 = document.getElementById('step3UserSelect')
                  if (sel3) sel3.value = String(s3.reviewer_id)
                  if (typeof updateReviewerPreview === 'function') updateReviewerPreview()
                }, 50)
              }
            } else {
              if (typeof updateReviewerPreview === 'function') updateReviewerPreview()
            }
          }, 250)
        }, 100)
      })
      ` : ''}

      // 元請セット申請B: 自動セット
      ${motoukeSource ? `
      window.addEventListener('DOMContentLoaded', function() {
        // 1) マンション自動セット
        const numInput = document.getElementById('mansionNumberInput')
        if (numInput) {
          numInput.value = '${motoukeSource.mansion_number}'
          searchMansion('${motoukeSource.mansion_number}')
        }
        // 2) 支払先 = 管理組合を選択・ロック
        setTimeout(function() {
          const kumiaiRadio = document.querySelector('input[name="payment_target"][value="kumiai"]')
          if (kumiaiRadio) {
            kumiaiRadio.checked = true
            kumiaiRadio.dispatchEvent(new Event('change'))
          }
          // 支払先ラジオを無効化（変更不可）
          document.querySelectorAll('input[name="payment_target"]').forEach(el => el.disabled = true)

          // 3) 金額を管理組合請求金額で自動セット
          const budgetInput = document.getElementById('budgetAmountInput')
          const budgetHidden = document.getElementById('budgetAmountHidden')
          const amount = '${motoukeSource.kumiai_amount || 0}'
          if (budgetInput) {
            budgetInput.value = Number(amount).toLocaleString()
          }
          if (budgetHidden) budgetHidden.value = amount
        }, 200)
      })
      ` : ''}

      // 会計課・本社経理ユーザーをJSに埋め込み
      const ACCOUNTING_USERS = ${JSON.stringify(
        (accountingUsers.results as any[]).map((u: any) => ({ id: u.id, name: u.name }))
      )};
      const HONSHA_USERS = ${JSON.stringify(
        (honshaUsers.results as any[]).map((u: any) => ({ id: u.id, name: u.name }))
      )};
      const DEFAULT_HONSHA_USER_ID = ${defaultHonshaUser ? defaultHonshaUser.id : 'null'};

      function updateStep3Users() {
        const role = document.querySelector('input[name="reviewer_step3_role"]:checked')?.value
        const sel = document.getElementById('step3UserSelect')
        const users = role === 'accounting' ? ACCOUNTING_USERS : role === 'honsha' ? HONSHA_USERS : []
        sel.innerHTML = users.length === 0
          ? '<option value="">先に役割を選択してください</option>'
          : '<option value="">担当者を選択してください</option>' +
            users.map(u => '<option value="' + u.id + '">' + u.name + '</option>').join('')
        // 本社経理を選択した場合、デフォルトで山崎 修を自動選択
        if (role === 'honsha' && users.length > 0) {
          if (DEFAULT_HONSHA_USER_ID && users.some(u => u.id === DEFAULT_HONSHA_USER_ID)) {
            sel.value = String(DEFAULT_HONSHA_USER_ID)
          } else {
            sel.value = String(users[0].id)
          }
        }
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
          resultEl.innerHTML = '<span class="text-[#2E5580] font-bold text-base mr-2">' + found.number + '</span><span class="font-semibold text-gray-800">' + found.name + '</span>';
          resultEl.className = 'px-3 py-2.5 border-2 border-[#5B8AB5] rounded-lg text-sm bg-[#EEF4FA] min-h-[42px] flex items-center gap-1';
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

      // 現在の支払先/区分に応じた請求書②以降の追加上限を返す
      // - 管理組合(kumiai) → 最大3枠 (②③④)
      // - 会社(TD) 委託内(ittaku) → 最大5枠 (②〜⑥)
      // - それ以外（TD 元請 or 未選択）→ 追加不可（1枠のみ）
      // 現在の支払先/区分に応じた請求書②以降の追加上限を返す
      // - 管理組合(kumiai) → 最大3枠 (②③④)
      // - 会社(TD) 委託内(ittaku) → 最大5枠 (②〜⑥)
      // - 会社(TD) 元請(motouke) → 最大2枠 (②③)
      // - それ以外（未選択）→ 追加不可（1枠のみ）
      function getMaxInvoiceSlots() {
        const pay = document.querySelector('input[name="payment_target"]:checked')?.value
        const td = document.querySelector('input[name="td_type"]:checked')?.value
        if (pay === 'kumiai') return 3
        if (pay === 'td' && td === 'ittaku') return 5
        if (pay === 'td' && td === 'motouke') return 2
        return 1
      }

      // 追加ボタン・ヒント表示の更新（拡張可否を反映）
      function updateInvoiceExtraUI() {
        const max = getMaxInvoiceSlots()
        const addBtn = document.getElementById('addInvoiceBtn')
        const hint = document.getElementById('invoiceExtraHint')
        const list = document.getElementById('invoiceExtraList')
        if (!list) return
        const existing = list.querySelectorAll('[data-invoice-slot]').length
        // 追加不可(max=1) or 上限達 → 追加ボタン非表示
        const canAdd = max > 1 && existing < max
        if (addBtn) addBtn.classList.toggle('hidden', !canAdd)
        if (hint) {
          if (max > 1) {
            hint.textContent = '最大' + max + '個まで追加できます'
            hint.classList.remove('hidden')
          } else {
            hint.classList.add('hidden')
          }
        }
        // 現在の枠数が上限を超えている場合は超過分を削除（支払先切替時のクリーンアップ）
        if (existing > max) {
          document.querySelectorAll('[data-invoice-slot]').forEach(function(el) {
            const slot = parseInt(el.getAttribute('data-invoice-slot'))
            if (slot > max + 1) el.remove()  // slot=2 が index=1 なので max+1
          })
        }
      }

      function togglePaymentFields() {
        const val = document.querySelector('input[name="payment_target"]:checked')?.value
        document.getElementById('kumiaiFields').classList.toggle('hidden', val !== 'kumiai')
        document.getElementById('tdFields').classList.toggle('hidden', val !== 'td')
        if (val !== 'td') document.getElementById('motoukeFields').classList.add('hidden')
        // 会社（TD）選択時は手数料を非表示
        document.getElementById('amountFields').classList.toggle('hidden', val === 'td')
        // TD選択時はrequiredを完全解除（手数料バリデーションはcheckFeeRequired()で行う）
        const budgetInput = document.querySelector('input[name="budget_amount"]')
        if (budgetInput) budgetInput.required = false
        // 請求書追加UIの表示を更新
        updateInvoiceExtraUI()
        updateReviewerPreview()
      }
      function toggleMotouke() {
        const val = document.querySelector('input[name="td_type"]:checked')?.value
        document.getElementById('motoukeFields').classList.toggle('hidden', val !== 'motouke')
        // 請求書追加UIの表示を更新（委託内=5枠、元請=追加不可）
        updateInvoiceExtraUI()
        calcProfit()
      }

      // 請求書スロットの動的追加（管理組合=最大3、委託内=最大5）
      function addInvoiceSlot() {
        const list = document.getElementById('invoiceExtraList')
        if (!list) return
        const max = getMaxInvoiceSlots()
        // 現在のスロット数を数える
        const existing = list.querySelectorAll('[data-invoice-slot]').length
        if (existing >= max) return
        const newSlot = existing + 2  // 2,3,4,5,6
        const marks = ['②', '③', '④', '⑤', '⑥']
        const mark = marks[newSlot - 2] || ('' + newSlot)
        const wrap = document.createElement('div')
        wrap.className = 'flex items-center gap-2'
        wrap.setAttribute('data-invoice-slot', String(newSlot))
        wrap.innerHTML =
          '<label class="text-xs text-gray-500 w-16 shrink-0">請求書' + mark + '</label>' +
          '<input type="file" name="invoice' + newSlot + '" accept=".pdf,.jpg,.jpeg,.png" id="invoice' + newSlot + 'Input" ' +
            'onchange="handleFilePreview(this, \\'invoice' + newSlot + 'Preview\\')" ' +
            'class="flex-1 text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-[#EEF4FA] file:text-[#396999] hover:file:bg-[#D5E5F2]">' +
          '<button type="button" id="invoice' + newSlot + 'Preview" onclick="openFilePreview(\\'invoice' + newSlot + 'Input\\')" ' +
            'class="hidden items-center gap-1 px-3 py-1.5 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580]">' +
            '👁 確認</button>' +
          '<button type="button" onclick="removeInvoiceSlot(this)" ' +
            'class="inline-flex items-center px-2 py-1.5 border border-red-300 text-red-500 text-xs rounded-md hover:bg-red-50" title="この欄を削除">' +
            '×</button>'
        list.appendChild(wrap)
        // 追加後、上限に達したらボタン非表示
        if (existing + 1 >= max) {
          document.getElementById('addInvoiceBtn').classList.add('hidden')
        }
      }

      // 動的追加された請求書スロットを削除して番号を再採番
      function removeInvoiceSlot(btn) {
        const row = btn.closest('[data-invoice-slot]')
        if (row) row.remove()
        // 再採番: 残ったスロットのnameとidを詰め直す
        const list = document.getElementById('invoiceExtraList')
        const rows = list.querySelectorAll('[data-invoice-slot]')
        const marks = ['②', '③', '④', '⑤', '⑥']
        rows.forEach(function(r, idx) {
          const slot = idx + 2  // 2,3,4,5,6
          r.setAttribute('data-invoice-slot', String(slot))
          const mark = marks[slot - 2] || ('' + slot)
          const label = r.querySelector('label')
          if (label) label.textContent = '請求書' + mark
          const input = r.querySelector('input[type="file"]')
          if (input) {
            input.name = 'invoice' + slot
            input.id = 'invoice' + slot + 'Input'
            input.setAttribute('onchange', "handleFilePreview(this, 'invoice" + slot + "Preview')")
          }
          const previewBtn = r.querySelectorAll('button')[0]
          if (previewBtn) {
            previewBtn.id = 'invoice' + slot + 'Preview'
            previewBtn.setAttribute('onclick', "openFilePreview('invoice" + slot + "Input')")
          }
        })
        // 追加ボタンを再表示（上限未達ならON）
        updateInvoiceExtraUI()
      }

      function calcProfit() {
        const profitDisplay = document.getElementById('profitDisplay')
        const profitAmountEl = document.getElementById('profitAmount')
        const profitRateEl = document.getElementById('profitRate')

        // display欄からカンマ除去して直接取得（hiddenフィールドのタイミング問題を回避）
        const kumiaiRaw = (document.getElementById('kumiaiAmountDisplay')?.value || '').replace(/[^0-9]/g, '')
        const gyoshaRaw = (document.getElementById('gyoshaAmountDisplay')?.value || '').replace(/[^0-9]/g, '')

        const kumiai = parseInt(kumiaiRaw || '0', 10)
        const gyosha = parseInt(gyoshaRaw || '0', 10)

        // どちらか一方でも入力があれば表示
        if (kumiai > 0 || gyosha > 0) {
          profitDisplay.classList.remove('hidden')
          profitDisplay.classList.add('grid')
          const profit = kumiai - gyosha
          const rate = kumiai > 0 ? (profit / kumiai * 100) : 0
          // 利益額（マイナスは赤表示）
          profitAmountEl.textContent = (profit >= 0 ? '' : '-') + Math.abs(profit).toLocaleString() + '円'
          profitAmountEl.className = 'text-sm font-semibold ' + (profit >= 0 ? 'text-gray-800' : 'text-red-600')
          // 利益率（小数点第1位）
          profitRateEl.textContent = rate.toFixed(1) + '％'
          profitRateEl.className = 'text-sm font-semibold ' + (rate >= 0 ? 'text-gray-800' : 'text-red-600')
        } else {
          profitDisplay.classList.add('hidden')
          profitDisplay.classList.remove('grid')
        }
      }

      function validateFeeFields() {
        const amountFields = document.getElementById('amountFields')
        if (amountFields.classList.contains('hidden')) return
        // hiddenフィールドの値（カンマなし数値）で判定
        const budget = document.getElementById('budgetAmountHidden')?.value ||
                       document.getElementById('budgetAmountInput')?.value.replace(/,/g, '')
        const commission = document.getElementById('commissionRateInput')?.value
        const msg = document.getElementById('feeValidationMsg')
        // どちらか一方でも値があればOK（0も有効な値として扱う）
        const hasValue = (budget !== '' && budget !== null && budget !== undefined) ||
                         (commission !== '' && commission !== null && commission !== undefined)
        const budgetEl = document.getElementById('budgetAmountInput')
        const commissionEl = document.getElementById('commissionRateInput')
        // requiredを完全に外す（ブラウザネイティブバリデーションを無効化）
        budgetEl.required = false
        commissionEl.required = false
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
        const budget = document.getElementById('budgetAmountHidden')?.value ||
                       document.getElementById('budgetAmountInput')?.value.replace(/,/g, '')
        const commission = document.getElementById('commissionRateInput')?.value
        // どちらか一方でも値があればOK（0も有効な値）
        const hasValue = (budget !== '' && budget !== null && budget !== undefined) ||
                         (commission !== '' && commission !== null && commission !== undefined)
        if (!hasValue) {
          validateFeeFields()
          document.getElementById('budgetAmountInput').focus()
          return false
        }
        return true
      }

      async function updateReviewerPreview() {
        const previewEl = document.getElementById('reviewerPreview')
        const listEl = document.getElementById('reviewerList')

        // フォームで選択中の値を直接参照してプレビューを構築（常時表示）
        const reviewers = []

        // Step1: 上長プルダウンの選択値
        const step1Select = document.querySelector('select[name="reviewer_step1"]')
        const step1Name = step1Select?.options[step1Select.selectedIndex]?.text || ''
        reviewers.push({
          step: 1, label: '上長',
          name: (step1Select?.value && step1Name !== '選択してください') ? step1Name : '未選択',
          unset: !step1Select?.value
        })

        // Step2: 業務管理課プルダウンの選択値
        const step2Select = document.querySelector('select[name="reviewer_step2"]')
        const step2Name = step2Select?.options[step2Select.selectedIndex]?.text || ''
        reviewers.push({
          step: 2, label: '業務管理課',
          name: (step2Select?.value && step2Name !== '選択してください') ? step2Name : '未選択',
          unset: !step2Select?.value
        })

        // Step3: 最終承認者プルダウンの選択値
        const step3Role = document.querySelector('input[name="reviewer_step3_role"]:checked')?.value
        const step3Select = document.getElementById('step3UserSelect')
        const step3Name = step3Select?.options[step3Select.selectedIndex]?.text || ''
        const step3Label = step3Role === 'honsha' ? '本社経理' : 'マンション会計課'
        reviewers.push({
          step: 3, label: step3Label,
          name: (step3Select?.value && step3Name !== '先に役割を選択してください' && step3Name !== '担当者を選択してください') ? step3Name : '未選択',
          unset: !step3Select?.value
        })

        const stepColors = ['bg-[#D5E5F2] text-[#2E5580]', 'bg-orange-100 text-orange-700', 'bg-green-100 text-green-700']
        listEl.innerHTML = reviewers.map((r, i) => {
          return '<div class="flex items-center gap-3">' +
            '<span class="text-xs font-bold text-indigo-400 w-5 text-center">Step ' + r.step + '</span>' +
            '<svg class="w-3 h-3 text-indigo-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>' +
            '<span class="text-xs px-2 py-0.5 rounded-full font-medium ' + stepColors[i] + '">' + r.label + '</span>' +
            '<span class="text-sm font-medium ' + (r.unset ? 'text-red-400 italic' : 'text-gray-800') + '">' + r.name + '</span>' +
          '</div>'
        }).join('')
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
  if (!user.is_admin && !ALLOWED_NEW_APP_ROLES.includes(user.role)) {
    return c.html(`<p style="padding:2rem;font-family:sans-serif;color:#dc2626">⛔ この画面へのアクセス権限がありません。</p>`, 403)
  }

  const db = c.env.DB
  const body = await c.req.parseBody({ all: true }) as any

  const appNumber = generateApplicationNumber()
  const mansionId = body.mansion_id ? parseInt(body.mansion_id) : null

  // === 元請セット申請Bの場合の情報取得 ===
  const fromMotoukeId = body.from_motouke ? parseInt(body.from_motouke) : null
  let motoukeSource: any = null
  let motoukeKumiaiAtt: any = null
  if (fromMotoukeId) {
    motoukeSource = await db.prepare(
      'SELECT * FROM applications WHERE id = ? AND payment_target = ? AND td_type = ?'
    ).bind(fromMotoukeId, 'td', 'motouke').first() as any
    if (!motoukeSource || (motoukeSource.applicant_id !== user.uid && !user.is_admin)) {
      return c.html(`<p style="padding:2rem;color:#dc2626">⛔ 元請セット申請の作成権限がありません</p>`, 403)
    }
    // 二重作成防止
    const existingB = await db.prepare(
      'SELECT id FROM applications WHERE original_application_id = ? LIMIT 1'
    ).bind(fromMotoukeId).first() as any
    if (existingB) {
      return c.redirect(`/applications/${existingB.id}?motouke_dup=1`)
    }
    if (body.motouke_kumiai_att_id) {
      motoukeKumiaiAtt = await db.prepare(
        'SELECT * FROM attachments WHERE id = ? AND application_id = ? AND file_type = ?'
      ).bind(body.motouke_kumiai_att_id, fromMotoukeId, 'kumiai_invoice').first() as any
    }
  }

  // 手数料バリデーション（管理組合の場合、円か％どちらか必須。ただし元請セット申請Bは金額自動設定のためスキップ）
  if (body.payment_target !== 'td' && !fromMotoukeId) {
    const hasBudget = body.budget_amount !== '' && body.budget_amount != null
    const hasCommission = body.commission_rate !== '' && body.commission_rate != null
    if (!hasBudget && !hasCommission) {
      return c.redirect('/applications/new?error=fee_required')
    }
  }

  // ファイル保存（R2）
  const fileKeys: Record<string, string> = {}
  const fileNames: Record<string, string> = {}

  // inbox引き継ぎファイルがあり、新規ファイル未選択の場合はinboxのファイルをそのまま使用
  const inboxAttachmentKey = body.inbox_attachment_key || null
  const inboxAttachmentName = body.inbox_attachment_name || null

  // 委託内時に動的追加された invoice3〜invoice6 も保存対象に含める（最大5枠 invoice2〜invoice6）
  for (const fileKey of ['invoice1', 'invoice2', 'invoice3', 'invoice4', 'invoice5', 'invoice6', 'other1', 'other2']) {
    const file = body[fileKey] as File | undefined
    if (file && file.size > 0) {
      const ext = file.name.split('.').pop()
      const key = `attachments/${appNumber}/${fileKey}.${ext}`
      await c.env.R2.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type }
      })
      fileKeys[fileKey] = key
      fileNames[fileKey] = file.name
    } else if (fileKey === 'invoice1' && inboxAttachmentKey && !fileKeys['invoice1']) {
      // inbox引き継ぎファイルをinvoice1として使用
      fileKeys['invoice1'] = inboxAttachmentKey
      fileNames['invoice1'] = inboxAttachmentName || 'invoice.pdf'
    } else if (fileKey === 'invoice1' && motoukeKumiaiAtt && !fileKeys['invoice1']) {
      // 元請セット申請B: 管理組合宛請求書PDFをinvoice1として引き継ぐ
      fileKeys['invoice1'] = motoukeKumiaiAtt.file_key
      fileNames['invoice1'] = motoukeKumiaiAtt.file_name
    }
  }

  // 元請セット申請Bの場合: 支払先・金額を元申請の情報で上書き
  const effectivePaymentTarget = fromMotoukeId ? 'kumiai' : body.payment_target
  const effectiveBudgetAmount = fromMotoukeId
    ? (motoukeSource?.kumiai_amount || 0)
    : (parseInt(String(body.budget_amount || '0').replace(/,/g, '')) || 0)
  const effectiveTdType = fromMotoukeId ? null : (body.td_type || null)

  // === テスト申請フラグ判定 ===
  // 元請セット申請Bの場合、元申請のis_testを引き継ぐ
  // それ以外は、申請者本人のtest_mode（管理者のみ）で判定
  let isTestFlag = 0
  if (fromMotoukeId && motoukeSource) {
    isTestFlag = motoukeSource.is_test ? 1 : 0
  } else if (user.is_admin && user.test_mode === 1) {
    isTestFlag = 1
  }

  // 申請を保存
  const result = await db.prepare(`
    INSERT INTO applications (
      application_number, title, mansion_id, applicant_id, circulation_start_date,
      payment_target, account_item, td_type, kumiai_amount, gyosha_amount, budget_amount,
      commission_rate, remarks, status, current_step, resubmit_count, original_application_id, is_test
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'circulating', 1, 0, ?, ?)
  `).bind(
    appNumber,
    body.title || '',
    mansionId,
    user.uid,
    body.circulation_start_date,
    effectivePaymentTarget,
    body.account_item || null,
    effectiveTdType,
    body.kumiai_amount ? parseInt(String(body.kumiai_amount).replace(/,/g, '')) : null,
    body.gyosha_amount ? parseInt(String(body.gyosha_amount).replace(/,/g, '')) : null,
    effectiveBudgetAmount,
    body.commission_rate !== '' && body.commission_rate != null ? parseFloat(body.commission_rate) : null,
    body.remarks || null,
    fromMotoukeId,
    isTestFlag
  ).run()

  const appId = result.meta.last_row_id

  // 添付ファイル保存
  for (const [fk, key] of Object.entries(fileKeys)) {
    await db.prepare(
      'INSERT INTO attachments (application_id, file_type, file_name, file_key) VALUES (?, ?, ?, ?)'
    ).bind(appId, fk, fileNames[fk], key).run()
  }

  // 回覧ステップ作成（フォームの選択値を優先）
  // 元請セット申請Bの場合、支払先=kumiai + マンション会計の短縮フロー
  const reviewerStep1 = body.reviewer_step1 ? parseInt(body.reviewer_step1) : null
  const reviewerStep2 = body.reviewer_step2 ? parseInt(body.reviewer_step2) : null
  const reviewerStep3 = body.reviewer_step3 ? parseInt(body.reviewer_step3) : null
  await createCirculationSteps(db, appId as number, user.uid, effectivePaymentTarget, mansionId, reviewerStep1, reviewerStep2, reviewerStep3)

  // 最初の承認者にメール通知
  const firstStep = await db.prepare(
    'SELECT cs.*, u.email, u.name FROM circulation_steps cs JOIN users u ON cs.reviewer_id = u.id WHERE cs.application_id = ? AND cs.step_number = 1'
  ).bind(appId).first() as any

  if (firstStep) {
    const appUrl = `${new URL(c.req.url).origin}/applications/${appId}`
    await sendNotification(db, 'review_request', firstStep.reviewer_id, {
      appNumber, title: body.title, applicantName: user.name, appUrl,
      isTest: isTestFlag === 1
    })
    await db.prepare(
      'INSERT INTO notification_logs (application_id, recipient_id, notification_type, email_to, subject, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(appId, firstStep.reviewer_id, 'review_request', firstStep.email,
      (isTestFlag === 1 ? '[TEST] ' : '') + buildMailSubject('review_request', appNumber), 'sent'
    ).run()
  }

  // inbox引き継ぎの場合、invoice_inboxのstatusをappliedに更新
  const inboxIdFromBody = body.inbox_id ? parseInt(body.inbox_id) : null
  if (inboxIdFromBody) {
    const now = new Date().toISOString()
    await db.prepare(
      'UPDATE invoice_inbox SET status = ?, application_id = ?, updated_at = ? WHERE id = ? AND status = ?'
    ).bind('applied', appId, now, inboxIdFromBody, 'pending').run()
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

  // Step2: フォーム指定 → なければ業務管理課primary（=本橋 employee_number 030）
  let s2 = step2UserId
  if (!s2) {
    // 本橋（employee_number=030）を優先的に選択
    const motohashi = await db.prepare(
      "SELECT id FROM users WHERE employee_number = '030' AND is_active = 1 LIMIT 1"
    ).first() as any
    if (motohashi) {
      s2 = motohashi.id
    } else {
      const opStaff = await db.prepare(
        'SELECT user_id FROM operations_staff WHERE is_primary = 1 LIMIT 1'
      ).first() as any
      s2 = opStaff?.user_id || null
    }
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

  // タイムライン用ヘルパー
  const timelineItemClass = (status: string, isCurrent: boolean) => {
    if (status === 'approved') return { dot: 'bg-green-500 border-green-500', card: 'bg-green-50 border-green-200', text: 'text-green-700' }
    if (status === 'rejected') return { dot: 'bg-red-500 border-red-500', card: 'bg-red-50 border-red-200', text: 'text-red-700' }
    if (status === 'returned') return { dot: 'bg-orange-500 border-orange-500', card: 'bg-orange-50 border-orange-200', text: 'text-orange-700' }
    if (status === 'on_hold') return { dot: 'bg-yellow-400 border-yellow-400', card: 'bg-yellow-50 border-yellow-200', text: 'text-yellow-700' }
    if (isCurrent) return { dot: 'bg-[#396999] border-[#396999]', card: 'bg-[#EEF4FA] border-[#AECBE5]', text: 'text-[#2E5580]' }
    return { dot: 'bg-gray-300 border-gray-300', card: 'bg-gray-50 border-gray-200', text: 'text-gray-400' }
  }
  const statusLabel: Record<string, string> = {
    approved: '承認済', rejected: '否決', returned: '差し戻し', on_hold: '保留中', pending: '待機中'
  }

  const isApplicant = app.applicant_id === user.uid
  const isRejected = app.status === 'rejected'
  const isReturned = app.status === 'returned'

  // === 元請セット申請の相互リンク情報 ===
  // 申請A の場合: 後続申請Bの情報を取得
  let motoukeSuccessorB: any = null
  let motoukeKumiaiUploaded = false
  if (app.payment_target === 'td' && app.td_type === 'motouke') {
    motoukeSuccessorB = await db.prepare(`
      SELECT id, application_number, status FROM applications
      WHERE original_application_id = ? ORDER BY id DESC LIMIT 1
    `).bind(id).first() as any
    const kumiaiAtt = await db.prepare(
      'SELECT id FROM attachments WHERE application_id = ? AND file_type = ? LIMIT 1'
    ).bind(id, 'kumiai_invoice').first() as any
    motoukeKumiaiUploaded = !!kumiaiAtt
  }
  // 申請B の場合: 元申請Aの情報を取得
  let motoukeSourceA: any = null
  if (app.original_application_id) {
    motoukeSourceA = await db.prepare(`
      SELECT id, application_number, status FROM applications WHERE id = ?
    `).bind(app.original_application_id).first() as any
  }

  // === 差し戻し・否決からの再申請の後続情報を取得 ===
  // この申請が差し戻し/否決状態で、既に後続の再申請が作成されているかを判定
  let resubmitSuccessor: any = null
  if (isReturned || isRejected) {
    resubmitSuccessor = await db.prepare(`
      SELECT id, application_number, status, created_at FROM applications
      WHERE original_application_id = ? ORDER BY id DESC LIMIT 1
    `).bind(id).first() as any
  }

  // クエリパラメータからのフラッシュメッセージ
  const flashMotouke = c.req.query('motouke_remind') || c.req.query('motouke_dup')
  let motoukeFlash = ''
  if (c.req.query('motouke_remind') === 'ok') {
    motoukeFlash = `<div class="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-lg">✅ 申請者にリマインド通知を送信しました</div>`
  } else if (c.req.query('motouke_remind') === 'already') {
    motoukeFlash = `<div class="bg-yellow-50 border border-yellow-200 text-yellow-700 text-sm px-4 py-3 rounded-lg">⚠️ 既に後続申請Bが作成されています</div>`
  } else if (c.req.query('motouke_remind') === 'no_pdf') {
    motoukeFlash = `<div class="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">❌ 管理組合宛請求書PDFが未アップロードのためリマインドを送信できません</div>`
  } else if (c.req.query('motouke_dup') === '1') {
    motoukeFlash = `<div class="bg-blue-50 border border-blue-200 text-blue-700 text-sm px-4 py-3 rounded-lg">ℹ️ この元請の後続申請Bは既に作成済みです。既存の申請ページを表示しています。</div>`
  }

  const content = `
    <div class="space-y-6 max-w-3xl">
      ${motoukeFlash}

      <!-- ★案A: 差し戻し中 or 否決 の申請者向け目立つ通知バー（ページ最上部） -->
      <!-- 後続の再申請が既に作成されている場合は「再申請済」の案内に切り替え -->
      ${isApplicant && isReturned && !resubmitSuccessor ? `
      <div class="bg-gradient-to-r from-orange-100 to-orange-50 border-2 border-orange-400 rounded-xl p-5 shadow-md">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div class="flex items-start gap-3 flex-1 min-w-0">
            <span class="text-3xl leading-none">↩</span>
            <div class="min-w-0">
              <p class="text-base font-bold text-orange-900">この申請は差し戻されました</p>
              <p class="text-xs text-orange-700 mt-0.5">内容（金額・請求書・添付・備考など）を修正して再申請してください。</p>
            </div>
          </div>
          <a href="/applications/new?resubmit_id=${id}"
            class="inline-flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white font-bold px-6 py-3 rounded-lg shadow transition text-sm whitespace-nowrap">
            ✏ 編集して再申請する →
          </a>
        </div>
      </div>
      ` : ''}
      ${isApplicant && isRejected && !resubmitSuccessor ? `
      <div class="bg-gradient-to-r from-red-100 to-red-50 border-2 border-red-400 rounded-xl p-5 shadow-md">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div class="flex items-start gap-3 flex-1 min-w-0">
            <span class="text-3xl leading-none">❌</span>
            <div class="min-w-0">
              <p class="text-base font-bold text-red-900">この申請は否決されました</p>
              <p class="text-xs text-red-700 mt-0.5">内容を確認・修正して再提出できます。</p>
            </div>
          </div>
          <a href="/applications/new?resubmit_id=${id}"
            class="inline-flex items-center gap-2 bg-red-500 hover:bg-red-600 text-white font-bold px-6 py-3 rounded-lg shadow transition text-sm whitespace-nowrap">
            ✏ 編集して再提出する →
          </a>
        </div>
      </div>
      ` : ''}
      <!-- 再申請済の案内（後続申請へのリンク） -->
      ${(isReturned || isRejected) && resubmitSuccessor ? `
      <div class="bg-gradient-to-r from-emerald-50 to-white border-2 border-emerald-300 rounded-xl p-5 shadow-sm">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div class="flex items-start gap-3 flex-1 min-w-0">
            <span class="text-3xl leading-none">✅</span>
            <div class="min-w-0">
              <p class="text-base font-bold text-emerald-800">この申請は${isReturned ? '再申請済' : '再提出済'}です</p>
              <p class="text-xs text-emerald-700 mt-0.5">
                後続申請: <a href="/applications/${resubmitSuccessor.id}" class="font-mono underline hover:text-emerald-900">${resubmitSuccessor.application_number}</a>
                <span class="ml-2 text-emerald-600">(${resubmitSuccessor.status === 'circulating' ? '回覧中' : resubmitSuccessor.status === 'completed' ? '完了' : resubmitSuccessor.status === 'returned' ? '差し戻し' : resubmitSuccessor.status === 'rejected' ? '否決' : resubmitSuccessor.status})</span>
                <span class="ml-2 text-gray-400">${resubmitSuccessor.created_at?.substring(0,16)}</span>
              </p>
            </div>
          </div>
          <a href="/applications/${resubmitSuccessor.id}"
            class="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-5 py-2.5 rounded-lg shadow-sm transition text-sm whitespace-nowrap">
            後続申請を開く →
          </a>
        </div>
      </div>
      ` : ''}

      <!-- ヘッダー -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div class="flex items-start justify-between mb-4">
          <div>
            <div class="flex items-center gap-2 mb-1 flex-wrap">
              <span class="text-xs text-gray-400">${app.application_number}</span>
              ${app.is_test ? '<span class="bg-yellow-100 text-yellow-800 text-xs font-bold px-2 py-0.5 rounded-full border border-yellow-300">🧪 テスト申請</span>' : ''}
              ${app.resubmit_count > 0 && app.returned_reason ? `<span class="bg-orange-100 text-orange-700 text-xs font-semibold px-2 py-0.5 rounded-full">↩ 差し戻し再申請 ${app.resubmit_count}回目</span>` : app.resubmit_count > 0 ? `<span class="bg-purple-100 text-purple-600 text-xs font-semibold px-2 py-0.5 rounded-full">再提出 ${app.resubmit_count}回目</span>` : ''}
              ${(app.payment_target === 'td' && app.td_type === 'motouke') ? '<span class="bg-amber-100 text-amber-700 text-xs font-semibold px-2 py-0.5 rounded-full">🔗 元請セット申請A</span>' : ''}
              ${app.original_application_id ? '<span class="bg-emerald-100 text-emerald-700 text-xs font-semibold px-2 py-0.5 rounded-full">🔗 元請セット申請B（後続）</span>' : ''}
            </div>
            <h2 class="text-xl font-bold text-gray-800">${app.mansion_name || app.title}</h2>
          </div>
          ${statusBadge(app.status)}
        </div>

        ${motoukeSuccessorB ? `
        <div class="mt-3 bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center justify-between gap-3 text-sm">
          <div>
            <span class="text-emerald-700 font-semibold">🔗 後続申請B:</span>
            <a href="/applications/${motoukeSuccessorB.id}" class="text-emerald-700 hover:underline font-mono ml-2">${motoukeSuccessorB.application_number}</a>
            <span class="text-emerald-600 text-xs ml-2">(${motoukeSuccessorB.status})</span>
          </div>
        </div>
        ` : ''}

        ${(app.payment_target === 'td' && app.td_type === 'motouke' && !motoukeSuccessorB && isApplicant) ? `
        <div class="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
          <p class="text-amber-800 font-semibold mb-2">🔗 元請セット申請B（後続）を作成する</p>
          ${motoukeKumiaiUploaded ? `
            <p class="text-amber-700 text-xs mb-2">管理組合宛請求書がアップロード済です。続けて後続申請Bを作成できます。</p>
            <a href="/applications/new?from_motouke=${id}"
              class="inline-flex items-center gap-1 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold px-4 py-2 rounded-lg transition">
              📝 後続申請Bを作成する →
            </a>
          ` : `
            <p class="text-amber-700 text-xs">本橋（業務管理課）が管理組合宛請求書PDFをアップロードした後、後続申請Bを作成できます。</p>
          `}
        </div>
        ` : ''}

        ${(app.payment_target === 'td' && app.td_type === 'motouke' && !motoukeSuccessorB && motoukeKumiaiUploaded && (user.is_admin || user.role === 'operations')) ? `
        <div class="mt-3 bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm flex items-center justify-between gap-3">
          <div>
            <p class="text-blue-800 font-semibold">📢 後続申請Bのリマインド送信</p>
            <p class="text-blue-700 text-xs mt-0.5">申請者が後続申請Bをまだ作成していません。リマインドを送信できます。</p>
          </div>
          <form method="POST" action="/applications/${id}/motouke-remind" onsubmit="return confirm('${app.applicant_name}さんに、後続申請Bのリマインド通知を送信しますか？')">
            <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-2 rounded-lg transition">
              リマインド送信
            </button>
          </form>
        </div>
        ` : ''}

        ${motoukeSourceA ? `
        <div class="mt-3 bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm">
          <span class="text-emerald-700 font-semibold">🔗 元申請A:</span>
          <a href="/applications/${motoukeSourceA.id}" class="text-emerald-700 hover:underline font-mono ml-2">${motoukeSourceA.application_number}</a>
          <span class="text-emerald-600 text-xs ml-2">(${motoukeSourceA.status})</span>
          <span class="text-emerald-600 text-xs ml-1">- 業者請求書の回覧</span>
        </div>
        ` : ''}
        <div class="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <div><span class="text-gray-400">申請者</span><p class="font-medium mt-0.5">${app.applicant_name}</p></div>
          <div><span class="text-gray-400">回覧開始日</span><p class="font-medium mt-0.5">${app.circulation_start_date}</p></div>
          <div><span class="text-gray-400">支払先</span><p class="font-medium mt-0.5">${paymentLabel(app.payment_target, app.td_type)}</p></div>
          ${app.account_item ? `<div><span class="text-gray-400">勘定科目</span><p class="font-medium mt-0.5">${app.account_item}</p></div>` : ''}
          <div><span class="text-gray-400">手数料（円）</span><p class="font-medium mt-0.5">${Number(app.budget_amount).toLocaleString()}円</p></div>
          ${app.commission_rate != null ? `<div><span class="text-gray-400">手数料（％）</span><p class="font-medium mt-0.5">${app.commission_rate}%</p></div>` : ''}

          ${app.kumiai_amount ? `<div><span class="text-gray-400">組合請求金額</span><p class="font-medium mt-0.5">${Number(app.kumiai_amount).toLocaleString()}円</p></div>` : ''}
          ${app.gyosha_amount != null ? `<div><span class="text-gray-400">業者支払金額</span><p class="font-medium mt-0.5">${Number(app.gyosha_amount).toLocaleString()}円</p></div>` : ''}
          ${(app.kumiai_amount && app.gyosha_amount != null) ? (() => {
            const profit = Number(app.kumiai_amount) - Number(app.gyosha_amount)
            const rate = Number(app.kumiai_amount) > 0 ? (profit / Number(app.kumiai_amount) * 100).toFixed(1) : '0.0'
            const color = profit >= 0 ? 'text-gray-800' : 'text-red-600'
            return `<div><span class="text-gray-400">利益額</span><p class="font-medium mt-0.5 ${color}">${profit >= 0 ? '' : '-'}${Math.abs(profit).toLocaleString()}円</p></div>
                    <div><span class="text-gray-400">利益率</span><p class="font-medium mt-0.5 ${color}">${rate}％</p></div>`
          })() : ''}
          ${app.remarks ? `<div class="col-span-2"><span class="text-gray-400">備考</span><p class="font-medium mt-0.5">${app.remarks}</p></div>` : ''}
        </div>
      </div>

      <!-- 添付ファイル -->
      ${(attachments.results as any[]).length > 0 ? `
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="font-semibold text-gray-800 mb-3">添付ファイル</h3>
        <div class="space-y-2">
          ${(attachments.results as any[]).map(att => {
            const labels: Record<string, string> = { invoice1: '請求書①', invoice2: '請求書②', invoice3: '請求書③', invoice4: '請求書④', invoice5: '請求書⑤', invoice6: '請求書⑥', other1: '添付資料①', other2: '添付資料②', kumiai_invoice: '管理組合宛請求書' }
            return `<div class="flex items-center gap-2">
              <span class="text-xs text-gray-400 w-16 shrink-0">${labels[att.file_type] || att.file_type}</span>
              <span class="text-sm text-gray-700 flex-1 truncate">${att.file_name}</span>
              <button type="button" onclick="openSavedFilePreview('/files/${att.id}', '${att.file_name.replace(/'/g, "\\'")}')"
                class="inline-flex items-center gap-1 px-3 py-1.5 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580] shrink-0">
                👁 確認
              </button>
              <a href="/files/${att.id}" target="_blank"
                class="inline-flex items-center gap-1 px-3 py-1.5 border border-gray-300 text-gray-600 text-xs rounded-md hover:bg-gray-50 shrink-0">
                ⬇ DL
              </a>
            </div>`
          }).join('')}
        </div>
      </div>
      ` : ''}

      <!-- 差し戻し情報（差し戻し中または差し戻し再申請の場合） -->
      ${(app.status === 'returned' || app.returned_reason) ? `
      <div class="bg-orange-50 border border-orange-300 rounded-xl p-5 space-y-3">
        <h3 class="font-semibold text-orange-800 flex items-center gap-2">↩ 差し戻し情報</h3>
        <div>
          <p class="text-xs font-medium text-orange-600 mb-1">差し戻し理由</p>
          <p class="text-sm text-orange-900 bg-white rounded-lg p-3 border border-orange-200">${app.returned_reason || '-'}</p>
        </div>
        ${app.reapply_reason ? `
        <div>
          <p class="text-xs font-medium text-purple-600 mb-1">再申請理由・修正内容</p>
          <p class="text-sm text-purple-900 bg-white rounded-lg p-3 border border-purple-200">${app.reapply_reason}</p>
        </div>` : ''}
        ${isApplicant && isReturned && !resubmitSuccessor ? `
        <!-- ★案B: 差し戻し理由ボックス内の再申請ボタン（文脈上の自然な導線） -->
        <div class="pt-2 border-t border-orange-200">
          <a href="/applications/new?resubmit_id=${id}"
            class="inline-flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white font-semibold px-5 py-2.5 rounded-lg transition text-sm">
            ✏ この理由に対応して編集・再申請する →
          </a>
        </div>
        ` : ''}
        ${isReturned && resubmitSuccessor ? `
        <div class="pt-2 border-t border-orange-200">
          <p class="text-xs text-emerald-700">
            ✅ この差し戻しには既に対応済みです。後続申請
            <a href="/applications/${resubmitSuccessor.id}" class="font-mono underline hover:text-emerald-900">${resubmitSuccessor.application_number}</a>
            をご確認ください。
          </p>
        </div>
        ` : ''}
      </div>` : ''}

      <!-- 回覧フロー タイムライン -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="font-semibold text-gray-800 mb-5">回覧フロー</h3>
        <div class="relative">
          <!-- 縦線 -->
          <div class="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200"></div>

          <div class="space-y-0">
            <!-- 申請者（回覧開始日） -->
            <div class="relative flex gap-4 pb-6">
              <div class="w-8 h-8 rounded-full bg-[#396999] border-2 border-[#396999] text-white flex items-center justify-center text-xs font-bold z-10 shrink-0">申</div>
              <div class="flex-1 border border-[#AECBE5] bg-[#EEF4FA] rounded-lg p-3 ml-1">
                <div class="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <span class="text-sm font-semibold text-gray-800">${app.applicant_name}</span>
                    <span class="ml-2 text-xs text-gray-400">申請者</span>
                  </div>
                  <span class="text-xs font-medium bg-[#D5E5F2] text-[#2E5580] px-2 py-0.5 rounded-full">申請</span>
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
              const actionDateLabel =
                step.status === 'approved' ? '承認日時' :
                step.status === 'rejected' ? '否決日時' :
                step.status === 'returned' ? '差し戻し日時' :
                step.status === 'on_hold'  ? '保留日時' : '対応日時'
              return `
            <div class="relative flex gap-4 pb-6">
              <div class="w-8 h-8 rounded-full ${c2.dot} border-2 text-white flex items-center justify-center text-xs font-bold z-10 shrink-0">${step.step_number}</div>
              <div class="flex-1 border ${c2.card} rounded-lg p-3 ml-1">
                <div class="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <span class="text-sm font-semibold text-gray-800">${step.reviewer_name}</span>
                    <span class="ml-2 text-xs text-gray-400">${stepLabels[step.step_number] || 'レビュー'}</span>
                    ${isCurrent ? '<span class="ml-1 text-xs bg-[#EEF4FA] text-[#396999] px-1.5 py-0.5 rounded-full font-medium">承認待ち</span>' : ''}
                  </div>
                  <span class="text-xs font-medium px-2 py-0.5 rounded-full ${
                    step.status === 'approved' ? 'bg-green-100 text-green-700' :
                    step.status === 'rejected' ? 'bg-red-100 text-red-700' :
                    step.status === 'returned' ? 'bg-orange-100 text-orange-700' :
                    step.status === 'on_hold'  ? 'bg-yellow-100 text-yellow-700' :
                    isCurrent ? 'bg-[#EEF4FA] text-[#396999]' : 'bg-gray-100 text-gray-400'
                  }">${statusLabel[step.status] || '待機中'}</span>
                </div>
                ${step.acted_at ? `
                <div class="mt-1.5">
                  <span class="text-xs text-gray-500">🕐 ${actionDateLabel}：<span class="font-medium text-gray-700">${step.acted_at.substring(0,16)}</span></span>
                </div>` : ''}
                ${step.action_comment ? `<p class="text-xs text-gray-600 mt-2 bg-white rounded p-2 border border-gray-200">${
                  step.status === 'on_hold' ? '❓ ' :
                  step.status === 'returned' ? '↩ 差し戻し理由：' : '💬 '
                }${step.action_comment}</p>` : ''}
                ${step.hold_answer ? `<p class="text-xs text-[#396999] mt-1.5 bg-[#EEF4FA] rounded p-2 border border-[#D5E5F2]">📝 回答：${step.hold_answer}</p>` : ''}
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

      <!-- 差し戻し・否決後の再申請ボタンは、ページ上部の通知バー（案A）と
           差し戻し理由ボックス内のボタン（案B）に統合したため、ここでは非表示。 -->


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

  // 自分の番でない場合（current_step が自分の step_number と一致しない）はリダイレクト
  if (!app || app.current_step !== step.step_number) {
    return c.redirect(`/applications/${id}`)
  }

  const attachments = await db.prepare('SELECT * FROM attachments WHERE application_id = ?').bind(id).all()

  // 元請かつ本橋(業務管理課=step2)の承認時のみ、管理組合宛請求書PDFアップロード欄を表示
  const isMotoukeStep2 = app.payment_target === 'td' && app.td_type === 'motouke' && step.step_number === 2
  // 既にアップロード済みかチェック
  const kumiaiInvoiceExists = (attachments.results as any[]).some((a: any) => a.file_type === 'kumiai_invoice')
  // 既に後続申請Bが作成されているかチェック
  const successorApp = await db.prepare(
    'SELECT id, application_number, status FROM applications WHERE original_application_id = ? ORDER BY id DESC LIMIT 1'
  ).bind(id).first() as any

  const content = `
    <div class="max-w-2xl space-y-6">
      <!-- 申請概要 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div class="flex items-center gap-2 mb-4">
          <span class="text-xs text-gray-400">${app.application_number}</span>
          ${app.resubmit_count > 0 ? `<span class="bg-purple-100 text-purple-600 text-xs font-semibold px-2 py-0.5 rounded-full">再提出 ${app.resubmit_count}回目</span>` : ''}
          ${(app.payment_target === 'td' && app.td_type === 'motouke') ? '<span class="bg-amber-100 text-amber-700 text-xs font-semibold px-2 py-0.5 rounded-full">元請</span>' : ''}
        </div>
        <h2 class="text-lg font-bold text-gray-800 mb-4">${app.mansion_name || app.title}</h2>
        <div class="grid grid-cols-2 gap-3 text-sm">
          <div><span class="text-gray-400">申請者</span><p class="font-medium">${app.applicant_name}</p></div>
          <div><span class="text-gray-400">支払先</span><p class="font-medium">${paymentLabel(app.payment_target, app.td_type)}</p></div>
          ${app.account_item ? `<div><span class="text-gray-400">勘定科目</span><p class="font-medium">${app.account_item}</p></div>` : ''}
          <div><span class="text-gray-400">手数料（円）</span><p class="font-medium">${Number(app.budget_amount).toLocaleString()}円</p></div>
          ${app.commission_rate != null ? `<div><span class="text-gray-400">手数料（％）</span><p class="font-medium">${app.commission_rate}%</p></div>` : ''}

          ${app.kumiai_amount ? `<div><span class="text-gray-400">組合請求金額</span><p class="font-medium">${Number(app.kumiai_amount).toLocaleString()}円</p></div>` : ''}
          ${app.gyosha_amount != null ? `<div><span class="text-gray-400">業者支払金額</span><p class="font-medium">${Number(app.gyosha_amount).toLocaleString()}円</p></div>` : ''}
          ${(app.kumiai_amount && app.gyosha_amount != null) ? (() => {
            const profit = Number(app.kumiai_amount) - Number(app.gyosha_amount)
            const rate = Number(app.kumiai_amount) > 0 ? (profit / Number(app.kumiai_amount) * 100).toFixed(1) : '0.0'
            const color = profit >= 0 ? 'text-gray-800' : 'text-red-600'
            return `<div><span class="text-gray-400">利益額</span><p class="font-medium ${color}">${profit >= 0 ? '' : '-'}${Math.abs(profit).toLocaleString()}円</p></div>
                    <div><span class="text-gray-400">利益率</span><p class="font-medium ${color}">${rate}％</p></div>`
          })() : ''}
          ${app.remarks ? `<div class="col-span-2"><span class="text-gray-400">備考</span><p class="font-medium">${app.remarks}</p></div>` : ''}
        </div>
        ${(attachments.results as any[]).filter((a: any) => a.file_type !== 'kumiai_invoice').length > 0 ? `
          <div class="mt-4 pt-4 border-t border-gray-100">
            <p class="text-xs text-gray-400 mb-2">添付ファイル</p>
            <div class="flex flex-wrap gap-2">
              ${(attachments.results as any[]).filter((a: any) => a.file_type !== 'kumiai_invoice').map(att => {
                const labels: Record<string, string> = { invoice1: '請求書①', invoice2: '請求書②', invoice3: '請求書③', invoice4: '請求書④', invoice5: '請求書⑤', invoice6: '請求書⑥', other1: '添付①', other2: '添付②' }
                return `<button type="button" onclick="openSavedFilePreview('/files/${att.id}', '${att.file_name.replace(/'/g, "\\'")}')"
                  class="inline-flex items-center gap-1 text-xs text-[#396999] bg-[#EEF4FA] hover:bg-[#D5E5F2] px-2 py-1 rounded">
                  👁 ${labels[att.file_type]}: ${att.file_name}
                </button>`
              }).join('')}
            </div>
          </div>
        ` : ''}
      </div>

      <!-- 差し戻し理由・再申請理由（再申請の場合のみ表示） -->
      ${app.returned_reason ? `
      <div class="bg-red-50 border border-red-200 rounded-xl p-4 space-y-2">
        <p class="text-xs font-semibold text-red-700">⚠️ この申請は差し戻し後の再申請です</p>
        <div>
          <p class="text-xs text-red-500 font-medium">差し戻し理由</p>
          <p class="text-sm text-red-800 bg-white rounded p-2 border border-red-200 mt-1">${app.returned_reason}</p>
        </div>
        ${app.reapply_reason ? `
        <div>
          <p class="text-xs text-purple-500 font-medium">再申請理由・修正内容</p>
          <p class="text-sm text-purple-800 bg-white rounded p-2 border border-purple-200 mt-1">${app.reapply_reason}</p>
        </div>` : ''}
      </div>` : ''}

      ${isMotoukeStep2 ? `
      <!-- 元請の場合: 管理組合宛請求書PDFアップロード -->
      <div class="bg-amber-50 border-2 border-amber-300 rounded-xl p-6">
        <div class="flex items-start gap-3 mb-4">
          <div class="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
            <svg class="w-5 h-5 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          </div>
          <div class="flex-1">
            <h3 class="font-bold text-amber-900 text-base mb-1">📎 管理組合宛請求書（元請セット申請）</h3>
            <p class="text-xs text-amber-800 leading-relaxed">
              元請の場合、業者請求書の回覧と<strong>同時に</strong>管理組合宛請求書の回覧が必要です。<br>
              PDFをアップロードすると、承認時に申請者へ<strong>後続申請Bの作成依頼</strong>が通知されます。
            </p>
          </div>
        </div>
        ${kumiaiInvoiceExists ? `
          <div class="bg-white border border-amber-200 rounded-lg px-4 py-3 mb-3">
            <div class="flex items-center gap-2 text-sm text-green-700 mb-2">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
              <span class="font-semibold">アップロード済み</span>
            </div>
            ${(attachments.results as any[]).filter(a => a.file_type === 'kumiai_invoice').map(a => `
              <div class="text-xs text-gray-600 flex items-center justify-between">
                <button type="button" onclick="openSavedFilePreview('/files/${a.id}', '${a.file_name.replace(/'/g, "\\'")}')"
                  class="text-[#396999] hover:underline flex items-center gap-1">
                  👁 ${a.file_name}
                </button>
                <form method="POST" action="/applications/${id}/kumiai-invoice/delete" class="inline" onsubmit="return confirm('削除しますか？')">
                  <input type="hidden" name="att_id" value="${a.id}">
                  <button type="submit" class="text-xs text-red-500 hover:underline">削除</button>
                </form>
              </div>
            `).join('')}
            <p class="text-xs text-gray-400 mt-2">承認時に申請者へ「後続申請Bの作成依頼」通知が送信されます</p>
          </div>
        ` : ''}
        ${successorApp ? `
          <div class="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 mb-3 text-xs text-blue-800">
            <p class="font-semibold mb-1">🔗 後続申請Bが既に作成されています</p>
            <a href="/applications/${successorApp.id}" class="text-blue-700 hover:underline font-mono">${successorApp.application_number}</a>
            <span class="ml-2">(状態: ${successorApp.status})</span>
          </div>
        ` : ''}
        <form method="POST" action="/applications/${id}/kumiai-invoice/upload" enctype="multipart/form-data" class="space-y-3">
          <input type="file" name="kumiai_invoice" accept="application/pdf,image/*" required
            class="block w-full text-sm text-gray-700 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-amber-100 file:text-amber-800 file:font-semibold hover:file:bg-amber-200">
          <button type="submit"
            class="bg-amber-600 hover:bg-amber-700 text-white font-semibold px-4 py-2 rounded-lg text-sm transition inline-flex items-center gap-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 12V4m0 0L8 8m4-4l4 4"/></svg>
            管理組合宛請求書を${kumiaiInvoiceExists ? '追加' : 'アップロード'}
          </button>
          <p class="text-xs text-gray-500">※ 承認前にアップロードしなくても承認は可能です（後で追加もできます）</p>
        </form>
      </div>
      ` : ''}

      <!-- アクションフォーム -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 class="font-semibold text-gray-800 mb-4">承認アクション</h3>
        <form method="POST" action="/applications/${id}/review/${stepId}" id="reviewForm">
          <input type="hidden" name="action" id="actionInput">
          <input type="hidden" name="comment" id="commentHidden">
          <div class="flex gap-3">
            <button type="button" onclick="submitAction('approve')"
              class="flex-1 bg-green-500 hover:bg-green-600 text-white font-semibold py-3 rounded-lg transition text-sm flex items-center justify-center gap-2">
              ✅ 承認
            </button>
            <button type="button" onclick="openModal('return')"
              class="flex-1 bg-orange-500 hover:bg-orange-600 text-white font-semibold py-3 rounded-lg transition text-sm flex items-center justify-center gap-2">
              ↩ 差し戻し
            </button>
            <!--
              保留ボタン: 業務判断により非表示化中（案B）。復活させる場合は以下のコメントを解除してください。
              関連機能（サーバー側の保留処理、保留回答フォーム、on_holdステータス）は残してあります。
            <button type="button" onclick="openModal('hold')"
              class="flex-1 bg-yellow-500 hover:bg-yellow-600 text-white font-semibold py-3 rounded-lg transition text-sm flex items-center justify-center gap-2">
              ⏸ 保留
            </button>
            -->
          </div>
        </form>
      </div>

      <a href="/applications/${id}" class="text-sm text-gray-500 hover:text-gray-700">← 詳細に戻る</a>
    </div>

    <!-- 差し戻し・保留 モーダル -->
    <div id="actionModal" class="hidden fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h3 id="modalTitle" class="font-bold text-gray-800 text-lg mb-3"></h3>
        <p id="modalDesc" class="text-sm text-gray-500 mb-3"></p>
        <textarea id="modalComment" rows="4" required
          class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-orange-400 outline-none resize-none mb-4"
          placeholder="理由を入力してください（必須）"></textarea>
        <div class="flex gap-3">
          <button type="button" onclick="closeModal()"
            class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2.5 rounded-lg transition text-sm">
            キャンセル
          </button>
          <button type="button" id="modalSubmitBtn" onclick="submitModal()"
            class="flex-1 text-white font-semibold py-2.5 rounded-lg transition text-sm">
            送信する
          </button>
        </div>
      </div>
    </div>

    <script>
      let currentAction = ''

      function submitAction(action) {
        if (action === 'approve' && !confirm('この申請を承認しますか？')) return
        document.getElementById('actionInput').value = action
        document.getElementById('commentHidden').value = ''
        document.getElementById('reviewForm').submit()
      }

      function openModal(action) {
        currentAction = action
        const modal = document.getElementById('actionModal')
        const title = document.getElementById('modalTitle')
        const desc = document.getElementById('modalDesc')
        const btn = document.getElementById('modalSubmitBtn')
        if (action === 'return') {
          title.textContent = '↩ 差し戻し'
          desc.textContent = '差し戻し理由を入力してください。申請者にメールで通知されます。'
          btn.className = btn.className.replace(/bg-\\S+/, '') 
          btn.style.background = '#f97316'
        } else {
          title.textContent = '⏸ 保留（質問）'
          desc.textContent = '質問内容を入力してください。申請者にメールで通知されます。'
          btn.style.background = '#eab308'
        }
        document.getElementById('modalComment').value = ''
        modal.classList.remove('hidden')
        setTimeout(() => document.getElementById('modalComment').focus(), 100)
      }

      function closeModal() {
        document.getElementById('actionModal').classList.add('hidden')
      }

      function submitModal() {
        const comment = document.getElementById('modalComment').value.trim()
        if (!comment) {
          alert('理由を入力してください')
          document.getElementById('modalComment').focus()
          return
        }
        document.getElementById('actionInput').value = currentAction
        document.getElementById('commentHidden').value = comment
        document.getElementById('reviewForm').submit()
      }

      // モーダル外クリックで閉じる
      document.getElementById('actionModal').addEventListener('click', function(e) {
        if (e.target === this) closeModal()
      })
    </script>
  `
  return c.html(layout('承認・差し戻し', content, user))
})

// ============================================================
// 管理組合宛請求書PDFのアップロード（元請セット申請用）
// ============================================================
applications.post('/:id/kumiai-invoice/upload', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const id = c.req.param('id')

  const app = await db.prepare('SELECT * FROM applications WHERE id = ?').bind(id).first() as any
  if (!app) return c.notFound()

  // 元請でない場合は拒否
  if (app.payment_target !== 'td' || app.td_type !== 'motouke') {
    return c.redirect(`/applications/${id}?err=not_motouke`)
  }

  const body = await c.req.parseBody()
  const file = body.kumiai_invoice as File | undefined
  if (!file || file.size === 0) {
    return c.redirect(`/applications/${id}?err=no_file`)
  }

  // R2に保存
  const ext = (file.name.split('.').pop() || 'pdf').toLowerCase()
  const fileKey = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const key = `attachments/${app.application_number}/kumiai_${fileKey}.${ext}`
  await c.env.R2.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/pdf' }
  })

  // attachments に登録
  await db.prepare(
    'INSERT INTO attachments (application_id, file_type, file_name, file_key) VALUES (?, ?, ?, ?)'
  ).bind(id, 'kumiai_invoice', file.name, key).run()

  // 直前のURL（承認画面）に戻す
  const referer = c.req.header('Referer')
  return c.redirect(referer && referer.includes('/review/') ? referer : `/applications/${id}`)
})

// 管理組合宛請求書PDFの削除
applications.post('/:id/kumiai-invoice/delete', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.parseBody() as any
  const attId = body.att_id

  const att = await db.prepare(
    'SELECT * FROM attachments WHERE id = ? AND application_id = ? AND file_type = ?'
  ).bind(attId, id, 'kumiai_invoice').first() as any

  if (att) {
    try { await c.env.R2.delete(att.file_key) } catch {}
    await db.prepare('DELETE FROM attachments WHERE id = ?').bind(attId).run()
  }

  const referer = c.req.header('Referer')
  return c.redirect(referer && referer.includes('/review/') ? referer : `/applications/${id}`)
})

// 手動リマインド送信（申請B作成が滞っている申請者向け）
applications.post('/:id/motouke-remind', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const id = c.req.param('id')

  const app = await db.prepare(`
    SELECT a.*, u.name as applicant_name
    FROM applications a JOIN users u ON a.applicant_id = u.id
    WHERE a.id = ?
  `).bind(id).first() as any
  if (!app) return c.notFound()

  // 元請以外は拒否
  if (app.payment_target !== 'td' || app.td_type !== 'motouke') {
    return c.redirect(`/applications/${id}`)
  }

  // 既に後続Bがある場合はスキップ
  const existingB = await db.prepare(
    'SELECT id FROM applications WHERE original_application_id = ? LIMIT 1'
  ).bind(id).first() as any
  if (existingB) {
    return c.redirect(`/applications/${id}?motouke_remind=already`)
  }

  // 管理組合宛請求書がアップロードされているか確認
  const kumiaiAtt = await db.prepare(
    'SELECT id FROM attachments WHERE application_id = ? AND file_type = ? LIMIT 1'
  ).bind(id, 'kumiai_invoice').first() as any
  if (!kumiaiAtt) {
    return c.redirect(`/applications/${id}?motouke_remind=no_pdf`)
  }

  const origin = new URL(c.req.url).origin
  const newAppUrl = `${origin}/applications/new?from_motouke=${id}`
  const isTestApp = app.is_test === 1

  await sendNotification(db, 'motouke_next', app.applicant_id, {
    appNumber: app.application_number,
    title: app.title,
    applicantName: app.applicant_name,
    appUrl: newAppUrl,
    isTest: isTestApp,
  } as any)

  await db.prepare(
    'INSERT INTO notification_logs (application_id, recipient_id, notification_type, email_to, subject, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, app.applicant_id, 'motouke_next_remind', '', (isTestApp ? '[TEST] ' : '') + `【元請セット申請リマインド】${app.application_number}`, 'sent').run()

  return c.redirect(`/applications/${id}?motouke_remind=ok`)
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
  if (!app) return c.redirect(`/applications/${id}`)

  const appUrl = `${new URL(c.req.url).origin}/applications/${id}`
  const isTestApp = app.is_test === 1

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
      await sendNotification(db, 'review_request', nextStep.reviewer_id, {
        appNumber: app.application_number, title: app.title, applicantName: app.applicant_name, appUrl,
        isTest: isTestApp
      })
    } else {
      // 全ステップ完了
      await db.prepare('UPDATE applications SET status = "completed", updated_at = datetime("now") WHERE id = ?').bind(id).run()
      await sendNotification(db, 'completed', app.applicant_id, {
        appNumber: app.application_number, title: app.title, applicantName: app.applicant_name, appUrl,
        isTest: isTestApp
      })
    }

    // === 元請セット申請: 本橋(step2)承認時に、管理組合宛PDFがアップロードされていれば申請者に後続申請通知 ===
    if (step.step_number === 2 && app.payment_target === 'td' && app.td_type === 'motouke') {
      // 既に後続Bが作成されていないかチェック
      const existingB = await db.prepare(
        'SELECT id FROM applications WHERE original_application_id = ? LIMIT 1'
      ).bind(id).first() as any

      // 管理組合宛請求書がアップロードされているか確認
      const kumiaiAtt = await db.prepare(
        'SELECT id FROM attachments WHERE application_id = ? AND file_type = ? LIMIT 1'
      ).bind(id, 'kumiai_invoice').first() as any

      if (!existingB && kumiaiAtt) {
        const origin = new URL(c.req.url).origin
        const newAppUrl = `${origin}/applications/new?from_motouke=${id}`
        await sendNotification(db, 'motouke_next', app.applicant_id, {
          appNumber: app.application_number,
          title: app.title,
          applicantName: app.applicant_name,
          appUrl: newAppUrl,
          isTest: isTestApp,
        } as any)
        await db.prepare(
          'INSERT INTO notification_logs (application_id, recipient_id, notification_type, email_to, subject, status) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, app.applicant_id, 'motouke_next', app.applicant_email || '',
          (isTestApp ? '[TEST] ' : '') + `【元請セット申請】${app.application_number} - 管理組合宛請求書の申請をお願いします`, 'sent').run()
      }
    }

  } else if (action === 'reject') {
    await db.prepare(
      'UPDATE circulation_steps SET status = "rejected", action_comment = ?, acted_at = datetime("now") WHERE id = ?'
    ).bind(comment, stepId).run()
    await db.prepare('UPDATE applications SET status = "rejected", updated_at = datetime("now") WHERE id = ?').bind(id).run()
    await sendNotification(db, 'rejected', app.applicant_id, {
      appNumber: app.application_number, title: app.title, applicantName: app.applicant_name, comment, appUrl,
      isTest: isTestApp
    })

  } else if (action === 'hold') {
    await db.prepare(
      'UPDATE circulation_steps SET status = "on_hold", action_comment = ?, acted_at = datetime("now") WHERE id = ?'
    ).bind(comment, stepId).run()
    await db.prepare('UPDATE applications SET status = "on_hold", updated_at = datetime("now") WHERE id = ?').bind(id).run()
    await sendNotification(db, 'on_hold', app.applicant_id, {
      appNumber: app.application_number, title: app.title, applicantName: app.applicant_name, comment, appUrl,
      isTest: isTestApp
    })

  } else if (action === 'return') {
    // 差し戻し：申請者に戻す
    await db.prepare(
      'UPDATE circulation_steps SET status = "returned", action_comment = ?, acted_at = datetime("now") WHERE id = ?'
    ).bind(comment, stepId).run()
    await db.prepare(`
      UPDATE applications SET
        status = "returned",
        returned_reason = ?,
        returned_from_step = ?,
        returned_by_id = ?,
        updated_at = datetime("now")
      WHERE id = ?
    `).bind(comment, step.step_number, user.uid, id).run()

    // 申請者へ統合通知（メール + LINE WORKS）
    await sendNotification(db, 'returned', app.applicant_id, {
      appNumber: app.application_number,
      title: app.title,
      applicantName: app.applicant_name,
      returnedReason: comment,
      returnedFromStep: step.step_number,
      returnedByName: user.name,
      appUrl,
      isTest: isTestApp
    })
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

  if (step && app) {
    const appUrl = `${new URL(c.req.url).origin}/applications/${id}`
    await sendNotification(db, 'answered', (step as any).reviewer_id, {
      appNumber: (app as any).application_number,
      title: (app as any).title,
      applicantName: user.name,
      comment: body.answer,
      appUrl
    })
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

  // rejected（否決）または returned（差し戻し）のどちらからも再申請可能
  const orig = await db.prepare(
    'SELECT * FROM applications WHERE id = ? AND applicant_id = ? AND (status = "rejected" OR status = "returned")'
  ).bind(id, user.uid).first() as any
  if (!orig) return c.redirect(`/applications/${id}`)

  const body = await c.req.parseBody({ all: true }) as any
  const reapplyReason = body.reapply_reason || null
  const isReturned = orig.status === 'returned'

  // === 編集後の値を取得（未入力 or フォームから来ていない場合は元申請の値を使用） ===
  const editedTitle = body.title || orig.title
  const editedMansionId = body.mansion_id ? parseInt(body.mansion_id) : orig.mansion_id
  const editedStartDate = body.circulation_start_date || orig.circulation_start_date
  const editedPaymentTarget = body.payment_target || orig.payment_target
  const editedAccountItem = body.account_item !== undefined && body.account_item !== '' ? body.account_item : (editedPaymentTarget === 'kumiai' ? orig.account_item : null)
  const editedTdType = editedPaymentTarget === 'td' ? (body.td_type || orig.td_type) : null
  const editedKumiaiAmount = body.kumiai_amount !== undefined && body.kumiai_amount !== ''
    ? parseInt(String(body.kumiai_amount).replace(/,/g, ''))
    : (editedTdType === 'motouke' ? orig.kumiai_amount : null)
  const editedGyoshaAmount = body.gyosha_amount !== undefined && body.gyosha_amount !== ''
    ? parseInt(String(body.gyosha_amount).replace(/,/g, ''))
    : (editedTdType === 'motouke' ? orig.gyosha_amount : null)
  const editedBudgetAmount = body.budget_amount !== undefined && body.budget_amount !== ''
    ? (parseInt(String(body.budget_amount).replace(/,/g, '')) || 0)
    : orig.budget_amount
  const editedCommissionRate = body.commission_rate !== undefined && body.commission_rate !== ''
    ? parseFloat(body.commission_rate)
    : orig.commission_rate
  const editedRemarks = body.remarks !== undefined ? body.remarks : orig.remarks

  // 手数料バリデーション（管理組合の場合、円か％どちらか必須）
  if (editedPaymentTarget !== 'td') {
    const hasBudget = editedBudgetAmount !== null && editedBudgetAmount !== undefined && editedBudgetAmount !== ''
    const hasCommission = editedCommissionRate !== null && editedCommissionRate !== undefined && !isNaN(editedCommissionRate)
    if (!hasBudget && !hasCommission) {
      return c.redirect(`/applications/new?resubmit_id=${id}&error=fee_required`)
    }
  }

  const newNumber = generateApplicationNumber()
  const result = await db.prepare(`
    INSERT INTO applications (
      application_number, title, mansion_id, applicant_id, circulation_start_date,
      payment_target, account_item, td_type, kumiai_amount, gyosha_amount, budget_amount,
      commission_rate, remarks, status, current_step, resubmit_count, original_application_id,
      returned_reason, reapply_reason, returned_from_step, returned_by_id, is_test
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'circulating', 1, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newNumber, editedTitle, editedMansionId, orig.applicant_id, editedStartDate,
    editedPaymentTarget, editedAccountItem, editedTdType, editedKumiaiAmount, editedGyoshaAmount, editedBudgetAmount,
    editedCommissionRate, editedRemarks, (orig.resubmit_count || 0) + 1, orig.id,
    isReturned ? orig.returned_reason : null,
    reapplyReason,
    isReturned ? orig.returned_from_step : null,
    isReturned ? orig.returned_by_id : null,
    orig.is_test || 0
  ).run()

  const newId = result.meta.last_row_id as number

  // === 添付ファイル処理: 新しいファイルがあればR2にアップロード、なければ元申請の添付をコピー ===
  const origAttachments = (await db.prepare('SELECT * FROM attachments WHERE application_id = ?').bind(id).all()).results as any[]
  const origAttMap: Record<string, any> = {}
  for (const att of origAttachments) {
    origAttMap[att.file_type] = att
  }

  // invoice1〜invoice6, other1, other2 それぞれ処理
  const fileTypes = ['invoice1', 'invoice2', 'invoice3', 'invoice4', 'invoice5', 'invoice6', 'other1', 'other2']
  for (const fileType of fileTypes) {
    const uploaded = body[fileType] as File | undefined
    if (uploaded && uploaded.size > 0) {
      // 新規アップロード: R2に保存
      const ext = uploaded.name.split('.').pop()
      const key = `attachments/${newNumber}/${fileType}.${ext}`
      await c.env.R2.put(key, await uploaded.arrayBuffer(), {
        httpMetadata: { contentType: uploaded.type }
      })
      await db.prepare(
        'INSERT INTO attachments (application_id, file_type, file_name, file_key) VALUES (?, ?, ?, ?)'
      ).bind(newId, fileType, uploaded.name, key).run()
    } else if (origAttMap[fileType]) {
      // 元申請から引き継ぎ（file_keyを共有）
      const orig_att = origAttMap[fileType]
      await db.prepare(
        'INSERT INTO attachments (application_id, file_type, file_name, file_key) VALUES (?, ?, ?, ?)'
      ).bind(newId, fileType, orig_att.file_name, orig_att.file_key).run()
    }
  }

  // kumiai_invoice など、フォームに現れないその他の添付タイプも引き継ぐ
  for (const att of origAttachments) {
    if (!fileTypes.includes(att.file_type)) {
      await db.prepare(
        'INSERT INTO attachments (application_id, file_type, file_name, file_key) VALUES (?, ?, ?, ?)'
      ).bind(newId, att.file_type, att.file_name, att.file_key).run()
    }
  }

  // === 回覧ステップ作成（編集後のフォーム値を優先） ===
  const reviewerStep1 = body.reviewer_step1 ? parseInt(body.reviewer_step1) : null
  const reviewerStep2 = body.reviewer_step2 ? parseInt(body.reviewer_step2) : null
  const reviewerStep3 = body.reviewer_step3 ? parseInt(body.reviewer_step3) : null
  await createCirculationSteps(db, newId, user.uid, editedPaymentTarget, editedMansionId, reviewerStep1, reviewerStep2, reviewerStep3)

  // === 通知送信 ===
  const appUrl = `${new URL(c.req.url).origin}/applications/${newId}`
  if (isReturned) {
    // 差し戻し再申請の場合、全承認者に統合通知
    const steps = await db.prepare(
      'SELECT cs.reviewer_id FROM circulation_steps cs WHERE cs.application_id = ?'
    ).bind(newId).all()
    for (const step of steps.results as any[]) {
      await sendNotification(db, 'reapplied', step.reviewer_id, {
        appNumber: newNumber,
        title: editedTitle,
        applicantName: user.name,
        returnedReason: orig.returned_reason,
        reapplyReason,
        appUrl,
        isTest: orig.is_test === 1
      })
    }
  } else {
    // rejected からの再提出: 最初の承認者にのみ通知（新規申請と同じ挙動）
    const firstStep = await db.prepare(
      'SELECT cs.*, u.email, u.name FROM circulation_steps cs JOIN users u ON cs.reviewer_id = u.id WHERE cs.application_id = ? AND cs.step_number = 1'
    ).bind(newId).first() as any
    if (firstStep) {
      await sendNotification(db, 'review_request', firstStep.reviewer_id, {
        appNumber: newNumber, title: editedTitle, applicantName: user.name, appUrl,
        isTest: orig.is_test === 1
      })
    }
  }

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
