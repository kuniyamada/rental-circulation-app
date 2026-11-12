import { Hono } from 'hono'
import { getSessionUser, getSessionIdFromCookie } from '../lib/auth'
import { layout } from './layout'
import { sendMail, buildInboxNotificationBody } from '../lib/mail'
import { sendLineWorksMessage, rowToConfig, type LineWorksConfigRow } from '../lib/lineworks'
import { budgetConfigured } from '../lib/budget'
import { maybeSyncAssignees } from '../lib/assignee-sync'
import { saveLedgerToDrive, estimateFolderConfigured } from '../lib/estimate-ledger'
import { DriveClient } from '../lib/drive-client'

type Bindings = { DB: D1Database; R2: R2Bucket; [k: string]: any }
const inbox = new Hono<{ Bindings: Bindings }>()

// 保存済みファイルをポップアップでプレビューするボタン（新しいタブ・ダウンロードはポップアップ内から）
function escAttr(v: any): string {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[ch])
}
function previewBtn(url: string, name: string, label = '👁 確認', cls = 'inline-flex items-center gap-1 px-2.5 py-1 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580] whitespace-nowrap'): string {
  return `<button type="button" data-url="${escAttr(url)}" data-name="${escAttr(name)}" onclick="openSavedFilePreview(this.dataset.url, this.dataset.name)" class="${cls}">${label}</button>`
}

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
        `登録: ${data.registeredBy}`,
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
                        ? previewBtn(`/inbox/${item.id}/download`, item.attachment_name || 'invoice.pdf', `📎 ${escAttr(item.attachment_name || 'ファイル')}`, 'text-[#396999] hover:underline text-xs flex items-center gap-1 text-left')
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
  await maybeSyncAssignees(c)
  const mansions = await db.prepare("SELECT * FROM mansions WHERE is_active = 1 AND is_visible = 1 ORDER BY CAST(mansion_number AS INTEGER)").all()
  const frontsRes = await db.prepare("SELECT * FROM users WHERE role IN ('front', 'front_supervisor') AND is_active = 1 ORDER BY name").all()
  // テストモード（管理者のみ）: 担当フロント候補に 本橋(030)・山崎(049) を追加（受信者側の画面確認用）
  const isTestMode = user.is_admin && user.test_mode === 1
  const testExtraFronts = isTestMode
    ? ((await db.prepare("SELECT * FROM users WHERE employee_number IN ('030','049') AND is_active = 1 ORDER BY employee_number").all()).results as any[])
    : []
  const testExtraIds = new Set(testExtraFronts.map((u: any) => u.id))
  const fronts = { results: [...testExtraFronts, ...((frontsRes.results as any[]).filter((f: any) => !testExtraIds.has(f.id)))] }

  // 予算書表示: Google 接続と「物件決算書類関係」フォルダIDがそろうまでは欄ごと出さない
  const budgetEnabled = budgetConfigured(c.env)

  // 管理簿「この見積から請求書を登録」から来た場合: 物件を入力済みにし、登録時に管理簿を「登録・送信済」にする
  const estimateId = parseInt(c.req.query('estimate_id') || '') || null
  const estRow = estimateId
    ? await db.prepare(`SELECT e.*, a.application_number FROM estimate_ledger e LEFT JOIN applications a ON a.id = e.application_id WHERE e.id = ?`).bind(estimateId).first().catch(() => null) as any
    : null

  const content = `
    <div class="max-w-xl mx-auto">
      ${estRow ? `
      <div class="mb-4 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 text-sm text-amber-900">
        <div class="font-bold mb-1">📒 管理簿の見積書から請求書を登録します</div>
        <div class="text-xs space-y-0.5">
          <div>物件: <b>${escAttr(estRow.mansion_number != null ? String(estRow.mansion_number).padStart(3, '0') : '-')} ${escAttr(estRow.mansion_name || '')}</b>　／　元の回覧: ${escAttr(estRow.application_number || '-')}</div>
          <div class="flex items-center gap-2 flex-wrap">見積書: ${previewBtn(`/inbox/estimates/${estRow.id}/file`, estRow.original_file_name || '見積書', '👁 見積書を確認')}</div>
          <div>登録すると、管理簿のこの見積書は「③ 登録・送信済」になります。</div>
        </div>
      </div>` : ''}
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 class="text-lg font-bold text-gray-800 mb-6 flex items-center gap-2">
          📥 請求書を登録・フロントへ送信
        </h2>

        <form method="POST" action="/inbox" enctype="multipart/form-data" class="space-y-5">
          ${estRow ? `<input type="hidden" name="estimate_id" value="${estRow.id}">` : ''}

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
            ${budgetEnabled ? `
            <!-- 予算書（見るだけ。登録データには含めない） -->
            <div id="budgetBox" class="hidden mt-3 border border-gray-200 rounded-lg bg-gray-50 px-3 py-2.5 text-sm"></div>` : ''}
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
          clearBudget();
          return;
        }

        const found = MANSIONS.find(m => m.number === num);
        if (found) {
          resultEl.innerHTML = '<span class="text-[#2E5580] font-bold mr-2">' + found.number + '</span><span class="font-semibold text-gray-800">' + found.name + '</span>';
          resultEl.className = 'px-3 py-2 border-2 border-[#5B8AB5] rounded-lg text-sm bg-[#EEF4FA] min-h-[38px] flex items-center gap-1';
          notFoundEl.classList.add('hidden');
          idInput.value = found.id;
          scheduleBudget(found.number);
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
          clearBudget();
        }
      }

      // ===== 予算書表示（請求回覧のサーバーが Googleドライブから予算書を探す）=====
      const BUDGET_ENABLED = ${budgetEnabled ? 'true' : 'false'};
      let budgetTimer = null;
      let budgetSeq = 0;
      let budgetNo = '';
      function escHtml(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function(ch) {
          return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
        });
      }
      function budgetDate(t) { return t ? String(t).slice(0, 10) : ''; }
      function clearBudget() {
        if (!BUDGET_ENABLED) return;
        if (budgetTimer) { clearTimeout(budgetTimer); budgetTimer = null; }
        budgetSeq++; budgetNo = '';
        const box = document.getElementById('budgetBox');
        if (box) { box.innerHTML = ''; box.classList.add('hidden'); }
      }
      // 番号が確定してから問い合わせる（入力途中では呼ばない）
      function scheduleBudget(no) {
        if (!BUDGET_ENABLED) return;
        clearBudget();
        budgetTimer = setTimeout(function() { loadBudget(String(no), false); }, 500);
      }
      function openBudgetFile(id) {
        window.open('/api/budget-file/' + encodeURIComponent(id), '_blank', 'noopener');
      }
      async function loadBudget(no, refresh) {
        const box = document.getElementById('budgetBox');
        if (!box) return;
        const seq = ++budgetSeq;
        budgetNo = no;
        box.classList.remove('hidden');
        box.innerHTML = '<p class="text-gray-500 text-xs">予算書を確認しています…</p>';
        let data = null;
        try {
          const res = await fetch('/api/budget?no=' + encodeURIComponent(no) + (refresh ? '&refresh=1' : ''), { headers: { Accept: 'application/json' } });
          const type = res.headers.get('Content-Type') || '';
          data = type.indexOf('application/json') > -1 ? await res.json() : { error: '予算書を取得できませんでした' };
        } catch (e) {
          data = { error: '予算書を取得できませんでした。時間をおいて再度お試しください' };
        }
        if (seq !== budgetSeq) return; // 古いリクエストの結果は表示しない
        renderBudget(box, data);
      }
      function renderBudget(box, d) {
        const refreshLink = '<button type="button" onclick="loadBudget(budgetNo, true)" class="text-xs text-[#396999] hover:underline whitespace-nowrap">最新の状態を確認</button>';
        if (!d || d.error || d.status !== 'ok') {
          const msg = (d && (d.error || d.message)) || '予算書を取得できませんでした';
          box.innerHTML = '<div class="flex items-start justify-between gap-2"><p class="text-xs text-gray-500">📒 ' + escHtml(msg) + '</p>' + refreshLink + '</div>';
          return;
        }
        const row = function(f) {
          return '<div class="flex items-center gap-2 py-1">' +
            '<span class="flex-1 min-w-0 truncate text-gray-800" title="' + escHtml(f.name) + '">' + escHtml(f.name) + '</span>' +
            '<span class="text-xs text-gray-400 whitespace-nowrap">' + escHtml(budgetDate(f.modified_time)) + '</span>' +
            '<button type="button" data-id="' + escHtml(f.id) + '" onclick="openBudgetFile(this.dataset.id)" class="px-2.5 py-1 bg-[#396999] text-white text-xs rounded-md hover:bg-[#2E5580] whitespace-nowrap">開く</button>' +
            '</div>';
        };
        const folder = d.ki_folder_name ? '（' + escHtml(d.ki_folder_name) + 'フォルダ）' : '';
        let html = '<div class="flex items-center justify-between gap-2 mb-1"><p class="text-xs font-semibold text-gray-600">📒 予算書' + folder + '</p>' + refreshLink + '</div>';
        if (d.from_older_ki) {
          html += '<p class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-1">⚠ 最新の' + escHtml(d.latest_ki_folder_name) + 'フォルダに予算書が無いため、' + escHtml(d.ki_folder_name) + 'フォルダの予算書を表示しています</p>';
        }
        if (d.latest) html += row(d.latest);
        const older = Array.isArray(d.older) ? d.older : [];
        if (older.length > 0) {
          html += '<details class="mt-1"><summary class="text-xs text-gray-500 cursor-pointer select-none">以前の版を表示（' + older.length + '件）</summary>' +
            '<div class="pl-3 border-l border-gray-200 mt-1">' + older.map(row).join('') + '</div></details>';
        }
        box.innerHTML = html;
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
      ${estRow && estRow.mansion_number != null ? `
      // 管理簿から来た場合: 物件番号を入力済みにする
      (function() {
        const el = document.getElementById('mansionNumberInput');
        if (el) { el.value = '${Number(estRow.mansion_number)}'; searchMansion(el.value); }
      })();` : ''}
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

  // 管理簿の見積書から登録した場合: 管理簿を「登録・送信済」にして紐付け
  const estimateId = parseInt(String(body.estimate_id || '')) || null
  if (estimateId) {
    await db.prepare(`
      UPDATE estimate_ledger SET status = 'sent', inbox_id = ?, sent_at = datetime('now'),
        invoiced_at = COALESCE(invoiced_at, datetime('now')), invoiced_by = COALESCE(invoiced_by, ?), updated_at = datetime('now')
      WHERE id = ?
    `).bind(inboxId, user.uid, estimateId).run().catch((e: any) => console.error('[estimate-ledger] link', e))
  }

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
      // 既定はブラウザ内表示（プレビュー用）。?dl=1 のときのみダウンロード
      'Content-Disposition': `${c.req.query('dl') ? 'attachment' : 'inline'}; filename*=UTF-8''${fileName}`
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

  // 管理簿と紐付いていれば「② 請求書作成済」に戻す
  await db.prepare(
    "UPDATE estimate_ledger SET status = 'invoiced', inbox_id = NULL, sent_at = NULL, updated_at = datetime('now') WHERE inbox_id = ?"
  ).bind(id).run().catch(() => {})

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


// ============================================================
// 見積書・請求書作成 管理簿（業務管理課・管理者）
//   元請の回覧で 業務管理課(Step2)承認時に見積書をGoogleドライブへ自動保存し、ここに1行追加される
// ============================================================
const LEDGER_STATUS: Record<string, { label: string; cls: string }> = {
  saved:    { label: '① 見積保存済（請求書未作成）', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
  invoiced: { label: '② 請求書作成済',               cls: 'bg-blue-100 text-blue-800 border-blue-300' },
  sent:     { label: '③ 登録・送信済',               cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
}
function fmtJstDate(v: any): string {
  if (!v) return '-'
  const iso = String(v).includes('T') ? String(v) : String(v).replace(' ', 'T') + 'Z'
  const t = Date.parse(iso)
  if (isNaN(t)) return String(v)
  const d = new Date(t + 9 * 3600 * 1000)
  const z = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}/${z(d.getUTCMonth() + 1)}/${z(d.getUTCDate())}`
}

