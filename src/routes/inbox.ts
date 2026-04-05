import { Hono } from 'hono'
import { getSessionUser, getSessionIdFromCookie } from '../lib/auth'
import { layout } from './layout'
import { sendMail, buildInboxNotificationBody } from '../lib/mail'

type Bindings = { DB: D1Database; R2: R2Bucket }
const inbox = new Hono<{ Bindings: Bindings }>()

// 認証ミドルウェア
inbox.use('*', async (c, next) => {
  const cookie = c.req.header('Cookie')
  const sessionId = getSessionIdFromCookie(cookie)
  const user = await getSessionUser(c.env.DB, sessionId)
  if (!user) return c.redirect('/login')
  c.set('user' as any, user)
  await next()
})

// ============================================================
// 請求書受付一覧（業務管理課・管理者のみ）
// ============================================================
inbox.get('/', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')

  const db = c.env.DB
  const statusFilter = c.req.query('status') || 'all'

  let where = ''
  if (statusFilter === 'pending') where = "WHERE ii.status = 'pending'"
  else if (statusFilter === 'applied') where = "WHERE ii.status = 'applied'"
  else if (statusFilter === 'cancelled') where = "WHERE ii.status = 'cancelled'"

  const items = await db.prepare(`
    SELECT
      ii.*,
      m.name as mansion_name,
      f.name as front_name,
      f.email as front_email,
      r.name as registered_by_name
    FROM invoice_inbox ii
    LEFT JOIN mansions m ON ii.mansion_id = m.id
    LEFT JOIN users f ON ii.front_user_id = f.id
    LEFT JOIN users r ON ii.registered_by = r.id
    ${where}
    ORDER BY ii.created_at DESC
  `).all()

  const statusLabel: Record<string, string> = {
    pending: '未申請', applied: '申請済', cancelled: 'キャンセル'
  }
  const statusColor: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700',
    applied: 'bg-green-100 text-green-700',
    cancelled: 'bg-gray-100 text-gray-500'
  }

  const content = `
    <div class="space-y-4">
      <!-- ヘッダー -->
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-bold text-gray-800">📥 請求書受付管理</h2>
        <a href="/inbox/new" class="bg-[#396999] hover:bg-[#2E5580] text-white text-sm font-semibold px-4 py-2 rounded-lg transition flex items-center gap-2">
          <span>＋</span><span>請求書を登録</span>
        </a>
      </div>

      <!-- フィルタータブ -->
      <div class="flex gap-2 border-b border-gray-200 pb-0">
        ${[['all','すべて'],['pending','未申請'],['applied','申請済'],['cancelled','キャンセル']].map(([v,l]) => `
          <a href="/inbox?status=${v}" class="px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition
            ${statusFilter === v ? 'border-[#396999] text-[#396999] bg-[#EEF4FA]' : 'border-transparent text-gray-500 hover:text-gray-700'}">
            ${l}
          </a>
        `).join('')}
      </div>

      <!-- 一覧テーブル -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        ${items.results.length === 0 ? `
          <div class="text-center py-12 text-gray-400">
            <div class="text-4xl mb-2">📭</div>
            <p>データがありません</p>
          </div>
        ` : `
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">登録日</th>
                  <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">マンション名</th>
                  <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">担当フロント</th>
                  <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">添付ファイル</th>
                  <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">リマインド</th>
                  <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
                  <th class="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-50">
                ${(items.results as any[]).map(item => `
                  <tr class="hover:bg-gray-50">
                    <td class="px-4 py-3 text-xs text-gray-500">${item.created_at ? item.created_at.slice(0,10) : '-'}</td>
                    <td class="px-4 py-3 font-medium text-gray-800">${item.mansion_name || '-'}</td>
                    <td class="px-4 py-3 text-gray-700">
                      <div>${item.front_name || '-'}</div>
                      <div class="text-xs text-gray-400">${item.front_email || ''}</div>
                    </td>
                    <td class="px-4 py-3">
                      ${item.attachment_key
                        ? `<a href="/inbox/${item.id}/download" class="text-[#396999] hover:underline text-xs flex items-center gap-1">📎 ${item.attachment_name || 'ファイル'}</a>`
                        : '<span class="text-gray-300 text-xs">なし</span>'}
                    </td>
                    <td class="px-4 py-3 text-xs text-gray-500">
                      ${item.remind_count > 0
                        ? `<span class="text-orange-600">${item.remind_count}回送信済</span>`
                        : '<span class="text-gray-400">未送信</span>'}
                    </td>
                    <td class="px-4 py-3">
                      <span class="text-xs px-2 py-1 rounded-full font-medium ${statusColor[item.status] || ''}">
                        ${statusLabel[item.status] || item.status}
                      </span>
                    </td>
                    <td class="px-4 py-3">
                      <div class="flex items-center gap-2">
                        ${item.status === 'pending' ? `
                          <form method="POST" action="/inbox/${item.id}/remind" onsubmit="return confirm('${item.front_name}さんにリマインドメールを送信しますか？')">
                            <button type="submit" class="text-xs px-2 py-1 bg-orange-50 text-orange-600 hover:bg-orange-100 rounded transition">再通知</button>
                          </form>
                          <form method="POST" action="/inbox/${item.id}/cancel" onsubmit="return confirm('この受付をキャンセルしますか？')">
                            <button type="submit" class="text-xs px-2 py-1 bg-gray-50 text-gray-500 hover:bg-gray-100 rounded transition">取消</button>
                          </form>
                        ` : ''}
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    </div>
  `
  return c.html(layout('請求書受付管理', content, user))
})

