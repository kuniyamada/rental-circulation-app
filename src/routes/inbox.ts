import { Hono } from 'hono'
import { getSessionUser, getSessionIdFromCookie } from '../lib/auth'
import { layout } from './layout'
import { sendMail, sendMailDetailed, buildInboxNotificationBody, buildInboxBulkNotificationBody } from '../lib/mail'
import { logNotify, NOTIFY_TYPE_LABEL, CHANNEL_LABEL, fmtJst } from '../lib/notify-log'
import { sendLineWorksMessage, rowToConfig, type LineWorksConfigRow } from '../lib/lineworks'
import { budgetConfigured } from '../lib/budget'
import { maybeSyncAssignees } from '../lib/assignee-sync'
import { saveLedgerToDrive, estimateFolderConfigured } from '../lib/estimate-ledger'
import { DriveClient } from '../lib/drive-client'
import { INBOX_MAX_PDFS, inboxFiles, inboxFileLabel, fileOf, validPdf, putInboxPdf, deleteInboxPdfIfUnused } from '../lib/inbox-files'

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
export async function notifyInbox(
  db: D1Database,
  frontUserId: number | string,
  data: { mansionName: string; registeredBy: string; note: string; appUrl: string; isReminder: boolean; remindCount: number; inboxId?: number | string | null }
): Promise<void> {
  const type = data.isReminder ? 'inbox_remind' : 'inbox_new'
  const u = await db.prepare(
    'SELECT name, email, notify_method, lineworks_user_id FROM users WHERE id = ?'
  ).bind(frontUserId).first() as any
  const base = { type, recipientId: frontUserId, recipientName: u?.name ?? null, inboxId: data.inboxId ?? null }
  if (!u) {
    await logNotify(db, { ...base, channel: 'email', status: 'skipped', error: '担当フロントのユーザーが見つかりません' })
    return
  }
  const method = u.notify_method || 'email'
  const subject = data.isReminder
    ? `【リマインド${data.remindCount}回目】${data.mansionName} の請求書回覧申請をお願いします`
    : `【請求書受付】${data.mansionName || 'マンション'} の請求書が届きました`

  // メール
  if (method === 'email' || method === 'both') {
    const smtp = await db.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any
    if (!smtp) {
      await logNotify(db, { ...base, channel: 'email', to: u.email, subject, status: 'skipped', error: 'メール送信設定（SMTP）がありません' })
    } else if (!u.email) {
      await logNotify(db, { ...base, channel: 'email', subject, status: 'skipped', error: 'メールアドレスが登録されていません' })
    } else {
      const html = buildInboxNotificationBody({ frontName: u.name, ...data })
      const r = await sendMailDetailed(smtp, { to: u.email, subject, html })
      await logNotify(db, { ...base, channel: 'email', to: u.email, subject, status: r.ok ? 'sent' : 'failed', error: r.ok ? null : (r.error || '送信に失敗しました') })
    }
  }

  // LINE WORKS
  if (method === 'lineworks' || method === 'both') {
    const row = await db.prepare('SELECT * FROM lineworks_config WHERE is_active = 1 LIMIT 1').first() as LineWorksConfigRow | null
    if (!row) {
      await logNotify(db, { ...base, channel: 'lineworks', to: u.lineworks_user_id, subject, status: 'skipped', error: 'LINE WORKS の設定が有効になっていません' })
    } else if (!u.lineworks_user_id) {
      await logNotify(db, { ...base, channel: 'lineworks', subject, status: 'skipped', error: 'LINE WORKS のIDが登録されていません' })
    } else {
      const lines = [
        data.isReminder ? `⚠️ リマインド（${data.remindCount}回目）` : '📥 請求書受付のお知らせ',
        `マンション: ${data.mansionName}`,
        `登録: ${data.registeredBy}`,
      ]
      if (data.note) lines.push(`備考: ${data.note}`)
      lines.push('', '回覧申請をお願いします。')
      const full = lines.join('\n')
      const text = full.length > 155 ? full.substring(0, 155) + '...' : full
      let result: true | string
      try {
        result = await sendLineWorksMessage(rowToConfig(row), u.lineworks_user_id, {
          type: 'button_template',
          altText: full,
          template: { type: 'buttons', text, actions: [{ type: 'uri', label: '回覧申請を開始する', uri: data.appUrl }] },
        }, async (tokenData) => {
          const expiresAt = Math.floor(Date.now() / 1000) + Number(tokenData.expires_in || 86400)
          await db.prepare(
            'UPDATE lineworks_config SET access_token=?, refresh_token=?, token_expires_at=?, updated_at=datetime("now") WHERE is_active=1'
          ).bind(tokenData.access_token, tokenData.refresh_token || row.refresh_token || null, expiresAt).run()
        })
      } catch (e: any) {
        result = String(e?.message || e)
      }
      if (result !== true) console.error(`[LW] 請求書受付通知の送信失敗 userId=${u.lineworks_user_id}: ${result}`)
      await logNotify(db, { ...base, channel: 'lineworks', to: u.lineworks_user_id, subject, status: result === true ? 'sent' : 'failed', error: result === true ? null : String(result) })
    }
  }
}