inbox.get('/estimates', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')
  const db = c.env.DB
  const filter = ['saved', 'invoiced', 'sent'].includes(c.req.query('status') || '') ? c.req.query('status')! : 'open'
  const q = String(c.req.query('q') || '').trim()

  const rows = ((await db.prepare(`
    SELECT e.*, a.application_number, a.status AS app_status, u.name AS applicant_name, ub.name AS invoiced_by_name,
           ii.status AS inbox_status
    FROM estimate_ledger e
    LEFT JOIN applications a ON a.id = e.application_id
    LEFT JOIN users u ON u.id = e.applicant_id
    LEFT JOIN users ub ON ub.id = e.invoiced_by
    LEFT JOIN invoice_inbox ii ON ii.id = e.inbox_id
    ORDER BY e.id DESC
  `).all().catch(() => ({ results: [] }))).results || []) as any[]

  const counts: Record<string, number> = { saved: 0, invoiced: 0, sent: 0 }
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1
  const list = rows.filter(r => {
    if (filter === 'open' ? r.status === 'sent' : r.status !== filter) return false
    if (!q) return true
    const hay = `${r.mansion_number ?? ''} ${String(r.mansion_number ?? '').padStart(3, '0')} ${r.mansion_name || ''} ${r.application_number || ''} ${r.applicant_name || ''}`
    return hay.includes(q)
  })
  const driveFails = rows.filter(r => r.drive_status === 'failed' || r.drive_status === 'skipped').length
  const flash = c.req.query('msg') || ''
  const flashErr = c.req.query('err') || ''

  const tab = (key: string, label: string, n: number | null) => `
    <a href="/inbox/estimates?status=${key}${q ? `&q=${encodeURIComponent(q)}` : ''}"
       class="px-3 py-1.5 rounded-lg text-xs font-semibold border ${filter === key ? 'bg-[#396999] text-white border-[#396999]' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}">
      ${label}${n != null ? ` <span class="ml-1">${n}</span>` : ''}
    </a>`

  const driveCell = (r: any) => {
    if (r.drive_status === 'success') {
      return `<a href="${escAttr(r.drive_file_url)}" target="_blank" rel="noopener" class="text-[#396999] hover:underline text-xs break-all">📁 ${escAttr(r.drive_file_name || 'Googleドライブ')}</a>`
    }
    const label = r.drive_status === 'pending' ? '⏳ 保存中' : r.drive_status === 'skipped' ? '⚠️ 未保存（保存先未設定）' : '⚠️ 保存失敗'
    return `<div class="text-xs text-red-600">${label}</div>
      ${r.drive_error ? `<div class="text-[11px] text-gray-500 break-all">${escAttr(String(r.drive_error).slice(0, 120))}</div>` : ''}
      <form method="POST" action="/inbox/estimates/${r.id}/retry-drive" class="mt-1">
        <button class="text-[11px] px-2 py-0.5 border border-red-300 text-red-700 rounded hover:bg-red-50">🔄 再保存</button>
      </form>`
  }

  const actionCell = (r: any) => {
    if (r.status === 'saved') return `
      <form method="POST" action="/inbox/estimates/${r.id}/invoiced" onsubmit="return confirm('この見積書の請求書を作成済みにしますか？')">
        <button class="w-full text-xs px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-semibold whitespace-nowrap">✏️ 請求書作成済にする</button>
      </form>
      <a href="/inbox/new?estimate_id=${r.id}" class="block mt-1 text-center text-xs px-2.5 py-1.5 bg-orange-500 hover:bg-orange-600 text-white rounded font-semibold whitespace-nowrap">📤 この見積から請求書を登録</a>`
    if (r.status === 'invoiced') return `
      <a href="/inbox/new?estimate_id=${r.id}" class="block text-center text-xs px-2.5 py-1.5 bg-orange-500 hover:bg-orange-600 text-white rounded font-semibold whitespace-nowrap">📤 この見積から請求書を登録</a>
      <form method="POST" action="/inbox/estimates/${r.id}/undo" onsubmit="return confirm('「① 見積保存済」に戻しますか？')" class="mt-1 text-center">
        <button class="text-[11px] text-gray-500 hover:underline">↩ 未作成に戻す</button>
      </form>`
    return `<div class="text-xs text-gray-600">登録日: ${fmtJstDate(r.sent_at)}</div>
      ${r.inbox_id ? `<a href="/inbox" class="text-[11px] text-[#396999] hover:underline">請求書受付管理で確認 →</a>` : ''}`
  }

  const content = `
    <div class="space-y-4">
      ${flash ? `<div class="bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm px-4 py-2.5 rounded-lg">✅ ${escAttr(flash)}</div>` : ''}
      ${flashErr ? `<div class="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2.5 rounded-lg">⚠️ ${escAttr(flashErr)}</div>` : ''}
      ${!estimateFolderConfigured(c.env) ? `<div class="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2.5 rounded-lg">⚠️ Googleドライブの保存先が設定されていません。見積書は管理簿には載りますが、ドライブには保存されません。</div>` : ''}
      ${driveFails ? `<div class="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2.5 rounded-lg">⚠️ Googleドライブに保存できていない見積書が ${driveFails}件 あります。「🔄 再保存」を押してください（続く場合は保存先フォルダの権限をご確認ください）。</div>` : ''}
      <div class="bg-white rounded-xl shadow-sm border border-gray-100">
        <div class="px-6 py-4 border-b border-gray-100 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="font-semibold text-gray-800">📒 見積書・請求書作成 管理簿</h2>
              <p class="text-xs text-gray-500 mt-1">会社（TD）元請の回覧は、業務管理課の承認時に見積書が自動でGoogleドライブへ保存され、ここに追加されます。</p>
            </div>
            <div class="flex items-center gap-2">
              <form method="POST" action="/inbox/estimates/check-folder">
                <button class="text-xs px-3 py-1.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 whitespace-nowrap">🔌 保存先の接続確認</button>
              </form>
              <a href="https://drive.google.com/drive/folders/${escAttr(c.env.ESTIMATE_FOLDER_ID || '')}" target="_blank" rel="noopener"
                 class="text-xs px-3 py-1.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 whitespace-nowrap">📁 保存先フォルダを開く</a>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            ${tab('open', '未完了（①＋②）', counts.saved + counts.invoiced)}
            ${tab('saved', '① 見積保存済', counts.saved)}
            ${tab('invoiced', '② 請求書作成済', counts.invoiced)}
            ${tab('sent', '③ 登録・送信済', counts.sent)}
            <form method="GET" action="/inbox/estimates" class="ml-auto flex items-center gap-1">
              <input type="hidden" name="status" value="${filter}">
              <input type="text" name="q" value="${escAttr(q)}" placeholder="物件№・物件名・申請番号"
                class="px-2.5 py-1.5 border border-gray-300 rounded-lg text-xs w-48 focus:ring-2 focus:ring-[#396999] outline-none">
              <button class="text-xs px-3 py-1.5 bg-gray-700 text-white rounded-lg">検索</button>
            </form>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-slate-800 text-white">
              <tr>
                <th class="px-3 py-3 text-left text-xs font-semibold w-24">保存日</th>
                <th class="px-3 py-3 text-left text-xs font-semibold">物件</th>
                <th class="px-3 py-3 text-left text-xs font-semibold w-40">元の回覧</th>
                <th class="px-3 py-3 text-left text-xs font-semibold w-56">見積書（Googleドライブ）</th>
                <th class="px-3 py-3 text-left text-xs font-semibold w-48">状態</th>
                <th class="px-3 py-3 text-left text-xs font-semibold w-52">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              ${list.length === 0 ? `<tr><td colspan="6" class="px-4 py-10 text-center text-gray-400">該当する見積書はありません</td></tr>` :
                list.map(r => {
                  const st = LEDGER_STATUS[r.status] || { label: r.status, cls: 'bg-gray-100 text-gray-600 border-gray-300' }
                  const num = r.mansion_number != null ? String(r.mansion_number).padStart(3, '0') : '-'
                  return `
                  <tr class="hover:bg-gray-50 align-top">
                    <td class="px-3 py-3 text-xs text-gray-600">${fmtJstDate(r.created_at)}</td>
                    <td class="px-3 py-3">
                      <div class="font-medium text-gray-800"><span class="font-mono text-xs text-gray-500 mr-1">${num}</span>${escAttr(r.mansion_name || '')}${r.is_test ? ' <span class="text-[10px] bg-yellow-100 text-yellow-800 px-1.5 rounded">テスト</span>' : ''}</div>
                      <div class="text-xs text-gray-500 mt-0.5">申請者: ${escAttr(r.applicant_name || '-')}</div>
                    </td>
                    <td class="px-3 py-3 text-xs">
                      ${r.application_number ? `<a href="/applications/${r.application_id}" class="text-[#396999] hover:underline font-mono">${escAttr(r.application_number)}</a>` : '-'}
                    </td>
                    <td class="px-3 py-3">
                      ${driveCell(r)}
                      <div class="mt-1">${previewBtn(`/inbox/estimates/${r.id}/file`, r.original_file_name || '見積書', '👁 見積書を確認', 'text-[11px] px-2 py-0.5 border border-[#396999] text-[#396999] rounded hover:bg-[#EEF4FA]')}</div>
                    </td>
                    <td class="px-3 py-3">
                      <span class="inline-block text-xs font-semibold px-2 py-0.5 rounded-full border ${st.cls}">${st.label}</span>
                      ${r.invoiced_at ? `<div class="text-[11px] text-gray-500 mt-1">作成: ${fmtJstDate(r.invoiced_at)}${r.invoiced_by_name ? `（${escAttr(r.invoiced_by_name)}）` : ''}</div>` : ''}
                    </td>
                    <td class="px-3 py-3">${actionCell(r)}</td>
                  </tr>`
                }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `
  return c.html(layout('見積書・請求書作成 管理簿', content, user))
})