// ============================================================
// 請求書受付 登録フォーム
// ============================================================
inbox.get('/new', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')

  const db = c.env.DB
  const mansions = await db.prepare("SELECT * FROM mansions WHERE is_active = 1 ORDER BY CAST(mansion_number AS INTEGER)").all()
  const fronts = await db.prepare("SELECT * FROM users WHERE role IN ('front', 'front_supervisor') AND is_active = 1 ORDER BY name").all()

  const content = `
    <div class="max-w-xl mx-auto">
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 class="text-lg font-bold text-gray-800 mb-6 flex items-center gap-2">
          📥 請求書を登録・フロントへ送信
        </h2>

        <form method="POST" action="/inbox" enctype="multipart/form-data" class="space-y-5">

          <!-- マンション番号入力 -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">
              マンション <span class="text-red-500">*</span>
            </label>
            <div class="flex gap-2 items-start">
              <div class="w-28">
                <input type="number" id="mansionNumberInput" placeholder="番号" min="1"
                  class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[#396999] outline-none text-center"
                  oninput="searchMansion(this.value)">
                <p class="text-xs text-gray-400 mt-1 text-center">番号を入力</p>
              </div>
              <div class="flex-1">
                <div id="mansionResult" class="px-3 py-2 border border-dashed border-gray-300 rounded-lg text-sm text-gray-400 bg-gray-50 min-h-[38px] flex items-center">
                  番号を入力するとマンション名が表示されます
                </div>
                <div id="mansionNotFound" class="hidden px-3 py-1 text-xs text-red-500 mt-1">⚠ 該当するマンションが見つかりません</div>
              </div>
            </div>
            <input type="hidden" name="mansion_id" id="mansionIdInput" required>
          </div>

          <!-- 担当フロント -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">
              担当フロント <span class="text-red-500">*</span>
            </label>
            <select name="front_user_id" id="frontSelect" required
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#396999]">
              <option value="">-- 選択してください --</option>
              ${(fronts.results as any[]).map(f =>
                `<option value="${f.id}">${f.name}（${f.email}）</option>`
              ).join('')}
            </select>
            <p class="text-xs text-gray-400 mt-1">マンション番号入力時に自動セットされます（変更可）</p>
          </div>

          <!-- 請求書PDF添付 -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">
              請求書PDF <span class="text-red-500">*</span>
            </label>
            <div class="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-[#5B8AB5] transition cursor-pointer" onclick="document.getElementById('pdfFile').click()">
              <div class="text-3xl mb-1">📄</div>
              <p class="text-sm text-gray-500">クリックしてPDFを選択</p>
              <p class="text-xs text-gray-400 mt-1">PDF形式（最大10MB）</p>
              <input type="file" id="pdfFile" name="pdf_file" accept=".pdf,application/pdf"
                class="hidden" onchange="showFileName(this)">
              <p id="fileName" class="text-xs text-[#396999] mt-2 font-medium"></p>
            </div>
          </div>

          <!-- 備考 -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">備考</label>
            <textarea name="note" rows="3" placeholder="業者名、請求内容など補足があれば入力"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#396999] resize-none"></textarea>
          </div>

          <!-- 送信ボタン -->
          <div class="pt-2 flex gap-3">
            <a href="/inbox" class="flex-1 text-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition">
              キャンセル
            </a>
            <button type="submit"
              class="flex-1 bg-[#396999] hover:bg-[#2E5580] text-white font-semibold px-4 py-2 rounded-lg text-sm transition flex items-center justify-center gap-2">
              📤 登録してフロントに送信
            </button>
          </div>
        </form>
      </div>
    </div>

    <script>
      // マンションデータをJSに埋め込み
      const MANSIONS = ${JSON.stringify(
        (mansions.results as any[]).map((m: any) => ({
          id: m.id,
          number: m.mansion_number,
          name: m.name,
          frontId: m.front_user_id ? String(m.front_user_id) : ''
        }))
      )};

      function searchMansion(val) {
        const num = parseInt(val);
        const resultEl = document.getElementById('mansionResult');
        const notFoundEl = document.getElementById('mansionNotFound');
        const idInput = document.getElementById('mansionIdInput');
        const frontSel = document.getElementById('frontSelect');

        if (!val || isNaN(num)) {
          resultEl.textContent = '番号を入力するとマンション名が表示されます';
          resultEl.className = 'px-3 py-2 border border-dashed border-gray-300 rounded-lg text-sm text-gray-400 bg-gray-50 min-h-[38px] flex items-center';
          notFoundEl.classList.add('hidden');
          idInput.value = '';
          return;
        }

        const found = MANSIONS.find(m => m.number === num);
        if (found) {
          resultEl.innerHTML = '<span class="text-[#2E5580] font-bold mr-2">' + found.number + '</span><span class="font-semibold text-gray-800">' + found.name + '</span>';
          resultEl.className = 'px-3 py-2 border-2 border-[#5B8AB5] rounded-lg text-sm bg-[#EEF4FA] min-h-[38px] flex items-center gap-1';
          notFoundEl.classList.add('hidden');
          idInput.value = found.id;
          // 担当フロント自動セット
          if (found.frontId && frontSel) {
            for (let i = 0; i < frontSel.options.length; i++) {
              if (frontSel.options[i].value === found.frontId) {
                frontSel.selectedIndex = i;
                break;
              }
            }
          }
        } else {
          resultEl.textContent = '番号を入力するとマンション名が表示されます';
          resultEl.className = 'px-3 py-2 border border-dashed border-gray-300 rounded-lg text-sm text-gray-400 bg-gray-50 min-h-[38px] flex items-center';
          notFoundEl.classList.remove('hidden');
          idInput.value = '';
        }
      }

      function showFileName(input) {
        const p = document.getElementById('fileName');
        if (input.files && input.files[0]) {
          p.textContent = '✅ ' + input.files[0].name;
        }
      }
    </script>
  `
  return c.html(layout('請求書登録', content, user))
})

