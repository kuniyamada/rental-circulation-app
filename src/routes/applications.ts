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

// ============================================================
// バックグラウンド実行ヘルパー
// Cloudflare Workers の waitUntil() を使い、レスポンス返却後も処理を継続実行させる。
// これにより SMTP / LINE WORKS API 待ちで画面遷移が遅くなるのを防ぐ。
// executionCtx 未対応環境（ローカル wrangler dev の一部モード等）ではフォールバックで
// 単純に Promise を投げて画面遷移を優先する（未await でも処理は継続する）。
// ============================================================
function runInBackground(c: any, task: () => Promise<void>): void {
  const p = (async () => {
    try {
      await task()
    } catch (e) {
      console.error('[BG] バックグラウンドタスクエラー:', e)
    }
  })()
  try {
    c.executionCtx.waitUntil(p)
  } catch {
    // ローカル環境等で executionCtx が使えない場合は投げっぱなし（未 await）
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
  const createdAppNumber = c.req.query('created') || ''  // 新規申請直後のトースト表示用

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

  // 申請直後のトースト表示（HTMLエスケープ）
  const safeCreatedNum = createdAppNumber.replace(/[<>&"']/g, (ch) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[ch] as string)
  )

  const content = `
    ${createdAppNumber ? `
    <!-- 申請完了トースト（数秒後に自動で消える） -->
    <div id="createdToast"
      class="fixed top-20 left-1/2 -translate-x-1/2 z-[70] bg-white border-2 border-emerald-400 shadow-xl rounded-xl px-5 py-3 flex items-center gap-3 max-w-md w-[92%] sm:w-auto transition-opacity duration-500">
      <div class="w-9 h-9 bg-emerald-500 rounded-full flex items-center justify-center flex-shrink-0">
        <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/>
        </svg>
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-bold text-gray-800">申請を送信しました</p>
        <p class="text-xs text-gray-500 truncate">申請番号：${safeCreatedNum}（承認者への通知は数秒以内に送信されます）</p>
      </div>
      <button type="button" onclick="document.getElementById('createdToast')?.remove()"
        class="text-gray-400 hover:text-gray-600 text-xl leading-none px-1">×</button>
    </div>
    <script>
      // 5秒後にフェードアウト、5.5秒後にDOM削除 + URLからパラメータ除去
      (function(){
        setTimeout(function(){
          const t = document.getElementById('createdToast')
          if (t) t.style.opacity = '0'
        }, 5000)
        setTimeout(function(){
          const t = document.getElementById('createdToast')
          if (t) t.remove()
          // クエリからcreatedを除去して履歴を綺麗に（リロードしても再度表示されない）
          try {
            const url = new URL(window.location.href)
            url.searchParams.delete('created')
            window.history.replaceState({}, '', url.toString())
          } catch(e){}
        }, 5500)
      })()
    </script>
    ` : ''}

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
    'SELECT * FROM mansions WHERE is_active = 1 AND is_visible = 1 ORDER BY CAST(mansion_number AS INTEGER)'
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

          <!--
            【非表示】申請者・回覧開始日
              - 申請者: セッションから user.uid で取得するため、画面上の表示欄は不要
              - 回覧開始日: 常に本日を送るため hidden で固定
                (別日設定が必要になった場合は、この2欄をUI表示に戻せば対応可能)
          -->
          <input type="hidden" name="circulation_start_date" value="${today}">

          <!-- 添付ファイル（請求書）① ※必須（②以降は「＋請求書を追加」から動的に追加） -->
          <div class="border border-gray-200 rounded-lg p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-semibold text-gray-700">添付ファイル（請求書）</h3>
              <span id="invoiceExtraHint" class="hidden text-xs text-gray-400"></span>
            </div>
            <!-- ①（必須）＋ ②〜（追加分）を1つのコンテナ内に統一表示 -->
            <div id="invoiceExtraList" class="space-y-3">
              <!-- 請求書① 必須 -->
              <div data-invoice-slot="1">
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
              ${(() => {
                // 再申請の場合: 元申請の invoice2〜invoice6 を初期スロットとして展開（①と同じスタイル）
                const marks = ['②', '③', '④', '⑤', '⑥']
                const slots: string[] = []
                for (let i = 2; i <= 6; i++) {
                  const att = resubmitAttachments.find(a => a.file_type === `invoice${i}`)
                  const mark = marks[i - 2]
                  if (att) {
                    slots.push(`
              <div data-invoice-slot="${i}">
                <div class="flex items-center justify-between mb-1">
                  <label class="block text-xs text-gray-500">添付資料（請求書）${mark}</label>
                  <button type="button" onclick="removeInvoiceSlot(this)"
                    class="inline-flex items-center px-2 py-0.5 border border-red-300 text-red-500 text-xs rounded hover:bg-red-50" title="この欄を削除">× 削除</button>
                </div>
                <div class="mb-2 flex items-center gap-2 px-3 py-2 bg-orange-50 border border-orange-200 rounded-lg">
                  <span class="text-orange-700 text-xs">📎 元申請から引き継ぎ：${att.file_name}</span>
                  <a href="/applications/files/${att.id}" target="_blank" class="text-xs text-[#396999] underline">確認</a>
                  <span class="text-xs text-gray-400 ml-auto">（別ファイル選択で上書き）</span>
                </div>
                <div class="flex items-center gap-2">
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
                return slots.join('')
              })()}
            </div>
            <!-- 追加ボタン（管理組合=最大4枚(①〜④) / 委託内=最大6枚(①〜⑥) / 元請=最大3枚(①〜③)） -->
            <button type="button" id="addInvoiceBtn" onclick="addInvoiceSlot()"
              class="hidden mt-3 inline-flex items-center gap-1 px-3 py-1.5 border border-dashed border-[#396999] text-[#396999] text-xs font-semibold rounded-md hover:bg-[#EEF4FA]">
              ＋ 請求書を追加
            </button>
          </div>

          <!-- 支払先（プルダウン 3択：管理組合 / 会社(TD)委託内 / 会社(TD)元請） -->
          <!--
            内部仕様:
              プルダウンの値は「payment_target|td_type」の合成値:
                'kumiai|'      → payment_target='kumiai', td_type=null
                'td|ittaku'    → payment_target='td',     td_type='ittaku'
                'td|motouke'   → payment_target='td',     td_type='motouke'
              サーバー送信時はhidden inputで元通り payment_target と td_type を分離送信。
              (DB互換性・既存クエリ互換のため保存構造は変えない)
          -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">支払先 <span class="text-red-500">*</span></label>
            <select id="paymentTargetSelect" required onchange="onPaymentSelectChange()"
              class="w-full px-3 py-2.5 border border-gray-300 bg-white rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
              <option value="">選択してください</option>
              <option value="kumiai|">管理組合</option>
              <option value="td|ittaku">会社（TD）委託内</option>
              <option value="td|motouke">会社（TD）元請</option>
            </select>
            <!-- サーバー送信用hidden: プルダウン値から自動セット -->
            <input type="hidden" name="payment_target" id="paymentTargetHidden">
            <input type="hidden" name="td_type" id="tdTypeHidden">
          </div>

          <!-- 管理組合の場合：勘定科目（手入力・20文字上限） -->
          <div id="kumiaiFields" class="hidden bg-green-50 border border-green-200 rounded-lg p-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1.5">勘定科目 <span class="text-red-500">*</span></label>
            <input type="text" name="account_item" maxlength="20"
              placeholder="例: 予備費、小修繕費、修繕費、保険修繕費 など"
              class="w-full px-3 py-2.5 border border-gray-300 bg-white rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none">
            <p class="text-xs text-gray-500 mt-1">20文字以内で入力してください</p>
          </div>

          <!-- TD（会社）の場合: 元請時のみ金額入力を表示 (区分ラジオは削除、プルダウンから決定) -->
          <div id="tdFields" class="hidden bg-[#EEF4FA] border border-[#AECBE5] rounded-lg p-4 space-y-4">
            <!-- 元請の場合：管理組合への請求金額 + 業者への支払金額 -->
            <div id="motoukeFields" class="hidden space-y-3 border-t-2 border-[#5B8AB5] pt-4 mt-2">
              <!-- 元請専用ブロックの見出し -->
              <div class="flex items-center gap-2">
                <span class="inline-flex items-center justify-center w-6 h-6 bg-[#2E5580] text-white rounded-full text-xs font-bold">元</span>
                <p class="text-sm font-bold text-[#2E5580]">元請の金額入力 <span class="text-red-500 text-xs ml-1">※管理組合請求金額は必須</span></p>
              </div>
              <!-- 税込表示の注意書き（元請時のみ表示） -->
              <div class="bg-red-50 border border-red-300 rounded-lg px-3 py-2 flex items-center gap-2">
                <span class="text-lg">⚠️</span>
                <p class="text-sm font-bold text-red-600">管理組合への請求金額は<span class="underline">税込</span>で入力してください</p>
              </div>
              <!-- 金額入力（横並び） -->
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-sm font-semibold text-gray-700 mb-1.5">
                    管理組合への請求金額 <span class="text-red-500">*</span>
                    <span class="text-xs font-bold text-red-600 ml-1">※税込</span>
                  </label>
                  <div class="relative">
                    <input type="text" id="kumiaiAmountDisplay" inputmode="numeric"
                      class="w-full px-3 py-2.5 pr-8 border-2 border-red-300 bg-white rounded-lg text-sm focus:ring-2 focus:ring-red-400 outline-none"
                      placeholder="0" oninput="formatComma(this, 'kumiaiAmount'); calcProfit()">
                    <span class="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">円</span>
                  </div>
                  <input type="hidden" name="kumiai_amount" id="kumiaiAmountHidden">
                </div>
                <div>
                  <label class="block text-sm font-semibold text-gray-700 mb-1.5">業者への支払金額</label>
                  <div class="relative">
                    <input type="text" id="gyoshaAmountDisplay" inputmode="numeric"
                      class="w-full px-3 py-2.5 pr-8 border-2 border-gray-300 bg-white rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none"
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

              <!-- 添付ファイル（見積書）※元請時のみ・任意 -->
              <div class="border border-gray-200 bg-white rounded-lg p-4">
                <div class="flex items-center gap-2 mb-2">
                  <svg class="w-4 h-4 text-[#396999]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
                  </svg>
                  <h4 class="text-sm font-semibold text-gray-700">添付ファイル（見積書）</h4>
                  <span class="text-xs text-gray-400">任意</span>
                </div>
                <p class="text-xs text-gray-500 mb-2">業者から受け取った見積書があれば添付してください（PDF / 画像 / Excel / Word 対応）</p>
                ${(() => {
                  const estAtt = resubmitAttachments.find(a => a.file_type === 'estimate')
                  return estAtt ? `
                <div class="mb-2 flex items-center gap-2 px-3 py-2 bg-orange-50 border border-orange-200 rounded-lg">
                  <span class="text-orange-700 text-xs">📎 元申請から引き継ぎ：${estAtt.file_name}</span>
                  <a href="/applications/files/${estAtt.id}" target="_blank" class="text-xs text-[#396999] underline">確認</a>
                  <span class="text-xs text-gray-400 ml-auto">（別ファイル選択で上書き）</span>
                </div>` : ''
                })()}
                <div class="flex items-center gap-2">
                  <input type="file" name="estimate" id="estimateInput"
                    accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.xlsx,.xls,.docx,.doc,application/pdf,image/*,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"
                    onchange="handleFilePreview(this, 'estimatePreview')"
                    class="flex-1 text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-[#EEF4FA] file:text-[#396999] hover:file:bg-[#D5E5F2]">
                  <button type="button" id="estimatePreview" onclick="openFilePreview('estimateInput')"
                    class="hidden items-center gap-1 px-3 py-1.5 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580]">
                    👁 確認
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 金額 -->
          <div id="amountFields">
            <p class="text-xs text-gray-500 mb-2">手数料の種別を選択してください <span class="text-red-500">*</span></p>

            <!-- 三択ラジオ（円 / ％ / なし）-->
            <div class="flex flex-wrap gap-4 mb-3">
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="fee_type" value="amount" onchange="updateFeeTypeUI()"
                  class="w-4 h-4 text-[#396999]">
                <span class="text-sm">手数料（円）</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="fee_type" value="rate" onchange="updateFeeTypeUI()"
                  class="w-4 h-4 text-[#396999]">
                <span class="text-sm">手数料（％）</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="fee_type" value="none" onchange="updateFeeTypeUI()"
                  class="w-4 h-4 text-[#396999]">
                <span class="text-sm">なし</span>
              </label>
            </div>

            <!-- 入力欄（選ばれた種別のみ有効化） -->
            <div class="grid grid-cols-2 gap-4">
              <div id="feeAmountBox" class="opacity-40">
                <label class="block text-sm font-semibold text-gray-700 mb-1.5">手数料（円）</label>
                <div class="relative">
                  <input type="text" id="budgetAmountInput" inputmode="numeric" disabled
                    class="w-full px-3 py-2.5 pr-8 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none bg-gray-50"
                    placeholder="0" oninput="formatComma(this, 'budget_amount'); validateFeeFields()">
                  <input type="hidden" name="budget_amount" id="budgetAmountHidden">
                  <span class="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">円</span>
                </div>
              </div>
              <div id="feeRateBox" class="opacity-40">
                <label class="block text-sm font-semibold text-gray-700 mb-1.5">手数料（％）</label>
                <div class="relative">
                  <input type="number" id="commissionRateInput" name="commission_rate" min="0" max="100" step="0.1" disabled
                    class="w-full px-3 py-2.5 pr-8 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none bg-gray-50"
                    placeholder="0" oninput="validateFeeFields()">
                  <span class="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
                </div>
              </div>
            </div>
            <p id="feeValidationMsg" class="hidden text-xs text-red-500 mt-1.5">⚠ 手数料の種別を選択し、必要な金額/率を入力してください</p>
            <p id="feeNoneMsg" class="hidden text-xs text-gray-600 mt-1.5 bg-gray-50 border border-gray-200 rounded px-2 py-1.5">ℹ️ 手数料なし（0円）として申請されます</p>
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
              <!-- マンション選択時、上長がマスタ未設定/候補外だと表示される警告 -->
              <p id="step1MansionWarn" class="hidden mt-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5"></p>
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
              <!-- 役割選択（hidden化）
                   支払先プルダウンから支払先を選ぶと、syncStep3FromPaymentTarget() が
                   自動でこのラジオをチェックし、updateStep3Users() でプルダウン再構築する仕組み。
                   ユーザーがこのラジオを直接触ることは無いため hidden にしている。
                   （役割の内部状態管理と、updateStep3Users() の切り替えロジックはそのまま使うため
                    DOMは残す）-->
              <div class="hidden">
                <label>
                  <input type="radio" name="reviewer_step3_role" value="accounting" required
                    onchange="updateStep3Users(); applyMansionDefaultsFromInput(); updateReviewerPreview()">
                  マンション会計課
                </label>
                <label>
                  <input type="radio" name="reviewer_step3_role" value="honsha"
                    onchange="updateStep3Users(); applyMansionDefaultsFromInput(); updateReviewerPreview()">
                  本社経理
                </label>
              </div>
              <!-- 担当者プルダウン -->
              <select name="reviewer_step3" id="step3UserSelect" required
                onchange="updateReviewerPreview()"
                class="w-full px-3 py-2.5 border ${isTestMode ? 'border-yellow-300 bg-yellow-50' : 'border-gray-300 bg-white'} rounded-lg text-sm focus:ring-2 focus:ring-purple-500 outline-none">
                <option value="">先に支払先を選択してください</option>
              </select>
              <!-- マンション選択時、会計担当がマスタ未設定/候補外だと表示される警告（マンション会計課選択時のみ） -->
              <p id="step3MansionWarn" class="hidden mt-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5"></p>
            </div>
          </div>

          <!--
            【削除】送信先（承認順）プレビューブロック
              - 上部の Step1〜Step3 プルダウンで既に担当者名が見えているため冗長
              - 支払先→Step3自動連動で確認欲求も減った
              - 削除して縦スクロールを短縮
              - updateReviewerPreview() 関数は他所からの呼び出しが多いため
                中身を no-op 化した形で残置（下部 script 参照）
          -->

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
        // 請求書追加ボタン・ヒントの初期表示（支払先未選択なら追加ボタン非表示）
        if (typeof updateInvoiceExtraUI === 'function') updateInvoiceExtraUI()
      })

      // マンションデータをJSに埋め込み
      //   supervisor_user_id / accounting_user_id はマンション選択時に
      //   Step1(上長) / Step3(会計課) のプルダウンを自動セットするために使用
      const MANSIONS = ${JSON.stringify(
        (mansions.results as any[]).map((m: any) => ({
          id: m.id,
          number: m.mansion_number,
          name: m.name,
          supervisor_user_id: m.supervisor_user_id || null,
          accounting_user_id: m.accounting_user_id || null,
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
          // 2) 支払先 (プルダウン方式: 'kumiai|' / 'td|ittaku' / 'td|motouke')
          //    payment_target と td_type から合成値を作ってプルダウンをセット
          const payTarget = ${JSON.stringify(resubmitSource.payment_target || '')}
          const tdType    = ${JSON.stringify(resubmitSource.td_type || '')}
          if (payTarget) {
            if (typeof selectPaymentTarget === 'function') {
              selectPaymentTarget(payTarget, tdType)
            }
          }
          // 4) 勘定科目（管理組合の場合）
          const accountItem = ${JSON.stringify(resubmitSource.account_item || '')}
          if (accountItem) {
            setTimeout(function() {
              // 勘定科目は 手入力(input) に変更したのでvalueをそのままセット
              const acctInput = document.querySelector('input[name="account_item"]')
              if (acctInput) acctInput.value = accountItem
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
          //    三択ラジオ (fee_type) を元申請の状態から復元:
          //      - commission_rate が入っていた → 'rate'
          //      - budget_amount が入っていた (>0) → 'amount'
          //      - 両方0/null → 'none'
          const budgetAmt = ${resubmitSource.budget_amount != null ? resubmitSource.budget_amount : 'null'}
          const commissionRate = ${resubmitSource.commission_rate != null ? resubmitSource.commission_rate : 'null'}
          setTimeout(function() {
            if (payTarget === 'td') return  // 会社(TD)は手数料欄非表示のため何もしない

            // まず種別ラジオを復元
            let feeType = 'none'
            if (commissionRate != null) feeType = 'rate'
            else if (budgetAmt != null && Number(budgetAmt) > 0) feeType = 'amount'

            const radio = document.querySelector('input[name="fee_type"][value="' + feeType + '"]')
            if (radio) {
              radio.checked = true
              if (typeof updateFeeTypeUI === 'function') updateFeeTypeUI()
            }

            // 次に入力値を復元（updateFeeTypeUIで欄が有効化された後）
            setTimeout(function() {
              if (feeType === 'amount' && budgetAmt != null) {
                const bInput = document.getElementById('budgetAmountInput')
                const bHidden = document.getElementById('budgetAmountHidden')
                if (bInput) bInput.value = Number(budgetAmt).toLocaleString()
                if (bHidden) bHidden.value = String(budgetAmt)
              }
              if (feeType === 'rate' && commissionRate != null) {
                const cInput = document.getElementById('commissionRateInput')
                if (cInput) cInput.value = String(commissionRate)
              }
              if (typeof validateFeeFields === 'function') validateFeeFields()
            }, 30)
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
          if (typeof selectPaymentTarget === 'function') {
            selectPaymentTarget('kumiai', null)
          }
          // 支払先プルダウンを無効化（変更不可）
          const paySel = document.getElementById('paymentTargetSelect')
          if (paySel) paySel.disabled = true

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
          ? '<option value="">先に支払先を選択してください</option>'
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

      // 支払先プルダウン変更時のハンドラ
      //   プルダウン値は 'kumiai|' / 'td|ittaku' / 'td|motouke' / '' (未選択)
      //   → hidden の payment_target と td_type を更新
      //   → togglePaymentFields() で表示切替、Step3自動連動、手数料表示切替も全部走る
      function onPaymentSelectChange() {
        const sel = document.getElementById('paymentTargetSelect')
        const val = sel?.value || ''
        const [payTarget, tdType] = val.split('|')
        const payHidden = document.getElementById('paymentTargetHidden')
        const tdHidden = document.getElementById('tdTypeHidden')
        if (payHidden) payHidden.value = payTarget || ''
        if (tdHidden)  tdHidden.value  = tdType || ''
        // 表示切替＋各種連動処理
        togglePaymentFields()
        // 元請の場合は toggleMotouke() で金額入力エリアを表示
        toggleMotouke()
      }

      // 支払先プルダウンに値を設定するヘルパー
      //   (再申請 prefill や 元請セット申請B の自動セットで使用)
      function selectPaymentTarget(payTarget, tdType) {
        const compositeValue = payTarget === 'kumiai'
          ? 'kumiai|'
          : payTarget === 'td' ? ('td|' + (tdType || '')) : ''
        const sel = document.getElementById('paymentTargetSelect')
        if (sel) {
          sel.value = compositeValue
          onPaymentSelectChange()
        }
      }

      // 【現在は呼ばれていません】旧: 支払先ラジオ切替用の関数
      //   プルダウン化に伴い selectPaymentTarget() に置換
      //   将来同様の用途があれば selectPaymentTarget を使用
      function setPaymentTarget(val) {
        selectPaymentTarget(val, null)
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
          // マンションクリア時は担当者の自動セットも解除
          applyMansionDefaults(null);
          return;
        }

        const found = MANSIONS.find(m => m.number === num);
        if (found) {
          resultEl.innerHTML = '<span class="text-[#2E5580] font-bold text-base mr-2">' + found.number + '</span><span class="font-semibold text-gray-800">' + found.name + '</span>';
          resultEl.className = 'px-3 py-2.5 border-2 border-[#5B8AB5] rounded-lg text-sm bg-[#EEF4FA] min-h-[42px] flex items-center gap-1';
          notFoundEl.classList.add('hidden');
          idInput.value = found.id;
          titleInput.value = found.name;
          // マンションマスタから 上長 / 会計担当 を自動セット
          applyMansionDefaults(found);
          updateReviewerPreview();
        } else {
          resultEl.textContent = '番号を入力するとマンション名が表示されます';
          resultEl.className = 'px-3 py-2.5 border border-dashed border-gray-300 rounded-lg text-sm text-gray-400 bg-gray-50 min-h-[42px] flex items-center';
          notFoundEl.classList.remove('hidden');
          idInput.value = '';
          titleInput.value = '';
          applyMansionDefaults(null);
          updateReviewerPreview();
        }
      }

      // マンション選択時に Step1(上長) と Step3(会計課選択時) を自動セットする
      //   - マンションマスタの supervisor_user_id / accounting_user_id を使用
      //   - 未設定時はプルダウンを空に戻し、警告メッセージを表示
      //   - Step3の役割が「本社経理」の場合は Step3 を触らない（山崎修が既定選択されている）
      //   - マンション変更は常に上書き（前のマンションの担当者は残さない）
      function applyMansionDefaults(mansion) {
        // ---- Step1: 上長 ----
        const step1Sel = document.querySelector('select[name="reviewer_step1"]');
        const step1Warn = document.getElementById('step1MansionWarn');
        if (step1Sel) {
          if (!mansion) {
            // マンションクリア時: プルダウンも初期化
            step1Sel.value = '';
            if (step1Warn) step1Warn.classList.add('hidden');
          } else if (mansion.supervisor_user_id) {
            // 上長を自動選択（候補に存在すれば）
            const optExists = Array.from(step1Sel.options).some(o => o.value === String(mansion.supervisor_user_id));
            if (optExists) {
              step1Sel.value = String(mansion.supervisor_user_id);
              if (step1Warn) step1Warn.classList.add('hidden');
            } else {
              // 候補外（テスト用の別ロール等）→ 空にしておく
              step1Sel.value = '';
              if (step1Warn) {
                step1Warn.textContent = 'ℹ️ このマンションの上長はプルダウン候補外のため、手動で選択してください';
                step1Warn.classList.remove('hidden');
              }
            }
          } else {
            // マンションに上長が未設定
            step1Sel.value = '';
            if (step1Warn) {
              step1Warn.innerHTML = '⚠️ このマンションには上長が未設定です。<a href="/admin/mansions" target="_blank" class="underline font-semibold">マンション管理マスタ</a>で設定してください';
              step1Warn.classList.remove('hidden');
            }
          }
        }

        // ---- Step3: 会計課選択時のみ ----
        const step3RoleRadio = document.querySelector('input[name="reviewer_step3_role"]:checked');
        const step3Sel = document.getElementById('step3UserSelect');
        const step3Warn = document.getElementById('step3MansionWarn');
        // 役割が「マンション会計課(accounting)」以外なら何もしない
        if (step3RoleRadio && step3RoleRadio.value === 'accounting' && step3Sel) {
          if (!mansion) {
            // マンションクリア時: プルダウンも初期化
            step3Sel.value = '';
            if (step3Warn) step3Warn.classList.add('hidden');
          } else if (mansion.accounting_user_id) {
            const optExists = Array.from(step3Sel.options).some(o => o.value === String(mansion.accounting_user_id));
            if (optExists) {
              step3Sel.value = String(mansion.accounting_user_id);
              if (step3Warn) step3Warn.classList.add('hidden');
            } else {
              step3Sel.value = '';
              if (step3Warn) {
                step3Warn.textContent = 'ℹ️ このマンションの会計担当はプルダウン候補外のため、手動で選択してください';
                step3Warn.classList.remove('hidden');
              }
            }
          } else {
            // マンションに会計担当が未設定
            step3Sel.value = '';
            if (step3Warn) {
              step3Warn.innerHTML = '⚠️ このマンションには会計担当が未設定です。<a href="/admin/mansions" target="_blank" class="underline font-semibold">マンション管理マスタ</a>で設定してください';
              step3Warn.classList.remove('hidden');
            }
          }
        } else if (step3Warn) {
          // 本社経理選択時は警告を隠す
          step3Warn.classList.add('hidden');
        }
      }

      // ラジオ変更時などから呼ぶ「現在選択中のマンションで再適用」ヘルパー
      function applyMansionDefaultsFromInput() {
        const idInput = document.getElementById('mansionIdInput');
        if (idInput && idInput.value) {
          const mansionId = parseInt(idInput.value);
          const mansion = MANSIONS.find(m => m.id === mansionId);
          if (mansion) applyMansionDefaults(mansion);
        } else {
          applyMansionDefaults(null);
        }
      }

      // 現在の支払先/区分に応じた請求書の追加上限（①を含めた総数）を返す
      // - 管理組合(kumiai) → 最大4枚 (①〜④)
      // - 会社(TD) 委託内(ittaku) → 最大6枚 (①〜⑥)
      // - 会社(TD) 元請(motouke) → 最大3枚 (①〜③)
      // - それ以外（未選択）→ 1枚のみ（①のみ、②以降の追加不可）
      function getMaxInvoiceSlots() {
        const pay = document.getElementById('paymentTargetHidden')?.value
        const td  = document.getElementById('tdTypeHidden')?.value
        if (pay === 'kumiai') return 4
        if (pay === 'td' && td === 'ittaku') return 6
        if (pay === 'td' && td === 'motouke') return 3
        return 1
      }

      // 追加ボタン・ヒント表示の更新（拡張可否を反映）
      // 注意: ①スロットは常に存在し保護される。②以降のみ追加/削除の対象。
      function updateInvoiceExtraUI() {
        const max = getMaxInvoiceSlots()
        const addBtn = document.getElementById('addInvoiceBtn')
        const hint = document.getElementById('invoiceExtraHint')
        const list = document.getElementById('invoiceExtraList')
        if (!list) return
        // ①を含む全スロット数
        const existing = list.querySelectorAll('[data-invoice-slot]').length
        // 追加不可(max=1) or 上限達 → 追加ボタン非表示
        const canAdd = max > 1 && existing < max
        if (addBtn) addBtn.classList.toggle('hidden', !canAdd)
        if (hint) {
          if (max > 1) {
            hint.textContent = '最大' + max + '枚まで追加できます（現在 ' + existing + ' 枚）'
            hint.classList.remove('hidden')
          } else {
            hint.classList.add('hidden')
          }
        }
        // 現在の枠数が上限を超えている場合は超過分を削除（支払先切替時のクリーンアップ）
        // ①(slot=1)は絶対に消さない
        if (existing > max) {
          list.querySelectorAll('[data-invoice-slot]').forEach(function(el) {
            const slot = parseInt(el.getAttribute('data-invoice-slot'))
            if (slot > max) el.remove()
          })
        }
      }

      // 見積書入力欄をクリア (元請以外に切り替えたとき)
      function clearEstimateInput() {
        const est = document.getElementById('estimateInput')
        if (est) est.value = ''
        const btn = document.getElementById('estimatePreview')
        if (btn) {
          btn.classList.add('hidden')
          btn.classList.remove('flex')
        }
      }

      function togglePaymentFields() {
        // 新: プルダウン方式に伴い hidden input 経由で値を取得
        const val = document.getElementById('paymentTargetHidden')?.value || ''
        document.getElementById('kumiaiFields').classList.toggle('hidden', val !== 'kumiai')
        document.getElementById('tdFields').classList.toggle('hidden', val !== 'td')
        if (val !== 'td') {
          document.getElementById('motoukeFields').classList.add('hidden')
          clearEstimateInput()
        }
        // 会社（TD）選択時は手数料を非表示
        document.getElementById('amountFields').classList.toggle('hidden', val === 'td')
        // TD選択時はrequiredを完全解除（手数料バリデーションはcheckFeeRequired()で行う）
        const budgetInput = document.querySelector('input[name="budget_amount"]')
        if (budgetInput) budgetInput.required = false
        // TD選択時: 手数料の種別ラジオと入力値をクリア（あとで管理組合に戻ったときに前の値が残らないよう）
        if (val === 'td') {
          document.querySelectorAll('input[name="fee_type"]').forEach(function(r) { r.checked = false })
          const bi = document.getElementById('budgetAmountInput')
          const bh = document.getElementById('budgetAmountHidden')
          const ci = document.getElementById('commissionRateInput')
          if (bi) bi.value = ''
          if (bh) bh.value = ''
          if (ci) ci.value = ''
          const nMsg = document.getElementById('feeNoneMsg')
          const vMsg = document.getElementById('feeValidationMsg')
          nMsg?.classList.add('hidden')
          vMsg?.classList.add('hidden')
        } else {
          // 管理組合に切り替わったら三択UIを初期状態に整える
          if (typeof updateFeeTypeUI === 'function') updateFeeTypeUI()
        }
        // 支払先 → Step3(最終承認先) の自動連動:
        //   - 管理組合 → 役割「マンション会計課」を自動選択
        //                担当者はマンション未選択なら空、選択済みなら会計担当を自動セット
        //   - 会社(TD) → 役割「本社経理」を自動選択
        //                担当者は山崎 修 (無効時は本社経理ロールの先頭) を自動セット
        //   ※ この連動によりユーザーの手動選択も上書きされる (推奨案どおり)
        if (typeof syncStep3FromPaymentTarget === 'function') {
          syncStep3FromPaymentTarget(val)
        }
        // 請求書追加UIの表示を更新
        updateInvoiceExtraUI()
        updateReviewerPreview()
      }

      // 支払先 → Step3 (最終承認先) の自動連動
      //   management_organization → 'accounting' (マンション会計課)
      //   company (TD)           → 'honsha' (本社経理)
      function syncStep3FromPaymentTarget(paymentVal) {
        let targetRole = null
        if (paymentVal === 'kumiai') targetRole = 'accounting'
        else if (paymentVal === 'td') targetRole = 'honsha'
        else return  // 支払先未選択時は何もしない

        // 役割ラジオを自動選択
        const roleRadio = document.querySelector('input[name="reviewer_step3_role"][value="' + targetRole + '"]')
        if (!roleRadio) return
        if (!roleRadio.checked) {
          roleRadio.checked = true
        }
        // プルダウンを役割に応じて再構築 (updateStep3Users内で本社経理選択時は山崎修自動セット)
        if (typeof updateStep3Users === 'function') updateStep3Users()
        // マンション会計課の場合はマンション情報から担当者を自動セット
        if (targetRole === 'accounting') {
          if (typeof applyMansionDefaultsFromInput === 'function') applyMansionDefaultsFromInput()
        }
      }
      function toggleMotouke() {
        // 新: プルダウン方式に伴い hidden input 経由で値を取得
        const val = document.getElementById('tdTypeHidden')?.value || ''
        document.getElementById('motoukeFields').classList.toggle('hidden', val !== 'motouke')
        // 元請以外に切り替えたら見積書入力欄をクリア
        if (val !== 'motouke') clearEstimateInput()
        // 請求書追加UIの表示を更新（委託内=5枠、元請=追加不可）
        updateInvoiceExtraUI()
        calcProfit()
      }

      // 請求書スロットの動的追加（①と同じA案スタイルで②以降を追加）
      // 上限: 管理組合=4枚(①〜④) / 委託内=6枚(①〜⑥) / 元請=3枚(①〜③)
      function addInvoiceSlot() {
        const list = document.getElementById('invoiceExtraList')
        if (!list) return
        const max = getMaxInvoiceSlots()
        // 現在のスロット数（①を含む）
        const existing = list.querySelectorAll('[data-invoice-slot]').length
        if (existing >= max) return
        const newSlot = existing + 1  // 既存が1(=①のみ)なら次は2、既存が2なら3…
        const marks = ['①', '②', '③', '④', '⑤', '⑥']
        const mark = marks[newSlot - 1] || ('' + newSlot)
        const wrap = document.createElement('div')
        wrap.setAttribute('data-invoice-slot', String(newSlot))
        wrap.innerHTML =
          '<div class="flex items-center justify-between mb-1">' +
            '<label class="block text-xs text-gray-500">添付資料（請求書）' + mark + '</label>' +
            '<button type="button" onclick="removeInvoiceSlot(this)" ' +
              'class="inline-flex items-center px-2 py-0.5 border border-red-300 text-red-500 text-xs rounded hover:bg-red-50" title="この欄を削除">' +
              '× 削除</button>' +
          '</div>' +
          '<div class="flex items-center gap-2">' +
            '<input type="file" name="invoice' + newSlot + '" accept=".pdf,.jpg,.jpeg,.png" id="invoice' + newSlot + 'Input" ' +
              'onchange="handleFilePreview(this, \\'invoice' + newSlot + 'Preview\\')" ' +
              'class="flex-1 text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-[#EEF4FA] file:text-[#396999] hover:file:bg-[#D5E5F2]">' +
            '<button type="button" id="invoice' + newSlot + 'Preview" onclick="openFilePreview(\\'invoice' + newSlot + 'Input\\')" ' +
              'class="hidden items-center gap-1 px-3 py-1.5 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580]">' +
              '👁 確認</button>' +
          '</div>'
        list.appendChild(wrap)
        updateInvoiceExtraUI()
      }

      // 動的追加された請求書スロットを削除して番号を再採番（①は削除不可）
      function removeInvoiceSlot(btn) {
        const row = btn.closest('[data-invoice-slot]')
        if (!row) return
        const slotNum = parseInt(row.getAttribute('data-invoice-slot'))
        if (slotNum === 1) return  // ①は保護
        row.remove()
        // 再採番: ①はそのまま、②以降を詰め直す
        const list = document.getElementById('invoiceExtraList')
        const rows = list.querySelectorAll('[data-invoice-slot]')
        const marks = ['①', '②', '③', '④', '⑤', '⑥']
        rows.forEach(function(r, idx) {
          const slot = idx + 1  // 1,2,3,4,5,6
          if (slot === 1) return  // ①は変更しない
          r.setAttribute('data-invoice-slot', String(slot))
          const mark = marks[slot - 1] || ('' + slot)
          const label = r.querySelector('label')
          if (label) label.textContent = '添付資料（請求書）' + mark
          const input = r.querySelector('input[type="file"]')
          if (input) {
            input.name = 'invoice' + slot
            input.id = 'invoice' + slot + 'Input'
            input.setAttribute('onchange', "handleFilePreview(this, 'invoice" + slot + "Preview')")
          }
          // 「👁 確認」ボタン（プレビュー）を探して更新
          const previewBtn = r.querySelector('button[id^="invoice"]')
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

      // 手数料の種別ラジオ (amount / rate / none) に応じて入力欄の enable/disable を切り替え
      function updateFeeTypeUI() {
        const feeType = document.querySelector('input[name="fee_type"]:checked')?.value
        const amountBox = document.getElementById('feeAmountBox')
        const rateBox = document.getElementById('feeRateBox')
        const budgetEl = document.getElementById('budgetAmountInput')
        const budgetHidden = document.getElementById('budgetAmountHidden')
        const commissionEl = document.getElementById('commissionRateInput')
        const noneMsg = document.getElementById('feeNoneMsg')
        const validMsg = document.getElementById('feeValidationMsg')

        if (!amountBox || !rateBox) return

        const setEnabled = (box, input, enabled) => {
          if (enabled) {
            box.classList.remove('opacity-40')
            input.disabled = false
            input.classList.remove('bg-gray-50')
          } else {
            box.classList.add('opacity-40')
            input.disabled = true
            input.classList.add('bg-gray-50')
            input.value = ''
          }
        }

        if (feeType === 'amount') {
          setEnabled(amountBox, budgetEl, true)
          setEnabled(rateBox, commissionEl, false)
          if (budgetHidden) budgetHidden.value = ''
          noneMsg?.classList.add('hidden')
          budgetEl.focus()
        } else if (feeType === 'rate') {
          setEnabled(amountBox, budgetEl, false)
          setEnabled(rateBox, commissionEl, true)
          if (budgetHidden) budgetHidden.value = ''
          noneMsg?.classList.add('hidden')
          commissionEl.focus()
        } else if (feeType === 'none') {
          setEnabled(amountBox, budgetEl, false)
          setEnabled(rateBox, commissionEl, false)
          if (budgetHidden) budgetHidden.value = ''
          noneMsg?.classList.remove('hidden')
        } else {
          // 未選択
          setEnabled(amountBox, budgetEl, false)
          setEnabled(rateBox, commissionEl, false)
          if (budgetHidden) budgetHidden.value = ''
          noneMsg?.classList.add('hidden')
        }
        // 選択が変わったらエラーメッセージも消す
        validMsg?.classList.add('hidden')
        budgetEl?.classList.remove('border-red-400')
        commissionEl?.classList.remove('border-red-400')
      }

      // 入力途中のバリデーション: 種別に応じて必要な入力があるかチェック
      function validateFeeFields() {
        const amountFields = document.getElementById('amountFields')
        if (amountFields.classList.contains('hidden')) return
        const feeType = document.querySelector('input[name="fee_type"]:checked')?.value
        const msg = document.getElementById('feeValidationMsg')
        const budgetEl = document.getElementById('budgetAmountInput')
        const commissionEl = document.getElementById('commissionRateInput')
        // ブラウザネイティブrequiredは常に無効化（独自バリデーションで統一）
        budgetEl.required = false
        commissionEl.required = false

        if (feeType === 'none' || !feeType) {
          msg?.classList.add('hidden')
          budgetEl.classList.remove('border-red-400')
          commissionEl.classList.remove('border-red-400')
          return
        }

        const budget = document.getElementById('budgetAmountHidden')?.value ||
                       budgetEl?.value.replace(/,/g, '')
        const commission = commissionEl?.value

        let hasValue = false
        if (feeType === 'amount') {
          hasValue = budget !== '' && budget !== null && budget !== undefined
        } else if (feeType === 'rate') {
          hasValue = commission !== '' && commission !== null && commission !== undefined
        }

        if (!hasValue) {
          msg?.classList.remove('hidden')
          if (feeType === 'amount') budgetEl.classList.add('border-red-400')
          if (feeType === 'rate')   commissionEl.classList.add('border-red-400')
        } else {
          msg?.classList.add('hidden')
          budgetEl.classList.remove('border-red-400')
          commissionEl.classList.remove('border-red-400')
        }
      }

      // 送信時の最終バリデーション
      function checkFeeRequired() {
        const amountFields = document.getElementById('amountFields')
        if (amountFields.classList.contains('hidden')) return true
        const feeType = document.querySelector('input[name="fee_type"]:checked')?.value
        const msg = document.getElementById('feeValidationMsg')

        // Q1: 種別自体が未選択 → NG
        if (!feeType) {
          if (msg) {
            msg.textContent = '⚠ 手数料の種別（円 / ％ / なし）を選択してください'
            msg.classList.remove('hidden')
          }
          document.querySelector('input[name="fee_type"]')?.focus()
          return false
        }
        // Q2: なし → OK
        if (feeType === 'none') return true

        // Q3: 円/％の場合、対応する入力欄に値があるか
        const budget = document.getElementById('budgetAmountHidden')?.value ||
                       document.getElementById('budgetAmountInput')?.value.replace(/,/g, '')
        const commission = document.getElementById('commissionRateInput')?.value
        let hasValue = false
        let focusEl = null
        if (feeType === 'amount') {
          hasValue = budget !== '' && budget !== null && budget !== undefined
          focusEl = document.getElementById('budgetAmountInput')
        } else if (feeType === 'rate') {
          hasValue = commission !== '' && commission !== null && commission !== undefined
          focusEl = document.getElementById('commissionRateInput')
        }

        if (!hasValue) {
          if (msg) {
            msg.textContent = feeType === 'amount'
              ? '⚠ 手数料（円）に金額を入力してください'
              : '⚠ 手数料（％）に率を入力してください'
            msg.classList.remove('hidden')
          }
          validateFeeFields()
          focusEl?.focus()
          return false
        }
        return true
      }

      // 【no-op化】送信先（承認順）プレビューブロック削除に伴い、
      //   updateReviewerPreview() は何もしない関数として残置
      //   （togglePaymentFields/updateStep3Users/onchange 等 多数の呼び出し元の
      //    互換維持のため関数定義自体は残す）
      //   将来プレビュー復活が必要になった場合はここに実装を戻す
      function updateReviewerPreview() {
        // no-op
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

  // 手数料バリデーション（管理組合の場合、種別3択(amount/rate/none)の必須チェック）
  //   元請セット申請Bは金額自動設定のためスキップ
  if (body.payment_target !== 'td' && !fromMotoukeId) {
    const feeType = body.fee_type
    if (!feeType || !['amount', 'rate', 'none'].includes(String(feeType))) {
      return c.redirect('/applications/new?error=fee_type_required')
    }
    if (feeType === 'amount') {
      const hasBudget = body.budget_amount !== '' && body.budget_amount != null
      if (!hasBudget) return c.redirect('/applications/new?error=fee_amount_required')
    } else if (feeType === 'rate') {
      const hasCommission = body.commission_rate !== '' && body.commission_rate != null
      if (!hasCommission) return c.redirect('/applications/new?error=fee_rate_required')
    }
    // 'none' の場合はチェック不要（この後の INSERT で両方 NULL / 0 になる）
  }

  // 勘定科目バリデーション（管理組合の場合、手入力・20文字上限）
  //   元請セット申請Bは自動設定のためスキップ
  if (body.payment_target === 'kumiai' && !fromMotoukeId) {
    const accountItem = String(body.account_item || '').trim()
    if (!accountItem) {
      return c.redirect('/applications/new?error=account_item_required')
    }
    if (accountItem.length > 20) {
      return c.redirect('/applications/new?error=account_item_too_long')
    }
  }

  // ファイル保存（R2）
  const fileKeys: Record<string, string> = {}
  const fileNames: Record<string, string> = {}

  // inbox引き継ぎファイルがあり、新規ファイル未選択の場合はinboxのファイルをそのまま使用
  const inboxAttachmentKey = body.inbox_attachment_key || null
  const inboxAttachmentName = body.inbox_attachment_name || null

  // 委託内時に動的追加された invoice3〜invoice6 も保存対象に含める（最大5枠 invoice2〜invoice6）
  // estimate: 元請時のみ任意添付される見積書（1枚）
  for (const fileKey of ['invoice1', 'invoice2', 'invoice3', 'invoice4', 'invoice5', 'invoice6', 'other1', 'other2', 'estimate']) {
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
  // 手数料の三択(amount/rate/none)に応じて budget_amount / commission_rate を決定
  //   - amount: budget_amount = 入力値, commission_rate = NULL
  //   - rate:   budget_amount = 0,      commission_rate = 入力値
  //   - none:   budget_amount = 0,      commission_rate = NULL
  //   - TD/元請B: 従来ロジックで自動計算 (fee_type 無関係)
  const feeType = body.fee_type
  const rawBudget = parseInt(String(body.budget_amount || '0').replace(/,/g, '')) || 0
  const rawCommission = body.commission_rate !== '' && body.commission_rate != null
    ? parseFloat(body.commission_rate) : null

  let effectiveBudgetAmount: number
  let effectiveCommissionRate: number | null
  if (fromMotoukeId) {
    // 元請セット申請B: 元申請の金額をそのまま使用
    effectiveBudgetAmount = motoukeSource?.kumiai_amount || 0
    effectiveCommissionRate = null
  } else if (body.payment_target === 'td') {
    // 会社(TD): 従来通り（画面上、手数料欄は非表示）
    effectiveBudgetAmount = rawBudget
    effectiveCommissionRate = rawCommission
  } else if (feeType === 'amount') {
    effectiveBudgetAmount = rawBudget
    effectiveCommissionRate = null
  } else if (feeType === 'rate') {
    effectiveBudgetAmount = 0
    effectiveCommissionRate = rawCommission
  } else {
    // 'none' またはフォールバック
    effectiveBudgetAmount = 0
    effectiveCommissionRate = null
  }
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
    effectiveCommissionRate,
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

  // inbox引き継ぎの場合、invoice_inboxのstatusをappliedに更新（DB更新なのでawaitで確実に）
  const inboxIdFromBody = body.inbox_id ? parseInt(body.inbox_id) : null
  if (inboxIdFromBody) {
    const now = new Date().toISOString()
    await db.prepare(
      'UPDATE invoice_inbox SET status = ?, application_id = ?, updated_at = ? WHERE id = ? AND status = ?'
    ).bind('applied', appId, now, inboxIdFromBody, 'pending').run()
  }

  // === 承認者への通知はバックグラウンドで送信（外部API待ちで画面遷移が遅くならないようにするため）===
  if (firstStep) {
    const appUrl = `${new URL(c.req.url).origin}/applications/${appId}`
    runInBackground(c, async () => {
      await sendNotification(db, 'review_request', firstStep.reviewer_id, {
        appNumber, title: body.title, applicantName: user.name, appUrl,
        isTest: isTestFlag === 1
      })
      await db.prepare(
        'INSERT INTO notification_logs (application_id, recipient_id, notification_type, email_to, subject, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(appId, firstStep.reviewer_id, 'review_request', firstStep.email,
        (isTestFlag === 1 ? '[TEST] ' : '') + buildMailSubject('review_request', appNumber), 'sent'
      ).run()
    })
  }

  // 一覧画面へリダイレクト + 成功トースト用パラメータ付与
  return c.redirect(`/applications?created=${encodeURIComponent(appNumber)}`)
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

  // 自分に承認依頼が来ている（現在の承認担当）ステップを確認
  const myPendingStep = (steps.results as any[]).find(
    s => s.reviewer_id === user.uid && s.status === 'pending' && s.step_number === app.current_step
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
  let motoukeKumiaiAtt: any = null  // バナー内でPDFプレビューを表示するために保持
  if (app.payment_target === 'td' && app.td_type === 'motouke') {
    motoukeSuccessorB = await db.prepare(`
      SELECT id, application_number, status FROM applications
      WHERE original_application_id = ? ORDER BY id DESC LIMIT 1
    `).bind(id).first() as any
    motoukeKumiaiAtt = await db.prepare(
      'SELECT id, file_name FROM attachments WHERE application_id = ? AND file_type = ? LIMIT 1'
    ).bind(id, 'kumiai_invoice').first() as any
    motoukeKumiaiUploaded = !!motoukeKumiaiAtt
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
    motoukeFlash = `<div class="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-lg">✅ 申請者へ「承認・回覧開始」のお知らせを再送信しました</div>`
  } else if (c.req.query('motouke_remind') === 'already') {
    motoukeFlash = `<div class="bg-yellow-50 border border-yellow-200 text-yellow-700 text-sm px-4 py-3 rounded-lg">⚠️ 既に承認・回覧が開始されています</div>`
  } else if (c.req.query('motouke_remind') === 'no_pdf') {
    motoukeFlash = `<div class="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">❌ 管理組合宛の請求書がまだ添付されていないため、お知らせを送信できません</div>`
  } else if (c.req.query('motouke_dup') === '1') {
    motoukeFlash = `<div class="bg-blue-50 border border-blue-200 text-blue-700 text-sm px-4 py-3 rounded-lg">ℹ️ この元請の管理組合宛請求書は既に回覧が開始されています。既存の申請ページを表示しています。</div>`
  } else if (c.req.query('motouke_b_created') === '1') {
    motoukeFlash = `<div class="bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm px-4 py-3 rounded-lg">✅ 管理組合宛の請求書の回覧を開始しました！上長へ通知を送信しました。</div>`
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
        <div class="mt-3 bg-amber-50 border-2 border-amber-300 rounded-lg p-4 text-sm">
          ${motoukeKumiaiUploaded ? `
            <div class="flex items-start gap-2 mb-3">
              <span class="text-xl">📬</span>
              <div class="flex-1">
                <p class="text-amber-900 font-bold text-base mb-1">管理組合宛の請求書ができました</p>
                <p class="text-amber-800 leading-relaxed">
                  業務管理課が作成した<strong>管理組合宛の請求書</strong>を添付済みです。<br>
                  <strong class="text-amber-900">下のPDFで内容をご確認</strong>いただき、問題なければ<strong>承認・回覧開始</strong>してください。
                </p>
              </div>
            </div>
            <!-- 管理組合宛請求書PDF: ボタン直前に大きく表示（案②） -->
            ${motoukeKumiaiAtt ? (() => {
              const ext = (motoukeKumiaiAtt.file_name.split('.').pop() || '').toLowerCase()
              const isPdf = ext === 'pdf'
              const isImg = ['jpg','jpeg','png','gif','webp'].includes(ext)
              const iconColor = isPdf ? 'text-red-500' : isImg ? 'text-blue-500' : 'text-gray-500'
              const icon = isPdf
                ? '<svg class="w-12 h-12 ' + iconColor + '" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clip-rule="evenodd"/><text x="10" y="15" text-anchor="middle" fill="white" font-size="5" font-weight="bold">PDF</text></svg>'
                : isImg
                ? '<svg class="w-12 h-12 ' + iconColor + '" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>'
                : '<svg class="w-12 h-12 ' + iconColor + '" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>'
              const safeName = motoukeKumiaiAtt.file_name.replace(/'/g, "\\'")
              return `
              <div class="mb-3 bg-white border-2 border-amber-400 rounded-lg p-4 shadow-sm">
                <div class="flex items-center gap-1 mb-2">
                  <span class="text-xs font-bold text-orange-700 bg-orange-100 border border-orange-300 px-2 py-0.5 rounded-full">👉 承認前に必ずご確認ください</span>
                </div>
                <div class="flex items-center gap-3">
                  <div class="flex-shrink-0">${icon}</div>
                  <div class="flex-1 min-w-0">
                    <p class="text-xs font-semibold text-amber-800">管理組合宛請求書</p>
                    <p class="text-sm text-gray-800 font-medium truncate" title="${motoukeKumiaiAtt.file_name}">${motoukeKumiaiAtt.file_name}</p>
                  </div>
                  <div class="flex gap-1 flex-shrink-0">
                    <button type="button" onclick="openSavedFilePreview('/files/${motoukeKumiaiAtt.id}', '${safeName}')"
                      class="inline-flex items-center gap-1 bg-[#396999] hover:bg-[#2E5580] text-white text-sm font-semibold px-4 py-2.5 rounded transition shadow-sm">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                      内容を確認
                    </button>
                    <a href="/files/${motoukeKumiaiAtt.id}?dl=1" download="${motoukeKumiaiAtt.file_name}"
                      class="inline-flex items-center gap-1 bg-white hover:bg-gray-50 text-gray-700 text-sm font-semibold px-3 py-2.5 rounded border border-gray-300 transition">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                      DL
                    </a>
                  </div>
                </div>
              </div>`
            })() : ''}
            <div class="mt-3">
              <a href="/applications/${id}/motouke-b/confirm"
                class="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-bold px-5 py-2.5 rounded-lg transition shadow-sm">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
                内容を確認して、承認・回覧開始 →
              </a>
            </div>
          ` : `
            <div class="flex items-start gap-2">
              <span class="text-xl">⏳</span>
              <div class="flex-1">
                <p class="text-amber-900 font-bold mb-1">管理組合宛の請求書 作成待ち</p>
                <p class="text-amber-700 text-xs">
                  業務管理課が管理組合宛の請求書を作成・添付するまでお待ちください。<br>
                  添付が完了すると、こちらに<strong>承認・回覧開始</strong>ボタンが表示されます。
                </p>
              </div>
            </div>
          `}
        </div>
        ` : ''}

        <!--
          【非表示】業務管理課/管理者向け「お知らせを再送信」バナー（A案 UIのみ非表示）
          非表示理由:
            - 管理組合宛請求書アップロード時に、既に自動通知が申請者へ届いている
            - 業務管理課→申請者への催促は口頭/LINEで済むため、UIとしては冗長
            - 将来、別の要件（例: N日以上滞留申請の一括催促）で再検討予定
          復活方法:
            - 下の条件式 (false && ...) の "false && " を削除すれば元に戻る
          対応する POST エンドポイント (/applications/:id/motouke-remind) は
          将来の再利用のため残してあります。
        -->
        ${(false && app.payment_target === 'td' && app.td_type === 'motouke' && !motoukeSuccessorB && motoukeKumiaiUploaded && (user.is_admin || user.role === 'operations')) ? `
        <div class="mt-3 bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm flex items-start justify-between gap-3 flex-wrap sm:flex-nowrap">
          <div class="flex-1 min-w-0">
            <p class="text-blue-800 font-semibold flex items-center gap-1">
              <span>📢</span> 申請者へ「承認・回覧開始」のお願いを再送信
            </p>
            <p class="text-blue-700 text-xs mt-1 leading-relaxed">
              管理組合宛の請求書は添付済みですが、申請者（${app.applicant_name}さん）が<strong>まだ承認・回覧を開始していません</strong>。<br>
              下のボタンを押すと、申請者へ再度お知らせを送信します（メール / LINE WORKS）。
            </p>
          </div>
          <form method="POST" action="/applications/${id}/motouke-remind" onsubmit="return confirm('${app.applicant_name}さんに、管理組合宛の請求書の「承認・回覧開始」お知らせを再送信しますか？')" class="flex-shrink-0">
            <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-2 rounded-lg transition whitespace-nowrap">
              📨 お知らせを再送信
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
          ${(() => {
            // 手数料の表示: 三択(円/％/なし)を判定して1つだけ表示
            //   commission_rate != null           → 手数料（％）
            //   budget_amount > 0 (rate は null)   → 手数料（円）
            //   両方0/null                        → 手数料: なし
            if (app.commission_rate != null) {
              return `<div><span class="text-gray-400">手数料（％）</span><p class="font-medium mt-0.5">${app.commission_rate}%</p></div>`
            }
            if (Number(app.budget_amount) > 0) {
              return `<div><span class="text-gray-400">手数料（円）</span><p class="font-medium mt-0.5">${Number(app.budget_amount).toLocaleString()}円</p></div>`
            }
            return `<div><span class="text-gray-400">手数料</span><p class="font-medium mt-0.5 text-gray-500">なし</p></div>`
          })()}

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
      ${(() => {
        // 元請セット申請A の場合、管理組合宛請求書PDFは上部バナーで既に大きく表示済みのため
        // 添付ファイル欄からは除外する（重複表示の解消）
        const isMotoukeA = app.payment_target === 'td' && app.td_type === 'motouke' && !motoukeSourceA
        const visibleAttachments = (attachments.results as any[]).filter((att: any) =>
          isMotoukeA ? att.file_type !== 'kumiai_invoice' : true
        )
        return visibleAttachments.length > 0 ? `
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div class="flex items-center gap-2 mb-4">
          <svg class="w-5 h-5 text-[#396999]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
          </svg>
          <h3 class="font-semibold text-gray-800">添付ファイル</h3>
          <span class="text-xs text-gray-500">（クリックで内容を確認）</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          ${visibleAttachments.map(att => {
            const labels: Record<string, string> = { invoice1: '請求書①', invoice2: '請求書②', invoice3: '請求書③', invoice4: '請求書④', invoice5: '請求書⑤', invoice6: '請求書⑥', other1: '添付資料①', other2: '添付資料②', kumiai_invoice: '管理組合宛請求書', estimate: '見積書' }
            const ext = (att.file_name.split('.').pop() || '').toLowerCase()
            const isPdf = ext === 'pdf'
            const isImg = ['jpg','jpeg','png','gif','webp'].includes(ext)
            const iconColor = isPdf ? 'text-red-500' : isImg ? 'text-blue-500' : 'text-gray-500'
            const icon = isPdf
              ? '<svg class="w-8 h-8 ' + iconColor + '" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clip-rule="evenodd"/><text x="10" y="15" text-anchor="middle" fill="white" font-size="5" font-weight="bold">PDF</text></svg>'
              : isImg
              ? '<svg class="w-8 h-8 ' + iconColor + '" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>'
              : '<svg class="w-8 h-8 ' + iconColor + '" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>'
            const safeName = att.file_name.replace(/'/g, "\\'")
            const isKumiai = att.file_type === 'kumiai_invoice'
            const borderCls = isKumiai ? 'border-amber-300 bg-amber-50' : 'border-[#AECBE5] bg-white'
            return `
            <div class="flex items-center gap-3 border-2 ${borderCls} hover:border-[#396999] hover:shadow-md rounded-lg p-3 transition">
              <div class="flex-shrink-0">${icon}</div>
              <div class="flex-1 min-w-0">
                <p class="text-xs font-semibold ${isKumiai ? 'text-amber-800' : 'text-[#396999]'}">${labels[att.file_type] || att.file_type}</p>
                <p class="text-xs text-gray-600 truncate" title="${att.file_name}">${att.file_name}</p>
              </div>
              <div class="flex gap-1 flex-shrink-0">
                <button type="button" onclick="openSavedFilePreview('/files/${att.id}', '${safeName}')"
                  class="inline-flex items-center gap-1 bg-[#396999] hover:bg-[#2E5580] text-white text-xs font-semibold px-3 py-2 rounded transition">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                  確認
                </button>
                <a href="/files/${att.id}?dl=1" download="${att.file_name}"
                  class="inline-flex items-center gap-1 bg-white hover:bg-gray-50 text-gray-700 text-xs font-semibold px-3 py-2 rounded border border-gray-300 transition">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                  DL
                </a>
              </div>
            </div>`
          }).join('')}
        </div>
      </div>
      ` : ''
      })()}

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

      <!-- あなたに承認依頼が来ています -->
      ${myPendingStep ? `
      <div class="bg-gradient-to-r from-orange-50 to-amber-50 border-2 border-orange-300 rounded-xl p-5 shadow-sm">
        <div class="flex items-start gap-4">
          <div class="flex-shrink-0">
            <div class="w-12 h-12 bg-orange-500 rounded-full flex items-center justify-center animate-pulse">
              <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
              </svg>
            </div>
          </div>
          <div class="flex-1">
            <h3 class="text-base font-bold text-orange-900 mb-1">🔔 あなたに承認依頼が来ています</h3>
            <p class="text-sm text-orange-800 mb-3">
              ステップ ${myPendingStep.step_number}（${stepLabels[myPendingStep.step_number] || 'レビュー'}）として、この申請の承認をお願いします。
            </p>
            <a href="/applications/${id}/review/${myPendingStep.id}"
              class="inline-flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white font-semibold px-5 py-2.5 rounded-lg transition text-sm shadow">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              承認・差し戻し画面へ進む →
            </a>
          </div>
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
              const isMyTurn = isCurrent && step.reviewer_id === user.uid
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
                    ${isMyTurn ? '<span class="ml-1 text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-medium">← あなたの番</span>' : ''}
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
                ${isMyTurn ? `
                <div class="mt-2">
                  <a href="/applications/${id}/review/${step.id}"
                    class="inline-flex items-center gap-1 bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition">
                    ✅ 承認・差し戻し画面へ →
                  </a>
                </div>` : ''}
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
          ${(() => {
            if (app.commission_rate != null) {
              return `<div><span class="text-gray-400">手数料（％）</span><p class="font-medium">${app.commission_rate}%</p></div>`
            }
            if (Number(app.budget_amount) > 0) {
              return `<div><span class="text-gray-400">手数料（円）</span><p class="font-medium">${Number(app.budget_amount).toLocaleString()}円</p></div>`
            }
            return `<div><span class="text-gray-400">手数料</span><p class="font-medium text-gray-500">なし</p></div>`
          })()}

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
            <div class="flex items-center gap-2 mb-3">
              <svg class="w-4 h-4 text-[#396999]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
              </svg>
              <p class="text-sm font-semibold text-gray-700">添付ファイル</p>
              <span class="text-xs text-orange-600 bg-orange-50 border border-orange-200 px-2 py-0.5 rounded-full font-medium">👉 承認前に必ずご確認ください</span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              ${(attachments.results as any[]).filter((a: any) => a.file_type !== 'kumiai_invoice').map(att => {
                const labels: Record<string, string> = { invoice1: '請求書①', invoice2: '請求書②', invoice3: '請求書③', invoice4: '請求書④', invoice5: '請求書⑤', invoice6: '請求書⑥', other1: '添付①', other2: '添付②', estimate: '見積書' }
                const ext = (att.file_name.split('.').pop() || '').toLowerCase()
                const isPdf = ext === 'pdf'
                const isImg = ['jpg','jpeg','png','gif','webp'].includes(ext)
                const iconColor = isPdf ? 'text-red-500' : isImg ? 'text-blue-500' : 'text-gray-500'
                const icon = isPdf
                  ? '<svg class="w-8 h-8 ' + iconColor + '" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clip-rule="evenodd"/><text x="10" y="15" text-anchor="middle" fill="white" font-size="5" font-weight="bold">PDF</text></svg>'
                  : isImg
                  ? '<svg class="w-8 h-8 ' + iconColor + '" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>'
                  : '<svg class="w-8 h-8 ' + iconColor + '" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>'
                const safeName = att.file_name.replace(/'/g, "\\'")
                return `
                <div class="flex items-center gap-3 bg-white border-2 border-[#AECBE5] hover:border-[#396999] hover:shadow-md rounded-lg p-3 transition group">
                  <div class="flex-shrink-0">${icon}</div>
                  <div class="flex-1 min-w-0">
                    <p class="text-xs font-semibold text-[#396999]">${labels[att.file_type] || att.file_type}</p>
                    <p class="text-xs text-gray-600 truncate" title="${att.file_name}">${att.file_name}</p>
                  </div>
                  <div class="flex gap-1 flex-shrink-0">
                    <button type="button" onclick="openSavedFilePreview('/files/${att.id}', '${safeName}')"
                      class="inline-flex items-center gap-1 bg-[#396999] hover:bg-[#2E5580] text-white text-xs font-semibold px-3 py-2 rounded transition">
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                      確認
                    </button>
                    <a href="/files/${att.id}?dl=1" download="${att.file_name}"
                      class="inline-flex items-center gap-1 bg-white hover:bg-gray-50 text-gray-700 text-xs font-semibold px-3 py-2 rounded border border-gray-300 transition">
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                      DL
                    </a>
                  </div>
                </div>`
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
//
// ⚠️ 【現在このエンドポイントを叩くUIは非表示化されています】(A案)
//    - 申請詳細画面のバナーは src/routes/applications.ts の (false && ...) 条件で非表示
//    - 管理組合宛請求書アップロード時の自動通知で十分カバーできるため
//    - 将来「N日以上滞留申請の一括催促」など別要件で再利用する可能性があるため
//      エンドポイント本体は削除せず残置しています
//    - 復活させる場合はバナー側の `false && ` を削除するだけで動きます
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
  const newAppUrl = `${origin}/applications/${id}/motouke-b/confirm`
  const isTestApp = app.is_test === 1

  runInBackground(c, async () => {
    await sendNotification(db, 'motouke_next', app.applicant_id, {
      appNumber: app.application_number,
      title: app.title,
      applicantName: app.applicant_name,
      appUrl: newAppUrl,
      isTest: isTestApp,
    } as any)

    await db.prepare(
      'INSERT INTO notification_logs (application_id, recipient_id, notification_type, email_to, subject, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, app.applicant_id, 'motouke_next_remind', '', (isTestApp ? '[TEST] ' : '') + `【再送信】${app.application_number} - 管理組合宛の請求書の承認・回覧開始のお願い`, 'sent').run()
  })

  return c.redirect(`/applications/${id}?motouke_remind=ok`)
})

// ============================================================
// 元請セット申請B: ワンクリック確認画面 → 回覧開始
// ============================================================
applications.get('/:id/motouke-b/confirm', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const id = c.req.param('id')

  // 元申請A取得
  const sourceApp = await db.prepare(`
    SELECT a.*, m.name as mansion_name, m.mansion_number, m.accounting_user_id
    FROM applications a
    LEFT JOIN mansions m ON a.mansion_id = m.id
    WHERE a.id = ? AND a.payment_target = 'td' AND a.td_type = 'motouke'
  `).bind(id).first() as any

  if (!sourceApp) {
    return c.html(`<p style="padding:2rem;color:#dc2626">⛔ 元請申請が見つかりません</p>`, 404)
  }

  // 権限: 申請者本人 or 管理者のみ
  if (sourceApp.applicant_id !== user.uid && !user.is_admin) {
    return c.html(`<p style="padding:2rem;color:#dc2626">⛔ この元請セット申請Bの作成権限がありません（元申請の申請者本人のみ作成できます）</p>`, 403)
  }

  // 既に後続Bが作成されている場合はそちらへリダイレクト
  const existingB = await db.prepare(
    'SELECT id, application_number FROM applications WHERE original_application_id = ? LIMIT 1'
  ).bind(id).first() as any
  if (existingB) {
    return c.redirect(`/applications/${existingB.id}?motouke_dup=1`)
  }

  // 管理組合宛請求書PDFを取得
  const kumiaiAtt = await db.prepare(
    'SELECT * FROM attachments WHERE application_id = ? AND file_type = ? ORDER BY id DESC LIMIT 1'
  ).bind(id, 'kumiai_invoice').first() as any
  if (!kumiaiAtt) {
    return c.html(`<p style="padding:2rem;color:#dc2626">⛔ 元申請にまだ管理組合宛請求書PDFがアップロードされていません。本橋（業務管理課）のアップロード完了をお待ちください。</p>`, 400)
  }

  // 元申請の回覧ステップ（Step1・Step2の担当者）を取得
  const sourceSteps = await db.prepare(`
    SELECT cs.step_number, cs.reviewer_id, u.name as reviewer_name, u.role as reviewer_role
    FROM circulation_steps cs JOIN users u ON cs.reviewer_id = u.id
    WHERE cs.application_id = ? ORDER BY cs.step_number
  `).bind(id).all()

  const step1 = (sourceSteps.results as any[]).find(s => s.step_number === 1)
  const step2 = (sourceSteps.results as any[]).find(s => s.step_number === 2)

  // Step3: マンションマスタから会計担当を取得
  //  - マンションに会計担当が設定済み → その人で固定表示
  //  - マンションに会計担当が未設定 → プルダウンで選択させる（accountingロールから）
  //    ※ フォールバックで勝手に誰かを選ぶのはやめる（意図しない人に承認依頼が飛ぶのを防ぐ）
  //  - テストモード（user.test_mode=1 かつ admin）→ 常にプルダウンを表示し、
  //    全アクティブユーザーから選択可（ロール制限なし・テスト用途）
  const isTestMode = user.is_admin && user.test_mode === 1
  let step3User: any = null
  let step3IsFixed = false  // true: マンションマスタで確定, false: 未設定なのでユーザーが選ぶ
  if (sourceApp.accounting_user_id) {
    step3User = await db.prepare(
      "SELECT id, name, role FROM users WHERE id = ? AND is_active = 1"
    ).bind(sourceApp.accounting_user_id).first() as any
    step3IsFixed = !!step3User
  }
  // テストモード時は必ずプルダウン表示（固定化を上書き）
  if (isTestMode) {
    step3IsFixed = false
  }
  // 候補一覧の取得
  //   - 通常時: accountingロールのみ
  //   - テストモード時: 全アクティブユーザー（ロール表記付き）
  const step3Candidates = step3IsFixed
    ? []
    : isTestMode
      ? ((await db.prepare(
          "SELECT id, name, role FROM users WHERE is_active = 1 ORDER BY name"
        ).all()).results as any[])
      : ((await db.prepare(
          "SELECT id, name, role FROM users WHERE role = 'accounting' AND is_active = 1 ORDER BY name"
        ).all()).results as any[])

  // エラー表示
  const err = c.req.query('err')
  let errHtml = ''
  if (err === 'no_step1') errHtml = '<div class="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg mb-4">❌ 元申請Aに上長（Step1）が設定されていません</div>'
  else if (err === 'no_step2') errHtml = '<div class="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg mb-4">❌ 元申請Aに業務管理課（Step2）が設定されていません</div>'
  else if (err === 'no_step3') errHtml = '<div class="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg mb-4">❌ マンションに会計担当（マンション会計）が設定されていません。管理画面 → マンション管理マスタから会計担当を設定してください</div>'
  else if (err) errHtml = `<div class="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg mb-4">❌ ${err}</div>`

  const isTestApp = sourceApp.is_test === 1
  const kumiaiAmount = sourceApp.kumiai_amount || 0

  const content = `
    <div class="max-w-2xl mx-auto space-y-5">
      ${errHtml}

      <!-- ヘッダー -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div class="flex items-center gap-2 mb-2 flex-wrap">
          <span class="bg-emerald-100 text-emerald-700 text-xs font-bold px-2 py-0.5 rounded-full">🔗 元請セット申請B（後続）</span>
          ${isTestApp ? '<span class="bg-yellow-100 text-yellow-800 text-xs font-bold px-2 py-0.5 rounded-full border border-yellow-300">🧪 テスト申請</span>' : ''}
        </div>
        <h2 class="text-xl font-bold text-gray-800 mb-4">${sourceApp.mansion_name || sourceApp.title} - 管理組合宛請求書の回覧</h2>

        <!-- 業務ユーザー向けの説明バナー -->
        <div class="bg-amber-50 border-2 border-amber-300 rounded-lg p-4 mb-3 flex items-start gap-3">
          <span class="text-2xl">📬</span>
          <div class="flex-1 text-sm">
            <p class="font-bold text-amber-900 mb-1">管理組合宛の請求書ができました</p>
            <p class="text-amber-800 leading-relaxed">
              業務管理課が作成した<strong>管理組合宛の請求書</strong>を下に表示しています。<br>
              内容を確認して問題なければ、ページ下の <strong>「承認・回覧開始」</strong> ボタンを押してください。<br>
              押すと、この請求書が上長へ回覧されます（金額・回覧先は自動設定済）。
            </p>
          </div>
        </div>

        <div class="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm">
          <p class="text-emerald-800">
            <strong>🔗 元申請A:</strong>
            <a href="/applications/${sourceApp.id}" class="text-emerald-700 hover:underline font-mono ml-1">${sourceApp.application_number}</a>
            <span class="text-emerald-600 text-xs ml-2">（業者請求書の回覧）</span>
          </p>
        </div>
      </div>

      <!-- 注意書き + 実行ボタン（申請内容の上に配置） -->
      <div class="bg-blue-50 border-2 border-blue-200 rounded-xl p-5">
        <p class="text-sm text-blue-900 mb-4">
          ⚠️ <strong>管理組合宛の請求書の内容を前の画面でご確認</strong>いただけましたでしょうか？<br>
          下のボタンを押すと、この請求書が<strong>上長 → 業務管理課 → マンション会計課</strong>の順で回覧されます。
        </p>
        <form method="POST" action="/applications/${id}/motouke-b/confirm" id="motoukeBForm">
          <div class="flex gap-3 flex-wrap">
            <button type="submit" id="startBtn"
              class="flex-1 min-w-[200px] bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-6 py-3 rounded-lg transition text-base shadow-md flex items-center justify-center gap-2">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              承認・回覧開始 →
            </button>
            <a href="/applications/${id}"
              class="px-5 py-3 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition flex items-center justify-center">
              ← 前の画面に戻ってPDFを再確認
            </a>
          </div>
        </form>
      </div>

      <!-- 申請内容 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div class="flex items-center gap-2 mb-4">
          <svg class="w-5 h-5 text-[#396999]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
          <h3 class="font-semibold text-gray-800">申請内容（自動設定）</h3>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div>
            <p class="text-xs text-gray-400">マンション</p>
            <p class="font-medium mt-0.5">${sourceApp.mansion_name || '-'}</p>
          </div>
          <div>
            <p class="text-xs text-gray-400">支払先</p>
            <p class="font-medium mt-0.5"><span class="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full">管理組合</span></p>
          </div>
          <div>
            <p class="text-xs text-gray-400">管理組合請求金額</p>
            <p class="font-medium mt-0.5 text-lg">${Number(kumiaiAmount).toLocaleString()}円</p>
          </div>
          <div>
            <p class="text-xs text-gray-400">申請者</p>
            <p class="font-medium mt-0.5">${user.name}</p>
          </div>
          ${sourceApp.remarks ? `
          <div class="col-span-full">
            <p class="text-xs text-gray-400">備考（元申請Aから継承）</p>
            <p class="text-sm mt-0.5 bg-gray-50 border border-gray-200 rounded p-2">${sourceApp.remarks}</p>
          </div>
          ` : ''}
        </div>
      </div>

      <!-- 回覧経路 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div class="flex items-center gap-2 mb-4">
          <svg class="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0"/>
          </svg>
          <h3 class="font-semibold text-gray-800">回覧経路（元申請Aから自動流用）</h3>
        </div>
        <div class="space-y-2">
          <div class="flex items-center gap-3 border border-[#AECBE5] bg-[#EEF4FA] rounded-lg p-3">
            <span class="inline-flex items-center justify-center w-7 h-7 bg-[#D5E5F2] text-[#2E5580] rounded-full text-xs font-bold">1</span>
            <span class="text-xs text-gray-500 w-16 shrink-0">上長</span>
            <span class="text-sm font-medium text-gray-800 flex-1">${step1 ? step1.reviewer_name : '<span class="text-red-500">未設定</span>'}</span>
          </div>
          <div class="flex items-center gap-3 border border-orange-200 bg-orange-50 rounded-lg p-3">
            <span class="inline-flex items-center justify-center w-7 h-7 bg-orange-100 text-orange-700 rounded-full text-xs font-bold">2</span>
            <span class="text-xs text-gray-500 w-16 shrink-0">業務管理課</span>
            <span class="text-sm font-medium text-gray-800 flex-1">${step2 ? step2.reviewer_name : '<span class="text-red-500">未設定</span>'}</span>
          </div>
          <div class="flex items-center gap-3 border ${step3IsFixed ? 'border-green-200 bg-green-50' : isTestMode ? 'border-yellow-400 bg-yellow-50' : 'border-amber-300 bg-amber-50'} rounded-lg p-3">
            <span class="inline-flex items-center justify-center w-7 h-7 ${step3IsFixed ? 'bg-green-100 text-green-700' : isTestMode ? 'bg-yellow-100 text-yellow-800' : 'bg-amber-100 text-amber-800'} rounded-full text-xs font-bold">3</span>
            <span class="text-xs text-gray-500 w-16 shrink-0">マンション会計</span>
            ${step3IsFixed
              ? `<span class="text-sm font-medium text-gray-800 flex-1">${step3User.name}</span>`
              : step3Candidates.length > 0
                ? `
                  <div class="flex-1">
                    ${isTestMode ? `
                      <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs font-bold text-yellow-800 bg-yellow-200 px-2 py-0.5 rounded-full">🧪 テストモード</span>
                        <span class="text-xs text-yellow-700">全ユーザーから選択可</span>
                      </div>
                    ` : ''}
                    <select name="step3_user_id" form="motoukeBForm" required
                      class="w-full text-sm font-medium text-gray-800 px-3 py-1.5 border ${isTestMode ? 'border-yellow-400 bg-white focus:ring-yellow-500' : 'border-amber-400 bg-white focus:ring-amber-500'} rounded focus:ring-2 outline-none">
                      <option value="">▼ ${isTestMode ? 'ユーザーを選択してください' : '会計担当者を選択してください'}</option>
                      ${step3Candidates.map((u: any) => {
                        const roleTag = isTestMode && u.role ? ` [${u.role}]` : ''
                        // マンションマスタで元々設定されていた人がいれば初期選択
                        const isDefault = sourceApp.accounting_user_id && u.id === sourceApp.accounting_user_id
                        return `<option value="${u.id}" ${isDefault ? 'selected' : ''}>${u.name}${roleTag}</option>`
                      }).join('')}
                    </select>
                    ${isTestMode
                      ? `<p class="text-xs text-yellow-800 mt-1 leading-relaxed">
                          🧪 <strong>テストモード</strong>: ロール制限を解除して全アクティブユーザーから選択できます。<br>
                          本番運用では accounting ロールのユーザーのみが候補になります。
                        </p>`
                      : `<p class="text-xs text-amber-800 mt-1 leading-relaxed">
                          ⚠️ このマンションには会計担当が未設定のため、今回はこちらから選んでください。<br>
                          恒久設定は <a href="/admin/mansions" target="_blank" class="text-amber-900 underline font-semibold">マンション管理マスタ</a> から行うのが本来です。
                        </p>`
                    }
                  </div>
                `
                : `<span class="text-sm text-red-600 flex-1">❌ accountingロールのユーザーが1人も登録されていません。管理者にお問い合わせください</span>`
            }
          </div>
        </div>
      </div>

      <!--
        【削除】管理組合宛請求書PDF セクション（案②）
        削除理由:
          - 直前の申請詳細画面のバナー内で既に大きくPDFプレビュー/DLボタンを表示済み
          - 同じPDFを2画面で見せるのは冗長 (ユーザー要望による整理)
        補足:
          - PDF取得ロジック (kumiaiAtt fetch) は上部で残しており
            未アップロード時のエラー画面表示に引き続き使用されます
        【移動】注意書き + 実行ボタンは「申請内容」ブロックの上に移動しました
          （申請者がスクロールせずに承認・回覧開始ボタンに到達できるよう改善）
      -->
    </div>

    <script>
      // 二重送信防止
      document.getElementById('motoukeBForm').addEventListener('submit', function(e) {
        const btn = document.getElementById('startBtn')
        btn.disabled = true
        btn.innerHTML = '<svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"></circle><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" class="opacity-75"></path></svg>回覧を開始しています...'
      })
    </script>
  `
  return c.html(layout('管理組合宛の請求書 - 承認・回覧開始', content, user))
})

// 元請セット申請B の作成実行（確認画面からの POST）
applications.post('/:id/motouke-b/confirm', async (c) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')

  const db = c.env.DB
  const id = c.req.param('id')

  // 元申請A取得
  const sourceApp = await db.prepare(`
    SELECT a.*, m.name as mansion_name, m.accounting_user_id
    FROM applications a LEFT JOIN mansions m ON a.mansion_id = m.id
    WHERE a.id = ? AND a.payment_target = 'td' AND a.td_type = 'motouke'
  `).bind(id).first() as any

  if (!sourceApp) {
    return c.html(`<p style="padding:2rem;color:#dc2626">⛔ 元請申請が見つかりません</p>`, 404)
  }
  if (sourceApp.applicant_id !== user.uid && !user.is_admin) {
    return c.html(`<p style="padding:2rem;color:#dc2626">⛔ 作成権限がありません</p>`, 403)
  }

  // 二重作成防止
  const existingB = await db.prepare(
    'SELECT id FROM applications WHERE original_application_id = ? LIMIT 1'
  ).bind(id).first() as any
  if (existingB) {
    return c.redirect(`/applications/${existingB.id}?motouke_dup=1`)
  }

  // 管理組合宛請求書取得
  const kumiaiAtt = await db.prepare(
    'SELECT * FROM attachments WHERE application_id = ? AND file_type = ? ORDER BY id DESC LIMIT 1'
  ).bind(id, 'kumiai_invoice').first() as any
  if (!kumiaiAtt) {
    return c.redirect(`/applications/${id}/motouke-b/confirm?err=${encodeURIComponent('管理組合宛請求書PDFが未アップロードです')}`)
  }

  // 元申請の Step1/Step2 担当者を取得
  const sourceSteps = await db.prepare(
    'SELECT step_number, reviewer_id FROM circulation_steps WHERE application_id = ? ORDER BY step_number'
  ).bind(id).all()
  const step1 = (sourceSteps.results as any[]).find(s => s.step_number === 1)
  const step2 = (sourceSteps.results as any[]).find(s => s.step_number === 2)

  if (!step1) return c.redirect(`/applications/${id}/motouke-b/confirm?err=no_step1`)
  if (!step2) return c.redirect(`/applications/${id}/motouke-b/confirm?err=no_step2`)

  // Step3: マンションの会計担当を決定
  //   優先順位:
  //     0) テストモード ON かつ プルダウンから選ばれた場合 → その値を優先（ロール制限なし）
  //     1) マンションマスタに accounting_user_id が設定済み → それを使用（プルダウン非表示）
  //     2) マンションマスタ未設定 → 確認画面のプルダウンから選ばれた step3_user_id を使用
  //   ※ フォールバックで勝手に誰かを選ぶのはやめる（意図しない承認依頼を防ぐ）
  const isTestModePost = user.is_admin && user.test_mode === 1
  const body = await c.req.parseBody() as any
  const submittedStep3 = body.step3_user_id ? parseInt(String(body.step3_user_id)) : null

  let step3Id: number | null = null

  if (isTestModePost && submittedStep3) {
    // テストモード: プルダウン優先、全アクティブユーザーを許容（ロール制限なし）
    const target = await db.prepare(
      "SELECT id, role, is_active FROM users WHERE id = ?"
    ).bind(submittedStep3).first() as any
    if (!target || !target.is_active) {
      return c.redirect(`/applications/${id}/motouke-b/confirm?err=${encodeURIComponent('選択されたユーザーが存在しないか無効化されています')}`)
    }
    step3Id = target.id
  } else if (sourceApp.accounting_user_id) {
    // 通常: マンションマスタ優先
    step3Id = sourceApp.accounting_user_id
  } else if (submittedStep3) {
    // 通常＋マスタ未設定: プルダウンから accountingロール限定で選択
    const target = await db.prepare(
      "SELECT id, role, is_active FROM users WHERE id = ?"
    ).bind(submittedStep3).first() as any
    if (!target || !target.is_active) {
      return c.redirect(`/applications/${id}/motouke-b/confirm?err=${encodeURIComponent('選択されたユーザーが存在しないか無効化されています')}`)
    }
    if (target.role !== 'accounting') {
      return c.redirect(`/applications/${id}/motouke-b/confirm?err=${encodeURIComponent('マンション会計課ロールのユーザーを選択してください')}`)
    }
    step3Id = target.id
  } else {
    return c.redirect(`/applications/${id}/motouke-b/confirm?err=${encodeURIComponent('マンション会計課の担当者を選択してください')}`)
  }
  if (!step3Id) return c.redirect(`/applications/${id}/motouke-b/confirm?err=no_step3`)

  // 申請B の application_number を生成
  const appNumber = generateApplicationNumber()

  // 元申請の is_test を継承
  const isTestFlag = sourceApp.is_test === 1 ? 1 : 0

  // 回覧開始日: 本日
  const today = new Date().toISOString().substring(0, 10)

  // 申請B を INSERT
  const result = await db.prepare(`
    INSERT INTO applications (
      application_number, title, mansion_id, applicant_id, circulation_start_date,
      payment_target, account_item, td_type, kumiai_amount, gyosha_amount, budget_amount,
      commission_rate, remarks, status, current_step, resubmit_count, original_application_id, is_test
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'circulating', 1, 0, ?, ?)
  `).bind(
    appNumber,
    sourceApp.title || sourceApp.mansion_name || '',   // タイトルは元申請A から継承
    sourceApp.mansion_id,
    user.uid,
    today,
    'kumiai',                     // 支払先: 管理組合
    null,                         // account_item は元請Bでは未設定（必要なら申請Aから継承も可）
    null,                         // td_type: 元請Bは kumiai なので null
    sourceApp.kumiai_amount,      // 組合請求金額
    null,                         // 業者支払金額は kumiai には不要
    0,                            // 手数料（円）: 完全スキップ = 0（Q2 案A）
    null,                         // 手数料（％）: なし
    sourceApp.remarks || null,    // 備考は元申請Aから継承（Q3 案A）
    id,                           // original_application_id: 元申請AのID
    isTestFlag                    // is_test 継承
  ).run()

  const appId = result.meta.last_row_id as number

  // 添付ファイル: 管理組合宛請求書PDFを invoice1 として引き継ぐ（同じR2キーを参照）
  await db.prepare(
    'INSERT INTO attachments (application_id, file_type, file_name, file_key) VALUES (?, ?, ?, ?)'
  ).bind(appId, 'invoice1', kumiaiAtt.file_name, kumiaiAtt.file_key).run()

  // 回覧ステップを直接 INSERT（元申請Aから流用した担当者ID）
  await db.prepare(
    'INSERT INTO circulation_steps (application_id, step_number, reviewer_id, status) VALUES (?, 1, ?, "pending")'
  ).bind(appId, step1.reviewer_id).run()
  await db.prepare(
    'INSERT INTO circulation_steps (application_id, step_number, reviewer_id, status) VALUES (?, 2, ?, "pending")'
  ).bind(appId, step2.reviewer_id).run()
  await db.prepare(
    'INSERT INTO circulation_steps (application_id, step_number, reviewer_id, status) VALUES (?, 3, ?, "pending")'
  ).bind(appId, step3Id).run()

  // 最初の承認者（上長）にメール/LINE WORKS通知
  const firstStep = await db.prepare(
    'SELECT cs.*, u.email, u.name FROM circulation_steps cs JOIN users u ON cs.reviewer_id = u.id WHERE cs.application_id = ? AND cs.step_number = 1'
  ).bind(appId).first() as any

  if (firstStep) {
    const appUrl = `${new URL(c.req.url).origin}/applications/${appId}`
    runInBackground(c, async () => {
      await sendNotification(db, 'review_request', firstStep.reviewer_id, {
        appNumber,
        title: sourceApp.title || sourceApp.mansion_name || '',
        applicantName: user.name,
        appUrl,
        isTest: isTestFlag === 1
      })
      await db.prepare(
        'INSERT INTO notification_logs (application_id, recipient_id, notification_type, email_to, subject, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(appId, firstStep.reviewer_id, 'review_request', firstStep.email,
        (isTestFlag === 1 ? '[TEST] ' : '') + buildMailSubject('review_request', appNumber), 'sent'
      ).run()
    })
  }

  // 完了 → 申請B詳細画面へ
  return c.redirect(`/applications/${appId}?motouke_b_created=1`)
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
      // 通知はバックグラウンドで送信
      runInBackground(c, async () => {
        await sendNotification(db, 'review_request', nextStep.reviewer_id, {
          appNumber: app.application_number, title: app.title, applicantName: app.applicant_name, appUrl,
          isTest: isTestApp
        })
      })
    } else {
      // 全ステップ完了
      await db.prepare('UPDATE applications SET status = "completed", updated_at = datetime("now") WHERE id = ?').bind(id).run()
      runInBackground(c, async () => {
        await sendNotification(db, 'completed', app.applicant_id, {
          appNumber: app.application_number, title: app.title, applicantName: app.applicant_name, appUrl,
          isTest: isTestApp
        })
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
        const newAppUrl = `${origin}/applications/${id}/motouke-b/confirm`
        runInBackground(c, async () => {
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
        })
      }
    }

  } else if (action === 'reject') {
    await db.prepare(
      'UPDATE circulation_steps SET status = "rejected", action_comment = ?, acted_at = datetime("now") WHERE id = ?'
    ).bind(comment, stepId).run()
    await db.prepare('UPDATE applications SET status = "rejected", updated_at = datetime("now") WHERE id = ?').bind(id).run()
    runInBackground(c, async () => {
      await sendNotification(db, 'rejected', app.applicant_id, {
        appNumber: app.application_number, title: app.title, applicantName: app.applicant_name, comment, appUrl,
        isTest: isTestApp
      })
    })

  } else if (action === 'hold') {
    await db.prepare(
      'UPDATE circulation_steps SET status = "on_hold", action_comment = ?, acted_at = datetime("now") WHERE id = ?'
    ).bind(comment, stepId).run()
    await db.prepare('UPDATE applications SET status = "on_hold", updated_at = datetime("now") WHERE id = ?').bind(id).run()
    runInBackground(c, async () => {
      await sendNotification(db, 'on_hold', app.applicant_id, {
        appNumber: app.application_number, title: app.title, applicantName: app.applicant_name, comment, appUrl,
        isTest: isTestApp
      })
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

    // 申請者へ統合通知（メール + LINE WORKS）はバックグラウンドで送信
    runInBackground(c, async () => {
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
    runInBackground(c, async () => {
      await sendNotification(db, 'answered', (step as any).reviewer_id, {
        appNumber: (app as any).application_number,
        title: (app as any).title,
        applicantName: user.name,
        comment: body.answer,
        appUrl
      })
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
  // 勘定科目: 手入力・20文字上限（管理組合の場合のみ）
  let editedAccountItem: any = body.account_item !== undefined && body.account_item !== '' ? String(body.account_item).trim() : (editedPaymentTarget === 'kumiai' ? orig.account_item : null)
  if (editedPaymentTarget === 'kumiai') {
    if (!editedAccountItem) {
      return c.redirect(`/applications/new?resubmit_id=${id}&error=account_item_required`)
    }
    if (typeof editedAccountItem === 'string' && editedAccountItem.length > 20) {
      return c.redirect(`/applications/new?resubmit_id=${id}&error=account_item_too_long`)
    }
  }
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

  // 手数料バリデーション（管理組合の場合、円/％/なし の3択いずれか）
  //   再申請の場合、元申請の値が正しく引き継がれていれば
  //   budget=0 かつ commission=null (=「なし」) も許容する
  if (editedPaymentTarget !== 'td') {
    // 値が全く決定できなかった場合のみエラー
    // (通常は元申請の値がフォールバックで入るため到達しないが念のため)
    if (editedBudgetAmount === null || editedBudgetAmount === undefined || editedBudgetAmount === '') {
      const hasCommission = editedCommissionRate !== null && editedCommissionRate !== undefined && !isNaN(editedCommissionRate)
      if (!hasCommission) {
        return c.redirect(`/applications/new?resubmit_id=${id}&error=fee_required`)
      }
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

  // invoice1〜invoice6, other1, other2, estimate（元請時のみ任意）それぞれ処理
  const fileTypes = ['invoice1', 'invoice2', 'invoice3', 'invoice4', 'invoice5', 'invoice6', 'other1', 'other2', 'estimate']
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

  // === 通知送信はバックグラウンドで実行（画面遷移を先に返す）===
  const appUrl = `${new URL(c.req.url).origin}/applications/${newId}`
  if (isReturned) {
    // 差し戻し再申請の場合、全承認者に統合通知
    const stepsRes = await db.prepare(
      'SELECT cs.reviewer_id FROM circulation_steps cs WHERE cs.application_id = ?'
    ).bind(newId).all()
    const reviewerIds = (stepsRes.results as any[]).map(s => s.reviewer_id)
    runInBackground(c, async () => {
      for (const reviewerId of reviewerIds) {
        await sendNotification(db, 'reapplied', reviewerId, {
          appNumber: newNumber,
          title: editedTitle,
          applicantName: user.name,
          returnedReason: orig.returned_reason,
          reapplyReason,
          appUrl,
          isTest: orig.is_test === 1
        })
      }
    })
  } else {
    // rejected からの再提出: 最初の承認者にのみ通知（新規申請と同じ挙動）
    const firstStep = await db.prepare(
      'SELECT cs.*, u.email, u.name FROM circulation_steps cs JOIN users u ON cs.reviewer_id = u.id WHERE cs.application_id = ? AND cs.step_number = 1'
    ).bind(newId).first() as any
    if (firstStep) {
      runInBackground(c, async () => {
        await sendNotification(db, 'review_request', firstStep.reviewer_id, {
          appNumber: newNumber, title: editedTitle, applicantName: user.name, appUrl,
          isTest: orig.is_test === 1
        })
      })
    }
  }

  // 一覧画面へリダイレクト + 成功トースト用パラメータ付与（新規申請と同じ挙動）
  return c.redirect(`/applications?created=${encodeURIComponent(newNumber)}`)
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