// 見積書ファイルの表示（R2）
inbox.get('/estimates/:id/file', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')
  const row = await c.env.DB.prepare('SELECT r2_key, original_file_name FROM estimate_ledger WHERE id = ?').bind(c.req.param('id')).first() as any
  if (!row) return c.notFound()
  const obj = await c.env.R2.get(row.r2_key)
  if (!obj) return c.notFound()
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/pdf',
      'Content-Disposition': `${c.req.query('dl') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(row.original_file_name || 'estimate.pdf')}`,
    }
  })
})

// ② 請求書作成済にする
inbox.post('/estimates/:id/invoiced', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')
  await c.env.DB.prepare(
    "UPDATE estimate_ledger SET status = 'invoiced', invoiced_at = datetime('now'), invoiced_by = ?, updated_at = datetime('now') WHERE id = ? AND status = 'saved'"
  ).bind(user.uid, c.req.param('id')).run()
  return c.redirect('/inbox/estimates?msg=' + encodeURIComponent('請求書作成済にしました'))
})

// ① に戻す（② → ①）
inbox.post('/estimates/:id/undo', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')
  await c.env.DB.prepare(
    "UPDATE estimate_ledger SET status = 'saved', invoiced_at = NULL, invoiced_by = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'invoiced'"
  ).bind(c.req.param('id')).run()
  return c.redirect('/inbox/estimates?msg=' + encodeURIComponent('「① 見積保存済」に戻しました'))
})