// PDF選択欄（最大3つ：1つ目=請求書 / 2つ目以降=その他資料）。登録・編集画面で共用
function pdfPickerHtml(existing: { n: number; name: string; url: string }[], required: boolean): string {
  return `
          <div>
            <label class="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-1">
              <span>請求書PDF ${required ? '<span class="text-red-500">*</span>' : ''}</span>
              <span class="text-xs font-normal text-gray-400">最大3つ（<span id="pdfCount">0 / 3</span>）</span>
            </label>
            <p class="text-xs text-gray-500 mb-2">1つ目は「請求書」、2つ目・3つ目は「その他資料」として担当フロントの回覧申請に引き継がれます。</p>
            <div id="pdfDropZone" class="border-2 border-dashed border-gray-300 rounded-lg p-3 transition space-y-2">
              <div id="pdfList" class="space-y-2"></div>
              <button type="button" id="pdfAddBtn" onclick="InboxPdfPicker.openPicker()"
                class="w-full flex items-center justify-center gap-2 px-3 py-2.5 border border-[#AECBE5] bg-[#EEF4FA] text-[#396999] rounded-lg text-sm font-semibold hover:bg-[#D5E5F2] transition">
                <span data-label>＋ 請求書PDFを追加</span>
              </button>
              <p class="text-[11px] text-gray-400 text-center">PDF形式（1つ最大10MB）・ここにドラッグ＆ドロップもできます</p>
              <input type="file" id="pdfPicker" accept=".pdf,application/pdf" multiple class="hidden">
              <input type="file" id="pdfFiles" name="pdf_files" multiple class="hidden">
              <input type="hidden" id="pdfRemove" name="remove_files" value="">
            </div>
            <p id="pdfRequiredMsg" class="hidden text-xs text-red-600 mt-1 font-semibold">⚠️ 請求書PDFを1つ以上添付してください（必須）</p>
          </div>
          <script src="/static/inbox-pdfs.js"></script>
          <script>
            InboxPdfPicker.init({
              existing: ${JSON.stringify(existing).replace(/</g, '\\u003c')},
              inputId: 'pdfFiles', pickerId: 'pdfPicker', removeId: 'pdfRemove', listId: 'pdfList',
              addBtnId: 'pdfAddBtn', zoneId: 'pdfDropZone', countId: 'pdfCount', requiredMsgId: 'pdfRequiredMsg'
            });
          </script>`
}


