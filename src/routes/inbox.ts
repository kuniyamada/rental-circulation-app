import { Hono } from 'hono'
import { getSessionUser, getSessionIdFromCookie } from '../lib/auth'
import { layout } from './layout'
import { sendMail, buildInboxNotificationBody } from '../lib/mail'
import { sendLineWorksMessage, rowToConfig, type LineWorksConfigRow } from '../lib/lineworks'

type Bindings = { DB: D1Database; R2: R2Bucket }
const inbox = new Hono<{ Bindings: Bindings }>()

// ============================================================
// 請求書受付の通知（担当フロント宛）
//   ユーザーの通知設定(notify_method)に従い メール / LINE WORKS / 両方 で送信
//   ※以前はメールのみで、LINE WORKS には送っていなかった
// ============================================================
async function notifyInbox(
  db: D1Database,
  frontUserId: number | string,
  data: { mansionName: string; registeredBy: string; note: string; appUrl: string; isReminder: boolean; remindCount: number }
): Promise<void> {
  const u = await db.prepare(
    'SELECT name, email, notify_method, lineworks_user_id FROM users WHERE id = ?'
  ).bind(frontUserId).first() as any
  if (!u) return
  const method = u.notify_method || 'email'

  // メール
  if (method === 'email' || method === 'both') {
    const smtp = await db.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any
    if (smtp && u.email) {
      const subject = data.isReminder
        ? `【リマインド${data.remindCount}回目】${data.mansionName} の請求書回覧申請をお願いします`
        : `【請求書受付】${data.mansionName || 'マンション'} の請求書が届きました`
      const html = buildInboxNotificationBody({ frontName: u.name, ...data })
      await sendMail(smtp, { to: u.email, subject, html })
    }
  }

  // LINE WORKS
  if (method === 'lineworks' || method === 'both') {
    const row = await db.prepare('SELECT * FROM lineworks_config WHERE is_active = 1 LIMIT 1').first() as LineWorksConfigRow | null
    if (row && u.lineworks_user_id) {
      const lines = [
        data.isReminder ? `⚠️ リマインド（${data.remindCount}回目）` : '📥 請求書受付のお知らせ',
        `マンション: ${data.mansionName}`,
        `登録: ${data.registeredBy}（業務管理課）`,
      ]
      if (data.note) lines.push(`備考: ${data.note}`)
      lines.push('', '回覧申請をお願いします。')
      const full = lines.join('\n')
      const text = full.length > 155 ? full.substring(0, 155) + '...' : full
      const result = await sendLineWorksMessage(rowToConfig(row), u.lineworks_user_id, {
        type: 'button_template',
        altText: full,
        template: { type: 'buttons', text, actions: [{ type: 'uri', label: '回覧申請を開始する', uri: data.appUrl }] },
      }, async (tokenData) => {
        const expiresAt = Math.floor(Date.now() / 1000) + Number(tokenData.expires_in || 86400)
        await db.prepare(
          'UPDATE lineworks_config SET access_token=?, refresh_token=?, token_expires_at=?, updated_at=datetime("now") WHERE is_active=1'
        ).bind(tokenData.access_token, tokenData.refresh_token || row.refresh_token || null, expiresAt).run()
      })
      if (result !== true) console.error(`[LW] 請求書受付通知の送信失敗 userId=${u.lineworks_user_id}: ${result}`)
    }
  }
}