// 保存先フォルダの接続確認（読み取りのみ・ファイルは作らない）
inbox.post('/estimates/check-folder', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')
  if (!estimateFolderConfigured(c.env)) return c.redirect('/inbox/estimates?err=' + encodeURIComponent('保存先が設定されていません'))
  try {
    const r = await new DriveClient({ ...(c.env as any), DRIVE_ROOT_FOLDER_ID: c.env.ESTIMATE_FOLDER_ID }).healthCheck()
    if (r.ok) {
      return c.redirect('/inbox/estimates?msg=' + encodeURIComponent(`保存先フォルダ「${r.folderName || ''}」に接続できました${r.driveId ? '（共有ドライブ）' : '（マイドライブのため保存できない可能性があります）'}`))
    }
    return c.redirect('/inbox/estimates?err=' + encodeURIComponent(`保存先フォルダに接続できません（${r.code || ''} ${r.message || ''}）。Googleドライブ自動保存で使っているアカウントを、このフォルダの「編集者」に追加してください`))
  } catch (e: any) {
    return c.redirect('/inbox/estimates?err=' + encodeURIComponent('接続確認に失敗しました: ' + String(e?.message || e).slice(0, 200)))
  }
})

// Googleドライブへ再保存
inbox.post('/estimates/:id/retry-drive', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')
  const r = await saveLedgerToDrive(c.env, Number(c.req.param('id')))
  const msg = r === 'success' || r === 'already_saved' ? 'Googleドライブに保存しました' : 'Googleドライブに保存できませんでした（エラー内容は一覧に表示されています）'
  return c.redirect('/inbox/estimates?status=open&msg=' + encodeURIComponent(msg))
})

export default inbox