// ============================================================
// まとめて登録のお知らせ（担当フロントごとに1通）
//   通知履歴は受付ごとに1行ずつ残す（一覧の「通知」列に出すため）
// ============================================================
async function notifyInboxBulk(
  db: D1Database,
  frontUserId: number,
  items: { inboxId: number; label: string; url: string }[],
  data: { registeredBy: string; note: string; dashboardUrl: string }
): Promise<void> {
  const type = 'inbox_new'
  const u = await db.prepare('SELECT name, email, notify_method, lineworks_user_id FROM users WHERE id = ?').bind(frontUserId).first() as any
  const logAll = async (e: any) => { for (const it of items) await logNotify(db, { type, recipientId: frontUserId, recipientName: u?.name ?? null, inboxId: it.inboxId, ...e }) }
  if (!u) { await logAll({ channel: 'email', status: 'skipped', error: '担当フロントのユーザーが見つかりません' }); return }
  const method = u.notify_method || 'email'
  // 件名の物件番号（同じ物件が複数なら「044×2」）
  const numCount: Record<string, number> = {}
  const numOrder: string[] = []
  for (const i of items) { const k = i.label.split(' ')[0]; if (!(k in numCount)) { numCount[k] = 0; numOrder.push(k) } numCount[k]++ }
  const head = numOrder.slice(0, 4).map(k => numCount[k] > 1 ? `${k}×${numCount[k]}` : k).join('・') + (numOrder.length > 4 ? ' ほか' : '')
  const subject = `【請求書受付】${items.length}件の請求書が届きました（${head}）`

  if (method === 'email' || method === 'both') {
    const smtp = await db.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any
    if (!smtp) await logAll({ channel: 'email', to: u.email, subject, status: 'skipped', error: 'メール送信設定（SMTP）がありません' })
    else if (!u.email) await logAll({ channel: 'email', subject, status: 'skipped', error: 'メールアドレスが登録されていません' })
    else {
      const html = buildInboxBulkNotificationBody({ frontName: u.name, registeredBy: data.registeredBy, note: data.note, items, dashboardUrl: data.dashboardUrl })
      const r = await sendMailDetailed(smtp, { to: u.email, subject, html })
      await logAll({ channel: 'email', to: u.email, subject, status: r.ok ? 'sent' : 'failed', error: r.ok ? null : (r.error || '送信に失敗しました') })
    }
  }

  if (method === 'lineworks' || method === 'both') {
    const row = await db.prepare('SELECT * FROM lineworks_config WHERE is_active = 1 LIMIT 1').first() as LineWorksConfigRow | null
    if (!row) await logAll({ channel: 'lineworks', to: u.lineworks_user_id, subject, status: 'skipped', error: 'LINE WORKS の設定が有効になっていません' })
    else if (!u.lineworks_user_id) await logAll({ channel: 'lineworks', subject, status: 'skipped', error: 'LINE WORKS のIDが登録されていません' })
    else {
      const lines = [`📥 請求書受付のお知らせ（${items.length}件）`, ...items.map(i => `・${i.label}`), `登録: ${data.registeredBy}`]
      if (data.note) lines.push(`備考: ${data.note}`)
      lines.push('', '回覧申請をお願いします。')
      const full = lines.join('\n')
      const text = full.length > 155 ? full.substring(0, 155) + '...' : full
      let result: true | string
      try {
        result = await sendLineWorksMessage(rowToConfig(row), u.lineworks_user_id, {
          type: 'button_template',
          altText: full,
          template: { type: 'buttons', text, actions: [{ type: 'uri', label: '届いた請求書を見る', uri: data.dashboardUrl }] },
        }, async (tokenData) => {
          const expiresAt = Math.floor(Date.now() / 1000) + Number(tokenData.expires_in || 86400)
          await db.prepare(
            'UPDATE lineworks_config SET access_token=?, refresh_token=?, token_expires_at=?, updated_at=datetime("now") WHERE is_active=1'
          ).bind(tokenData.access_token, tokenData.refresh_token || row.refresh_token || null, expiresAt).run()
        })
      } catch (e: any) { result = String(e?.message || e) }
      if (result !== true) console.error(`[LW] まとめて登録の通知失敗 userId=${u.lineworks_user_id}: ${result}`)
      await logAll({ channel: 'lineworks', to: u.lineworks_user_id, subject, status: result === true ? 'sent' : 'failed', error: result === true ? null : String(result) })
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
      m.mansion_number,
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

  // タブの件数
  const countRows = (await db.prepare('SELECT status, COUNT(*) AS n FROM invoice_inbox GROUP BY status').all()).results as any[]
  const counts: Record<string, number> = { all: 0 }
  for (const r of countRows) { counts[r.status] = r.n; counts.all += r.n }

  // 通知履歴（受付ごと）
  const logsRes = await db.prepare(
    'SELECT * FROM notify_logs WHERE inbox_id IS NOT NULL ORDER BY id DESC LIMIT 5000'
  ).all().catch(() => ({ results: [] as any[] }))
  const logsByInbox: Record<string, any[]> = {}
  for (const l of (logsRes.results as any[])) (logsByInbox[l.inbox_id] ||= []).push(l)

  const esc = escAttr
  const notifyCell = (inboxId: any, remindCount: number): string => {
    const logs = logsByInbox[inboxId] || []
    const remind = remindCount > 0 ? `<span class="text-orange-600 whitespace-nowrap">🔁再通知${remindCount}回</span>` : ''
    if (logs.length === 0) return `<div class="text-xs flex flex-wrap items-center gap-x-2">${remind}<span class="text-gray-300">記録なし</span></div>`
    // チャネルごとの最新結果
    const latest: any[] = []
    const seen = new Set<string>()
    for (const l of logs) { if (!seen.has(l.channel)) { seen.add(l.channel); latest.push(l) } }
    const line = (l: any) => {
      const ch = CHANNEL_LABEL[l.channel] || l.channel
      if (l.status === 'sent') return `<span class="text-green-700 whitespace-nowrap" title="${esc(ch)}で送信">✅${l.channel === 'email' ? '' : 'LW '}${fmtJst(l.created_at)}</span>`
      const label = l.status === 'failed' ? '⚠️送信失敗' : '⚠️未送信'
      return `<span class="text-red-600 font-bold whitespace-nowrap cursor-help" title="${esc(ch)}：${esc(l.error || '')}">${label}</span>`
    }
    const history = logs.map((l: any) => {
      const ok = l.status === 'sent'
      const st = ok ? '<span class="text-green-700">送信済</span>' : l.status === 'failed' ? '<span class="text-red-600 font-bold">送信失敗</span>' : '<span class="text-red-600 font-bold">未送信</span>'
      return `<li class="py-1 border-t border-gray-100 first:border-0">
        <div class="whitespace-nowrap">${fmtJst(l.created_at)}　${esc(NOTIFY_TYPE_LABEL[l.notification_type] || l.notification_type)}　${esc(CHANNEL_LABEL[l.channel] || l.channel)}　${st}</div>
        <div class="text-gray-400 break-all">宛先: ${esc(l.recipient_name || '-')}${l.to_address ? '（' + esc(l.to_address) + '）' : ''}</div>
        ${ok ? '' : `<div class="text-red-500 break-all">理由: ${esc(l.error || '-')}</div>`}
      </li>`
    }).join('')
    return `<div class="text-xs flex items-start gap-x-2 whitespace-nowrap">${latest.map(line).join('')}${remind}
      <details class="relative">
        <summary class="cursor-pointer text-[#396999] hover:underline select-none w-fit whitespace-nowrap" title="お知らせの履歴を見る">履歴${logs.length > 1 ? logs.length : ''}</summary>
        <ul class="absolute right-0 z-20 mt-1 bg-white shadow-lg border border-gray-200 rounded-lg px-2 py-1 min-w-[280px] max-w-[360px] whitespace-normal">${history}</ul>
      </details></div>`
  }

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
      <!-- タブ（左）と 担当者へ送るボタン（右）を1行に -->
      <div class="flex items-end justify-between gap-3 flex-wrap border-b border-gray-200">
        <div class="flex gap-1">
          ${[['all','すべて'],['pending','未申請'],['applied','申請済'],['cancelled','キャンセル']].map(([v,l]) => `
            <a href="/inbox?status=${v}" class="px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition
              ${statusFilter === v ? 'border-[#396999] text-[#396999] bg-[#EEF4FA]' : 'border-transparent text-gray-500 hover:text-gray-700'}">
              ${l}<span class="ml-1 text-xs text-gray-400">${counts[v] ?? 0}</span>
            </a>
          `).join('')}
        </div>
        <div class="flex items-center gap-2 flex-wrap justify-end pb-2">
          <span class="text-xs font-bold text-orange-700 mr-1">📤 担当者へ送る：</span>
          <a href="/inbox/new" class="bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition flex items-center gap-2 shadow-sm">
            <span>＋</span><span>1件ずつ登録・送信</span>
          </a>
          <a href="/inbox/bulk" class="bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition flex items-center gap-2 shadow-sm">
            <span>📚</span><span>まとめて登録・送信</span>
          </a>
        </div>
      </div>

      ${c.req.query('edited') ? `
      <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-2">✅ 受付の内容を保存しました（お知らせは送っていません。必要なら「再通知」を押してください）</div>` : ''}
      ${c.req.query('edit_error') ? `
      <div class="bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg px-4 py-2">⚠ ${c.req.query('edit_error') === 'applied' ? 'この受付はすでに申請済のため編集できません' : '対象の受付が見つかりませんでした'}</div>` : ''}
      ${c.req.query('deleted') ? `
      <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-2">✅ 受付を削除しました</div>` : ''}
      ${c.req.query('delete_error') ? `
      <div class="bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg px-4 py-2">⚠ ${c.req.query('delete_error') === 'applied' ? 'この受付はすでに申請済のため削除できません' : '対象の受付が見つかりませんでした'}</div>` : ''}

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
                  <th class="px-2 py-2 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">登録日時</th>
                  <th class="px-2 py-2 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">マンション</th>
                  <th class="px-2 py-2 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">担当フロント</th>
                  <th class="px-2 py-2 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">添付PDF</th>
                  <th class="px-2 py-2 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">通知</th>
                  <th class="px-2 py-2 text-left text-xs font-semibold text-gray-500 whitespace-nowrap">状態</th>
                  <th class="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100">
                ${(items.results as any[]).map(item => {
                  const files = inboxFiles(item)
                  return `
                  <tr class="hover:bg-gray-50">
                    <td class="px-2 py-1.5 text-xs text-gray-600 whitespace-nowrap" title="登録: ${esc(item.registered_by_name || '-')}">${fmtJst(item.created_at)}<span class="ml-1 text-[11px] text-gray-400">${esc(String(item.registered_by_name || '').split(/[\s\u3000]/)[0])}</span></td>
                    <td class="px-2 py-1.5">
                      <div class="flex items-baseline gap-2 min-w-0">
                        <span class="font-semibold text-gray-800 whitespace-nowrap" title="${esc(item.mansion_name || '')}">${item.mansion_number != null ? `<span class="text-[#2E5580] mr-1">${esc(item.mansion_number)}</span>` : ''}${esc(String(item.mansion_name || '-').replace(/[\s\u3000]*管理組合$/, ''))}</span>
                        ${item.note ? `<span class="text-[11px] text-gray-500 truncate max-w-[140px] cursor-help" title="備考：${esc(item.note)}">💬<span class="hidden min-[1500px]:inline"> ${esc(item.note)}</span></span>` : ''}
                      </div>
                    </td>
                    <td class="px-2 py-1.5 whitespace-nowrap text-gray-800" title="${esc(item.front_email || '')}">${esc(item.front_name || '-')}</td>
                    <td class="px-2 py-1.5">
                      ${files.length ? `<div class="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 max-w-[250px]">${files.map(f => `<span class="inline-flex items-center gap-1 whitespace-nowrap" title="${esc(inboxFileLabel(f.n))}：${esc(f.name)}">
                          <span class="text-[10px] px-1.5 py-0.5 rounded ${f.n === 1 ? 'bg-[#396999] text-white' : 'bg-gray-200 text-gray-700'}">${f.n === 1 ? '請求書' : f.n === 2 ? '資料①' : '資料②'}</span>
                          ${previewBtn(`/inbox/${item.id}/download?n=${f.n}`, f.name, `${esc(f.name.length > 14 ? f.name.slice(0, 13) + '…' : f.name)}`, 'text-[#396999] hover:underline text-xs text-left')}
                        </span>`).join('')}</div>`
                        : '<span class="text-gray-300 text-xs">なし</span>'}
                    </td>
                    <td class="px-2 py-1.5">${notifyCell(item.id, item.remind_count || 0)}</td>
                    <td class="px-2 py-1.5 whitespace-nowrap">
                      <span class="text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${statusColor[item.status] || ''}">
                        ${statusLabel[item.status] || item.status}
                      </span>
                    </td>
                    <td class="px-2 py-1.5">
                      <div class="flex items-center gap-1 justify-end">
                        ${item.status === 'pending' ? `
                          <a href="/inbox/${item.id}/edit" class="text-xs px-2 py-1 bg-[#EEF4FA] text-[#396999] hover:bg-[#D5E5F2] rounded whitespace-nowrap transition">✏️編集</a>
                          <form method="POST" action="/inbox/${item.id}/remind" onsubmit="return confirm('${esc(item.front_name || '')}さんに再通知を送信しますか？')">
                            <button type="submit" class="text-xs px-2 py-1 bg-orange-50 text-orange-600 hover:bg-orange-100 rounded whitespace-nowrap transition">🔁再通知</button>
                          </form>
                        ` : ''}
                        ${(item.status === 'pending' || item.status === 'cancelled') ? `
                          <form method="POST" action="/inbox/${item.id}/delete" onsubmit="return confirm('この受付を削除しますか？\\n添付PDFも削除され、元に戻せません。')">
                            <button type="submit" title="この受付を削除" class="text-xs px-2 py-1 bg-red-50 text-red-600 hover:bg-red-100 rounded whitespace-nowrap transition">🗑</button>
                          </form>
                        ` : ''}
                      </div>
                    </td>
                  </tr>`
                }).join('')}
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
// ============================================================
// 請求書をまとめて登録（複数物件）
//   ファイル名「物件番号3桁＋空白＋担当者名.pdf」から物件と担当フロントを自動で入れる
//   画面から1件ずつ /inbox/bulk/item に送って受付を作り、最後に /inbox/bulk/notify で担当者ごとに1通お知らせ
// ============================================================
const BULK_MAX = 30

inbox.get('/bulk', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')
  const db = c.env.DB
  await maybeSyncAssignees(c)
  const mansions = await db.prepare("SELECT id, mansion_number, name, front_user_id FROM mansions WHERE is_active = 1 AND is_visible = 1 ORDER BY CAST(mansion_number AS INTEGER)").all()
  const frontsRes = await db.prepare("SELECT id, name, email FROM users WHERE role IN ('front', 'front_supervisor') AND is_active = 1 ORDER BY name").all()
  const isTestMode = user.is_admin && user.test_mode === 1
  const testExtra = isTestMode
    ? ((await db.prepare("SELECT id, name, email FROM users WHERE employee_number IN ('030','049') AND is_active = 1 ORDER BY employee_number").all()).results as any[])
    : []
  const testIds = new Set(testExtra.map((u: any) => u.id))
  const fronts = [...testExtra.map((u: any) => ({ ...u, test: true })), ...((frontsRes.results as any[]).filter((f: any) => !testIds.has(f.id)))]
  const data = {
    max: BULK_MAX,
    mansions: (mansions.results as any[]).map((m: any) => ({ id: m.id, number: Number(m.mansion_number), name: m.name, frontId: m.front_user_id || null })),
    fronts: fronts.map((f: any) => ({ id: f.id, name: f.name, email: f.email, test: !!f.test })),
  }
  const content = `
    <div class="max-w-screen-2xl mx-auto space-y-4">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 class="text-xl font-bold text-gray-800">📚 まとめて登録・担当者へ送信</h2>
          <p class="text-sm text-gray-500 mt-1">複数の物件の請求書PDFを一度に登録します。1物件だけのときは <a href="/inbox/new" class="text-[#396999] hover:underline">1件ずつの登録画面</a> を使ってください。</p>
        </div>
        <a href="/inbox" class="text-sm text-gray-500 hover:underline">← 請求書受付管理へ</a>
      </div>

      <div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
        <div class="font-bold mb-1">📝 ファイル名の決まり</div>
        <div>「<b>物件番号（3桁）＋空白＋担当者名</b>.pdf」にしてください。例：<code class="bg-white px-1.5 py-0.5 rounded border">005 上野.pdf</code>　<code class="bg-white px-1.5 py-0.5 rounded border">044 上野_(2).pdf</code></div>
        <div class="text-xs mt-1">物件と担当フロントは自動で入ります（担当フロントはマンション管理マスタの担当者）。同じ物件のPDFが2つあるときは、別々の受付になります。一度に最大${BULK_MAX}件までです。</div>
      </div>

      <div id="bulkDropZone" class="bg-white border-2 border-dashed border-gray-300 rounded-xl p-6 text-center cursor-pointer hover:border-[#5B8AB5] transition"
           onclick="document.getElementById('bulkPicker').click()">
        <div class="text-4xl mb-1">📄📄📄</div>
        <p class="text-sm text-gray-700 font-semibold">ここにPDFをまとめてドラッグ＆ドロップ、またはクリックして選択</p>
        <p class="text-xs text-gray-400 mt-1">PDF形式（1つ最大10MB）・あとから追加もできます</p>
        <input type="file" id="bulkPicker" accept=".pdf,application/pdf" multiple class="hidden">
      </div>

      <div id="bulkTableWrap" class="hidden bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div class="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-wrap gap-2">
          <div class="text-sm text-gray-700"><b id="bulkCount">0</b> 件 <span id="bulkSummary" class="text-xs text-gray-500 ml-2"></span></div>
          <button type="button" id="bulkClearBtn" onclick="Bulk.clearAll()" class="text-xs text-gray-500 hover:text-red-600">すべて外す</button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th class="px-3 py-2 text-left w-8">#</th>
                <th class="px-3 py-2 text-left">PDF</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">物件</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">担当フロント</th>
                <th class="px-3 py-2 text-left whitespace-nowrap">確認</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody id="bulkRows" class="divide-y divide-gray-100"></tbody>
          </table>
        </div>
      </div>

      <div id="bulkFooter" class="hidden bg-white rounded-xl shadow-sm border border-gray-100 p-4 space-y-3">
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-1">備考（全件共通・任意）</label>
          <input type="text" id="bulkNote" maxlength="200" placeholder="例：10月分 管理組合宛請求書" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#396999]">
        </div>
        <div id="bulkResult" class="hidden"></div>
        <div class="flex gap-3">
          <a href="/inbox" class="flex-1 text-center px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50">キャンセル</a>
          <button type="button" id="bulkSubmitBtn" onclick="Bulk.submit()" class="flex-[2] bg-[#396999] hover:bg-[#2E5580] text-white font-semibold px-4 py-2.5 rounded-lg text-sm transition">📤 まとめて登録して送信</button>
        </div>
      </div>
    </div>
    <script>window.BULK_DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>
    <script src="/static/inbox-bulk.js"></script>
  `
  return c.html(layout('請求書まとめて登録', content, user))
})

// 1件分の受付を作る（お知らせはまだ送らない）
inbox.post('/bulk/item', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.json({ ok: false, error: '権限がありません' }, 403)
  const db = c.env.DB
  const body = await c.req.parseBody() as any
  const mansionId = parseInt(String(body.mansion_id || '')) || 0
  const frontUserId = parseInt(String(body.front_user_id || '')) || 0
  const note = String(body.note || '').trim().slice(0, 200) || null
  const pdf = fileOf(body.pdf_file)
  if (!mansionId || !frontUserId) return c.json({ ok: false, error: '物件と担当フロントを選んでください' }, 400)
  if (!pdf) return c.json({ ok: false, error: 'PDFがありません' }, 400)
  if (!validPdf(pdf)) return c.json({ ok: false, error: 'PDFではないか、10MBを超えています' }, 400)
  const m = await db.prepare('SELECT id, name, mansion_number FROM mansions WHERE id = ?').bind(mansionId).first() as any
  if (!m) return c.json({ ok: false, error: '物件が見つかりません' }, 400)
  const f = await db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').bind(frontUserId).first()
  if (!f) return c.json({ ok: false, error: '担当フロントが見つかりません' }, 400)

  const saved = await putInboxPdf(c.env.R2, pdf, 1)
  const now = new Date().toISOString()
  const res = await db.prepare(`
    INSERT INTO invoice_inbox (mansion_id, front_user_id, registered_by, attachment_key, attachment_name, note, status, notified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).bind(mansionId, frontUserId, user.uid, saved.key, saved.name, note, now, now, now).run()
  return c.json({ ok: true, id: res.meta.last_row_id })
})

// 作った受付のお知らせを、担当フロントごとに1通にまとめて送る
inbox.post('/bulk/notify', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.json({ ok: false, error: '権限がありません' }, 403)
  const db = c.env.DB
  const body = await c.req.json().catch(() => ({})) as any
  const ids = (Array.isArray(body.ids) ? body.ids : []).map((x: any) => parseInt(x)).filter((n: number) => n > 0).slice(0, BULK_MAX)
  if (!ids.length) return c.json({ ok: true, groups: 0 })
  const rows = (await db.prepare(`
    SELECT ii.id, ii.front_user_id, ii.note, m.mansion_number, m.name AS mansion_name
    FROM invoice_inbox ii LEFT JOIN mansions m ON m.id = ii.mansion_id
    WHERE ii.id IN (${ids.map(() => '?').join(',')}) AND ii.status = 'pending' AND ii.registered_by = ?
    ORDER BY CAST(m.mansion_number AS INTEGER), ii.id
  `).bind(...ids, user.uid).all()).results as any[]
  const origin = new URL(c.req.url).origin
  const groups: Record<string, any[]> = {}
  for (const r of rows) (groups[r.front_user_id] ||= []).push(r)
  const note = rows[0]?.note || ''
  for (const [frontId, list] of Object.entries(groups)) {
    if (list.length === 1) {
      const r = list[0]
      runInBackground(c, () => notifyInbox(db, Number(frontId), {
        mansionName: r.mansion_name || '', registeredBy: user.name, note: r.note || '',
        appUrl: `${origin}/applications/new?inbox_id=${r.id}`, isReminder: false, remindCount: 0, inboxId: r.id,
      }))
    } else {
      runInBackground(c, () => notifyInboxBulk(db, Number(frontId), list.map(r => ({
        inboxId: r.id,
        label: `${r.mansion_number != null ? String(r.mansion_number).padStart(3, '0') : ''} ${r.mansion_name || ''}`.trim(),
        url: `${origin}/applications/new?inbox_id=${r.id}`,
      })), { registeredBy: user.name, note, dashboardUrl: `${origin}/` }))
    }
  }
  return c.json({ ok: true, groups: Object.keys(groups).length, count: rows.length })
})

inbox.get('/new', (c) => renderInboxForm(c, null))
inbox.get('/:id/edit', (c) => renderInboxForm(c, parseInt(c.req.param('id')) || -1))

// 登録フォーム（editId があれば編集：未申請の受付のみ。編集してもお知らせは送らない）
async function renderInboxForm(c: any, editId: number | null) {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')

  const db = c.env.DB
  const editItem = editId
    ? await db.prepare(`SELECT ii.*, m.mansion_number FROM invoice_inbox ii LEFT JOIN mansions m ON m.id = ii.mansion_id WHERE ii.id = ?`).bind(editId).first() as any
    : null
  if (editId && !editItem) return c.redirect('/inbox?edit_error=notfound')
  if (editItem && editItem.status !== 'pending') return c.redirect('/inbox?edit_error=applied')
  const isEdit = !!editItem
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
  const estimateId = isEdit ? null : (parseInt(c.req.query('estimate_id') || '') || null)
  const estRow = estimateId
    ? await db.prepare(`SELECT e.*, a.application_number FROM estimate_ledger e LEFT JOIN applications a ON a.id = e.application_id WHERE e.id = ?`).bind(estimateId).first().catch(() => null) as any
    : null

  const errKey = c.req.query('error') || ''
  const errMsg = errKey === 'pdf_required' ? '請求書PDFを添付してください（PDFがないと登録できません）'
    : errKey === 'pdf_invalid' ? 'PDFファイルを選択してください（1つ最大10MB）'
    : errKey === 'pdf_too_many' ? 'PDFは最大3つまでです'
    : errKey === 'required' ? 'マンションと担当フロントを選択してください'
    : ''

  const content = `
    <div class="max-w-xl mx-auto">
      ${errMsg ? `<div class="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2.5 rounded-lg">⚠️ ${errMsg}</div>` : ''}
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
          ${isEdit ? '✏️ 受付を編集' : '📤 1件ずつ登録・担当者へ送信'}
        </h2>
        ${!isEdit ? `<p class="-mt-4 mb-5 text-xs text-gray-500">複数の物件をまとめて送るときは <a href="/inbox/bulk" class="text-[#396999] font-semibold hover:underline">📚 まとめて登録</a> が便利です。</p>` : ''}
        ${isEdit ? `<p class="-mt-4 mb-5 text-xs text-gray-500">変更を保存しても、担当フロントへのお知らせは送りません。必要なときは一覧の「再通知」を押してください。</p>` : ''}

        <form method="POST" action="${isEdit ? `/inbox/${editItem.id}/edit` : '/inbox'}" enctype="multipart/form-data" class="space-y-5" id="inboxForm"
              onkeydown="return preventEnterSubmit(event)" onsubmit="return confirmInboxSubmit()">
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

          <!-- 請求書PDF添付（最大3つ） -->
          ${pdfPickerHtml(isEdit ? inboxFiles(editItem).map(f => ({ n: f.n, name: f.name, url: `/inbox/${editItem.id}/download?n=${f.n}` })) : [], true)}

          <!-- 備考 -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">備考</label>
            <textarea name="note" rows="3" placeholder="業者名、請求内容など補足があれば入力"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#396999] resize-none">${isEdit ? escAttr(editItem.note || '') : ''}</textarea>
          </div>

          <!-- 送信ボタン -->
          <div class="pt-2 flex gap-3">
            <a href="/inbox" class="flex-1 text-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition">
              キャンセル
            </a>
            <button type="submit" id="inboxSubmitBtn"
              class="flex-1 bg-[#396999] hover:bg-[#2E5580] text-white font-semibold px-4 py-2 rounded-lg text-sm transition flex items-center justify-center gap-2">
              ${isEdit ? '💾 変更を保存' : '📤 登録してフロントに送信'}
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

      // Enterキーで送信されないようにする（送信は「登録してフロントに送信」ボタンだけ）
      //   マンション番号欄でEnter → 担当フロントへ移動するだけ
      function preventEnterSubmit(e) {
        if (e.key !== 'Enter') return true;
        const t = e.target;
        if (!t || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'A') return true;
        e.preventDefault();
        if (t.id === 'mansionNumberInput') {
          searchMansion(t.value);
          const fs = document.getElementById('frontSelect');
          if (fs) fs.focus();
        }
        return false;
      }

      // 送信前チェック: マンション・担当フロント・PDF（必須）→ 確認ダイアログ
      const IS_EDIT = ${isEdit ? 'true' : 'false'};
      let inboxSubmitting = false;
      function confirmInboxSubmit() {
        if (inboxSubmitting) return false;
        const mansionId = document.getElementById('mansionIdInput').value;
        const fs = document.getElementById('frontSelect');
        if (!mansionId) {
          alert('マンション番号を入力してください');
          document.getElementById('mansionNumberInput').focus();
          return false;
        }
        if (!fs || !fs.value) {
          alert('担当フロントを選択してください');
          if (fs) fs.focus();
          return false;
        }
        if (InboxPdfPicker.count() === 0) {
          InboxPdfPicker.showRequired();
          alert('請求書PDFを添付してください（必須です）');
          return false;
        }
        InboxPdfPicker.sync();
        const frontName = fs.options[fs.selectedIndex].text.replace(/^★\\s*/, '').replace(/（.*$/, '').trim();
        const mansionName = (document.getElementById('mansionResult').textContent || '').replace(/\\s+/g, ' ').trim();
        const ok = confirm((IS_EDIT ? '変更を保存します。よろしいですか？（お知らせは送りません）\\n\\n担当フロント：' + frontName + '\\n' : frontName + ' さんに送信します。よろしいですか？\\n\\n')
          + 'マンション：' + mansionName + '\\n'
          + InboxPdfPicker.names().join('\\n'));
        if (!ok) return false;
        inboxSubmitting = true;
        const btn = document.getElementById('inboxSubmitBtn');
        if (btn) { btn.disabled = true; btn.classList.add('opacity-60'); btn.textContent = IS_EDIT ? '保存中…' : '送信中…'; }
        return true;
      }

      ${estRow && estRow.mansion_number != null ? `
      // 管理簿から来た場合: 物件番号を入力済みにする
      (function() {
        const el = document.getElementById('mansionNumberInput');
        if (el) { el.value = '${Number(estRow.mansion_number)}'; searchMansion(el.value); }
      })();` : ''}
      ${isEdit ? `
      // 編集: 今の内容を入れておく（マンション番号 → 担当フロントは今の担当に戻す）
      (function() {
        const el = document.getElementById('mansionNumberInput');
        ${editItem.mansion_number != null ? `if (el) { el.value = '${Number(editItem.mansion_number)}'; searchMansion(el.value); }` : ''}
        const idInput = document.getElementById('mansionIdInput');
        if (idInput && !idInput.value) idInput.value = '${Number(editItem.mansion_id)}';
        const fs = document.getElementById('frontSelect');
        if (fs) fs.value = '${Number(editItem.front_user_id)}';
      })();` : ''}
    </script>
  `
  return c.html(layout(isEdit ? '請求書受付の編集' : '請求書登録', content, user))
}

// ============================================================
// 請求書受付 登録処理
// ============================================================
inbox.post('/', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')

  const db = c.env.DB
  const r2 = c.env.R2
  const body = await c.req.parseBody({ all: true }) as any
  const one = (v: any) => Array.isArray(v) ? v[0] : v

  const mansionId = one(body.mansion_id)
  const frontUserId = one(body.front_user_id)
  const note = one(body.note) || null
  // PDF（最大3つ）。旧画面の pdf_file も受け付ける
  const rawFiles = ([] as any[]).concat(body.pdf_files ?? [], body.pdf_file ?? [])
  const pdfs = rawFiles.map(fileOf).filter(Boolean) as File[]

  const estIdRaw = one(body.estimate_id)
  const backQs = estIdRaw ? `&estimate_id=${encodeURIComponent(String(estIdRaw))}` : ''
  if (!mansionId || !frontUserId) {
    return c.redirect('/inbox/new?error=required' + backQs)
  }
  // 請求書PDFは必須（PDFなしの受付が担当フロントに届かないように）
  if (pdfs.length === 0) {
    return c.redirect('/inbox/new?error=pdf_required' + backQs)
  }
  if (pdfs.length > INBOX_MAX_PDFS) {
    return c.redirect('/inbox/new?error=pdf_too_many' + backQs)
  }
  if (!pdfs.every(validPdf)) {
    return c.redirect('/inbox/new?error=pdf_invalid' + backQs)
  }

  // PDFをR2にアップロード（1つ目=請求書、2つ目・3つ目=その他資料）
  const saved: { key: string; name: string }[] = []
  for (let i = 0; i < pdfs.length; i++) saved.push(await putInboxPdf(r2, pdfs[i], i + 1))
  const attachmentKey = saved[0]?.key || null
  const attachmentName = saved[0]?.name || null

  const now = new Date().toISOString()

  // DBに登録
  const result = await db.prepare(`
    INSERT INTO invoice_inbox
      (mansion_id, front_user_id, registered_by, attachment_key, attachment_name, attachment2_key, attachment2_name, attachment3_key, attachment3_name, note, status, notified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).bind(mansionId, frontUserId, user.uid, attachmentKey, attachmentName,
    saved[1]?.key || null, saved[1]?.name || null, saved[2]?.key || null, saved[2]?.name || null,
    note, now, now, now).run()

  const inboxId = result.meta.last_row_id

  // 管理簿の見積書から登録した場合: 管理簿を「登録・送信済」にして紐付け
  const estimateId = parseInt(String(estIdRaw || '')) || null
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
    inboxId,
  }))

  return c.redirect('/inbox?sent=1')
})