// レスポンス返却後も通知処理を続ける（画面遷移を待たせない）
function runInBackground(c: any, task: () => Promise<void>): void {
  const p = (async () => { try { await task() } catch (e) { console.error('[BG] 請求書受付通知エラー:', e) } })()
  try { c.executionCtx.waitUntil(p) } catch { /* ローカル等 */ }
}

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

      ${c.req.query('deleted') ? `
      <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-2">✅ 受付を削除しました</div>` : ''}
      ${c.req.query('delete_error') ? `
      <div class="bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg px-4 py-2">⚠ ${c.req.query('delete_error') === 'applied' ? 'この受付はすでに申請済のため削除できません' : '対象の受付が見つかりませんでした'}</div>` : ''}

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
                        ` : ''}
                        ${(item.status === 'pending' || item.status === 'cancelled') ? `
                          <form method="POST" action="/inbox/${item.id}/delete" onsubmit="return confirm('この受付を削除しますか？\\n添付PDFも削除され、元に戻せません。')">
                            <button type="submit" class="text-xs px-2 py-1 bg-red-50 text-red-600 hover:bg-red-100 rounded transition">削除</button>
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
  const mansions = await db.prepare("SELECT * FROM mansions WHERE is_active = 1 AND is_visible = 1 ORDER BY CAST(mansion_number AS INTEGER)").all()
  const frontsRes = await db.prepare("SELECT * FROM users WHERE role IN ('front', 'front_supervisor') AND is_active = 1 ORDER BY name").all()
  // テストモード（管理者のみ）: 担当フロント候補に 本橋(030)・山崎(049) を追加（受信者側の画面確認用）
  const isTestMode = user.is_admin && user.test_mode === 1
  const testExtraFronts = isTestMode
    ? ((await db.prepare("SELECT * FROM users WHERE employee_number IN ('030','049') AND is_active = 1 ORDER BY employee_number").all()).results as any[])
    : []
  const testExtraIds = new Set(testExtraFronts.map((u: any) => u.id))
  const fronts = { results: [...testExtraFronts, ...((frontsRes.results as any[]).filter((f: any) => !testExtraIds.has(f.id)))] }

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
              ${(fronts.results as any[]).map(f => testExtraIds.has(f.id)
                ? `<option value="${f.id}" style="font-weight:bold">★ ${f.name}（${f.email}）【テスト】</option>`
                : `<option value="${f.id}">${f.name}（${f.email}）</option>`
              ).join('')}
            </select>
            <p class="text-xs text-gray-400 mt-1">マンション番号入力時に自動セットされます（変更可）</p>
            ${isTestMode ? `<p class="text-xs font-bold text-amber-600 mt-1">🧪 テストモード：★ 本橋・山崎 も選択できます</p>` : ''}
          </div>

          <!-- 請求書PDF添付 -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">
              請求書PDF <span class="text-red-500">*</span>
            </label>
            <div id="pdfDropZone" class="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-[#5B8AB5] transition cursor-pointer" onclick="document.getElementById('pdfFile').click()">
              <div class="text-3xl mb-1">📄</div>
              <p class="text-sm text-gray-500">クリックしてPDFを選択、またはここにドラッグ＆ドロップ</p>
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

      // PDFかどうか・サイズ（最大10MB）をチェック
      function isValidPdf(file) {
        if (!file) return false;
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (!isPdf) { alert('PDFファイルを選択してください'); return false; }
        if (file.size > 10 * 1024 * 1024) { alert('ファイルサイズが10MBを超えています'); return false; }
        return true;
      }

      function showFileName(input) {
        const p = document.getElementById('fileName');
        if (input.files && input.files[0]) {
          if (!isValidPdf(input.files[0])) {
            input.value = '';
            p.textContent = '';
            return;
          }
          p.textContent = '✅ ' + input.files[0].name;
        } else {
          p.textContent = '';
        }
      }

      // ドラッグ＆ドロップ対応
      (function() {
        const zone = document.getElementById('pdfDropZone');
        const input = document.getElementById('pdfFile');
        if (!zone || !input) return;
        const on = () => zone.classList.add('border-[#396999]', 'bg-[#EEF4FA]');
        const off = () => zone.classList.remove('border-[#396999]', 'bg-[#EEF4FA]');
        ['dragenter', 'dragover'].forEach(function(ev) {
          zone.addEventListener(ev, function(e) { e.preventDefault(); e.stopPropagation(); on(); });
        });
        zone.addEventListener('dragleave', function(e) {
          e.preventDefault();
          if (!zone.contains(e.relatedTarget)) off();
        });
        zone.addEventListener('drop', function(e) {
          e.preventDefault(); e.stopPropagation(); off();
          const files = e.dataTransfer && e.dataTransfer.files;
          if (!files || files.length === 0) return;
          const file = files[0];
          if (!isValidPdf(file)) return;
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          showFileName(input);
        });
        // 枠の外にドロップしたときにブラウザがPDFを開いて画面遷移しないようにする
        ['dragover', 'drop'].forEach(function(ev) {
          window.addEventListener(ev, function(e) { e.preventDefault(); });
        });
      })();
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
  `).bind(mansionId, frontUserId, user.uid, attachmentKey, attachmentName, note, now, now, now).run()

  const inboxId = result.meta.last_row_id

  // 担当フロントへ通知（メール / LINE WORKS：本人の通知設定に従う）
  const mansion = await db.prepare('SELECT name FROM mansions WHERE id = ?').bind(mansionId).first() as any
  const appUrl = `${new URL(c.req.url).origin}/applications/new?inbox_id=${inboxId}`
  runInBackground(c, () => notifyInbox(db, frontUserId, {
    mansionName: mansion?.name || '',
    registeredBy: user.name,
    note: note || '',
    appUrl,
    isReminder: false,
    remindCount: 0,
  }))

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
  if (!user.is_admin && user.role !== 'operations' && user.uid !== item.front_user_id) {
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

  const newCount = (item.remind_count || 0) + 1
  await db.prepare(`
    UPDATE invoice_inbox SET remind_count = ?, last_reminded_at = ?, updated_at = ? WHERE id = ?
  `).bind(newCount, now, now, id).run()
  const appUrl = `${new URL(c.req.url).origin}/applications/new?inbox_id=${item.id}`
  runInBackground(c, () => notifyInbox(db, item.front_user_id, {
    mansionName: item.mansion_name || '',
    registeredBy: user.name,
    note: item.note || '',
    appUrl,
    isReminder: true,
    remindCount: newCount,
  }))

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

// ============================================================
// 削除処理（未申請・キャンセルのみ。申請済は回覧申請の記録として残す）
// ============================================================
inbox.post('/:id/delete', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')

  const db = c.env.DB
  const id = c.req.param('id')

  const item = await db.prepare(
    "SELECT id, status, attachment_key FROM invoice_inbox WHERE id = ?"
  ).bind(id).first() as any
  if (!item) return c.redirect('/inbox?delete_error=notfound')
  if (item.status !== 'pending' && item.status !== 'cancelled') {
    return c.redirect('/inbox?delete_error=applied')
  }

  // 申請処理と同時実行された場合に備え、状態を条件に含めて削除
  const res = await db.prepare(
    "DELETE FROM invoice_inbox WHERE id = ? AND status IN ('pending', 'cancelled')"
  ).bind(id).run()
  if (!res.meta.changes) return c.redirect('/inbox?delete_error=applied')

  // 添付PDF（R2）を削除。念のため回覧申請の添付として使われていないか確認してから消す
  if (item.attachment_key) {
    const used = await db.prepare(
      'SELECT id FROM attachments WHERE file_key = ? LIMIT 1'
    ).bind(item.attachment_key).first()
    if (!used) {
      try { await c.env.R2.delete(item.attachment_key) } catch (e) { console.error('R2 delete failed', e) }
    }
  }

  return c.redirect('/inbox?deleted=1')
})

export default inbox