// ============================================================
// 請求書受付 登録処理
// ============================================================
inbox.post('/', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')

  const db = c.env.DB
  const r2 = c.env.R2
  const body = await c.req.parseBody() as any

  const mansionId = body.mansion_id
  const frontUserId = body.front_user_id
  const note = body.note || null
  const pdfFile = body.pdf_file as File | null

  if (!mansionId || !frontUserId) {
    return c.redirect('/inbox/new?error=required')
  }

  let attachmentKey: string | null = null
  let attachmentName: string | null = null

  // PDFをR2にアップロード
  if (pdfFile && pdfFile.size > 0) {
    attachmentName = pdfFile.name
    attachmentKey = `inbox/${Date.now()}_${pdfFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const arrayBuffer = await pdfFile.arrayBuffer()
    await r2.put(attachmentKey, arrayBuffer, {
      httpMetadata: { contentType: pdfFile.type || 'application/pdf' }
    })
  }

  const now = new Date().toISOString()

  // DBに登録
  const result = await db.prepare(`
    INSERT INTO invoice_inbox
      (mansion_id, front_user_id, registered_by, attachment_key, attachment_name, note, status, notified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).bind(mansionId, frontUserId, user.id, attachmentKey, attachmentName, note, now, now, now).run()

  const inboxId = result.meta.last_row_id

  // フロント担当者の情報取得
  const frontUser = await db.prepare('SELECT * FROM users WHERE id = ?').bind(frontUserId).first() as any
  const mansion = await db.prepare('SELECT * FROM mansions WHERE id = ?').bind(mansionId).first() as any
  const smtpSettings = await db.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any

  // メール通知送信
  if (frontUser && frontUser.email && smtpSettings) {
    const appUrl = `${new URL(c.req.url).origin}/applications/new?inbox_id=${inboxId}`
    const subject = `【請求書受付】${mansion?.name || 'マンション'} の請求書が届きました`
    const html = buildInboxNotificationBody({
      frontName: frontUser.name,
      mansionName: mansion?.name || '',
      registeredBy: user.name,
      note: note || '',
      appUrl,
      isReminder: false,
      remindCount: 0
    })
    try {
      await sendMail(smtpSettings, {
        to: frontUser.email,
        subject,
        html
      })
    } catch (e) {
      console.error('メール送信エラー:', e)
    }
  }

  return c.redirect('/inbox?sent=1')
})