// ============================================================
// 請求書受付 編集（未申請のみ。お知らせは送らない）
//   PDF: remove_files（外した番号）を除き、新しいPDFを後ろに足して 1〜3 に詰め直す（1つ目=請求書）
// ============================================================
inbox.post('/:id/edit', async (c) => {
  const user = (c as any).get('user') as any
  if (user.role !== 'operations' && !user.is_admin) return c.redirect('/')
  const db = c.env.DB
  const id = parseInt(c.req.param('id')) || 0
  const item = await db.prepare('SELECT * FROM invoice_inbox WHERE id = ?').bind(id).first() as any
  if (!item) return c.redirect('/inbox?edit_error=notfound')
  if (item.status !== 'pending') return c.redirect('/inbox?edit_error=applied')

  const body = await c.req.parseBody({ all: true }) as any
  const one = (v: any) => Array.isArray(v) ? v[0] : v
  const mansionId = parseInt(String(one(body.mansion_id) || '')) || null
  const frontUserId = parseInt(String(one(body.front_user_id) || '')) || null
  const note = String(one(body.note) || '').trim() || null
  const back = `/inbox/${id}/edit`
  if (!mansionId || !frontUserId) return c.redirect(back + '?error=required')

  const removed = new Set(String(one(body.remove_files) || '').split(',').map(x => parseInt(x)).filter(n => n >= 1 && n <= 3))
  const kept = inboxFiles(item).filter(f => !removed.has(f.n))
  const newPdfs = ([] as any[]).concat(body.pdf_files ?? []).map(fileOf).filter(Boolean) as File[]
  if (kept.length + newPdfs.length === 0) return c.redirect(back + '?error=pdf_required')
  if (kept.length + newPdfs.length > INBOX_MAX_PDFS) return c.redirect(back + '?error=pdf_too_many')
  if (!newPdfs.every(validPdf)) return c.redirect(back + '?error=pdf_invalid')

  const finalFiles: { key: string; name: string }[] = kept.map(f => ({ key: f.key, name: f.name }))
  for (let i = 0; i < newPdfs.length; i++) finalFiles.push(await putInboxPdf(c.env.R2, newPdfs[i], finalFiles.length + 1))

  const res = await db.prepare(`
    UPDATE invoice_inbox SET mansion_id = ?, front_user_id = ?, note = ?,
      attachment_key = ?, attachment_name = ?, attachment2_key = ?, attachment2_name = ?, attachment3_key = ?, attachment3_name = ?,
      updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).bind(mansionId, frontUserId, note,
    finalFiles[0]?.key || null, finalFiles[0]?.name || null,
    finalFiles[1]?.key || null, finalFiles[1]?.name || null,
    finalFiles[2]?.key || null, finalFiles[2]?.name || null,
    new Date().toISOString(), id).run()
  if (!res.meta.changes) {
    // 保存の直前に申請された：新しく上げたPDFは片付ける
    for (const f of finalFiles.slice(kept.length)) await deleteInboxPdfIfUnused(db, c.env.R2, f.key)
    return c.redirect('/inbox?edit_error=applied')
  }
  // 外したPDFを片付ける（回覧申請などで使われていないものだけ）
  for (const f of inboxFiles(item).filter(f => removed.has(f.n))) await deleteInboxPdfIfUnused(db, c.env.R2, f.key)

  return c.redirect('/inbox?edited=1')
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

  // ?n=2 / ?n=3 で2つ目・3つ目のPDF（既定は1つ目＝請求書）
  const n = Math.min(3, Math.max(1, parseInt(c.req.query('n') || '1') || 1))
  const f = inboxFiles(item).find(x => x.n === n)
  if (!f) return c.text('添付ファイルがありません', 404)

  const obj = await r2.get(f.key)
  if (!obj) return c.notFound()

  const fileName = encodeURIComponent(f.name)
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
    inboxId: item.id,
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
    "SELECT id, status, attachment_key, attachment2_key, attachment3_key FROM invoice_inbox WHERE id = ?"
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

  // 添付PDF（R2）を削除。回覧申請の添付として使われていないものだけ消す
  for (const k of [item.attachment_key, item.attachment2_key, item.attachment3_key]) {
    await deleteInboxPdfIfUnused(db, c.env.R2, k)
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