// ============================================================
// 添付ファイルダウンロード
// ============================================================
inbox.get('/:id/download', async (c) => {
  const user = (c as any).get('user') as any
  const db = c.env.DB
  const r2 = c.env.R2
  const id = c.req.param('id')

  const item = await db.prepare('SELECT * FROM invoice_inbox WHERE id = ?').bind(id).first() as any
  if (!item) return c.notFound()

  // 権限チェック（業務管理課・管理者・担当フロント本人）
  if (!user.is_admin && user.role !== 'operations' && user.id !== item.front_user_id) {
    return c.redirect('/')
  }

  if (!item.attachment_key) return c.text('添付ファイルがありません', 404)

  const obj = await r2.get(item.attachment_key)
  if (!obj) return c.notFound()

  const fileName = encodeURIComponent(item.attachment_name || 'invoice.pdf')
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/pdf',
      'Content-Disposition': `attachment; filename*=UTF-8''${fileName}`
    }
  })
})

// ============================================================
// 手動リマインド送信
// ============================================================
inbox.post('/:id/remind', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')

  const db = c.env.DB
  const id = c.req.param('id')
  const now = new Date().toISOString()

  const item = await db.prepare(`
    SELECT ii.*, m.name as mansion_name, f.name as front_name, f.email as front_email
    FROM invoice_inbox ii
    LEFT JOIN mansions m ON ii.mansion_id = m.id
    LEFT JOIN users f ON ii.front_user_id = f.id
    WHERE ii.id = ?
  `).bind(id).first() as any

  if (!item || item.status !== 'pending') return c.redirect('/inbox')

  const smtpSettings = await db.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any

  if (item.front_email && smtpSettings) {
    const newCount = (item.remind_count || 0) + 1
    const appUrl = `${new URL(c.req.url).origin}/applications/new?inbox_id=${item.id}`
    const subject = `【リマインド${newCount}回目】${item.mansion_name} の請求書回覧申請をお願いします`
    const html = buildInboxNotificationBody({
      frontName: item.front_name,
      mansionName: item.mansion_name,
      registeredBy: user.name,
      note: item.note || '',
      appUrl,
      isReminder: true,
      remindCount: newCount
    })
    try {
      await sendMail(smtpSettings, { to: item.front_email, subject, html })
      await db.prepare(`
        UPDATE invoice_inbox SET remind_count = ?, last_reminded_at = ?, updated_at = ? WHERE id = ?
      `).bind(newCount, now, now, id).run()
    } catch (e) {
      console.error('リマインド送信エラー:', e)
    }
  }

  return c.redirect('/inbox?reminded=1')
})

// ============================================================
// キャンセル処理
// ============================================================
inbox.post('/:id/cancel', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')

  const db = c.env.DB
  const id = c.req.param('id')
  const now = new Date().toISOString()

  await db.prepare(`
    UPDATE invoice_inbox SET status = 'cancelled', updated_at = ? WHERE id = ?
  `).bind(now, id).run()

  return c.redirect('/inbox?cancelled=1')
})

export default inbox
