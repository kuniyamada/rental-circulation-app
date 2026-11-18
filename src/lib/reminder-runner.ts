// ============================================================
// 自動リマインド（毎朝 8:00 日本時間に実行）
//   ① 受付後の申請リマインド（担当フロント宛：未申請の受付）
//   ② 承認者へのリマインド（確認待ちで止まっている人宛）
//   日付ルールは lib/business-day.ts（日曜・祝日・年末年始は送らない／実際に送った日から数える）
// ============================================================
import { logNotify } from './notify-log'
import { notifyUser } from './notify-user'
import { jstDate, remindDueDate, noSendReason, parseUtc } from './business-day'
import { notifyInbox } from '../routes/inbox'

export type ReminderRunResult = {
  ran_at: string
  today: string
  trigger: 'auto' | 'manual'
  skipped_reason?: string
  inbox: { active: boolean; targets: number; sent: number; due_later: number; max_reached: number }
  review: { active: boolean; targets: number; sent: number; failed: number; due_later: number; max_reached: number }
  dry_run?: boolean
  would_send?: { kind: '受付' | '承認'; to: string; item: string; count: number }[]
  summary?: { sent_to: string[]; failed_to: string[] }
}

// 管理者へのまとめ用：送った1件ずつの記録
type SentItem = { kind: '受付' | '承認'; to: string; item: string; count: number; ok: boolean }

const STEP_LABEL: Record<number, string> = { 1: '上長', 2: '業務管理課', 3: '最終承認者' }
const esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[ch])

// 一番新しい日時（基準日時）を選ぶ
function latest(...vals: any[]): any {
  let best: Date | null = null
  let raw: any = null
  for (const v of vals) {
    const d = parseUtc(v)
    if (d && (!best || d > best)) { best = d; raw = v }
  }
  return raw
}

function reviewReminderHtml(t: any, newCount: number, appUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;color:#333;margin:0;padding:0;background:#f5f5f5;">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#d97706;padding:20px 24px;">
      <h2 style="color:#fff;margin:0;font-size:18px;">⚠️ 承認リマインド（第${newCount}回）</h2>
      <p style="color:#fde68a;margin:4px 0 0;font-size:13px;">東京ディフェンス株式会社 建物管理部 請求回覧</p>
    </div>
    <div style="padding:24px;">
      <p style="color:#92400e;background:#fffbeb;border-left:4px solid #d97706;padding:8px 12px;border-radius:4px;">
        <strong>${esc(t.reviewer_name)} さん</strong><br>
        下記の請求書回覧について、まだ${STEP_LABEL[t.step_number] || '承認'}の確認が完了していません。<br>
        お手数ですが、ご確認をお願いします。
      </p>
      <table style="border-collapse:collapse;margin:16px 0;width:100%;">
        <tr style="border-bottom:1px solid #e5e7eb;"><td style="padding:8px 12px 8px 0;color:#6b7280;font-size:13px;white-space:nowrap;">申請番号</td><td style="padding:8px 0;font-size:13px;"><strong>${esc(t.application_number)}</strong></td></tr>
        <tr style="border-bottom:1px solid #e5e7eb;"><td style="padding:8px 12px 8px 0;color:#6b7280;font-size:13px;white-space:nowrap;">件名</td><td style="padding:8px 0;font-size:13px;">${esc(t.mansion_name || t.title)}</td></tr>
        <tr style="border-bottom:1px solid #e5e7eb;"><td style="padding:8px 12px 8px 0;color:#6b7280;font-size:13px;white-space:nowrap;">申請者</td><td style="padding:8px 0;font-size:13px;">${esc(t.applicant_name)}</td></tr>
        <tr><td style="padding:8px 12px 8px 0;color:#6b7280;font-size:13px;white-space:nowrap;">あなたの役割</td><td style="padding:8px 0;font-size:13px;"><strong>${STEP_LABEL[t.step_number] || 'レビュアー'}</strong></td></tr>
      </table>
      <a href="${esc(appUrl)}" style="display:inline-block;padding:12px 28px;background:#396999;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;margin-top:8px;">確認・承認する →</a>
    </div>
    <div style="background:#f9fafb;padding:16px 24px;border-top:1px solid #e5e7eb;">
      <p style="margin:0;font-size:11px;color:#9ca3af;">このメールは建物管理部 請求回覧から自動送信されています。返信しないでください。</p>
    </div>
  </div>
</body>
</html>`
}

export async function runReminders(db: D1Database, origin: string, trigger: 'auto' | 'manual', opts: { dryRun?: boolean } = {}): Promise<ReminderRunResult> {
  const dry = !!opts.dryRun
  const nowDate = new Date()
  const now = nowDate.toISOString()
  const today = jstDate(nowDate) as string
  const settings = (await db.prepare('SELECT * FROM reminder_settings WHERE id = 1').first() as any) || {}

  const result: ReminderRunResult = {
    ran_at: now, today, trigger,
    inbox: { active: !!settings.is_active, targets: 0, sent: 0, due_later: 0, max_reached: 0 },
    review: { active: !!settings.review_remind_is_active, targets: 0, sent: 0, failed: 0, due_later: 0, max_reached: 0 },
  }
  if (dry) { result.dry_run = true; result.would_send = [] }
  const sentItems: SentItem[] = []

  // 日曜・祝日・年末年始は送らない（自動実行のとき）
  const reason = noSendReason(today)
  if (reason && trigger === 'auto') {
    result.skipped_reason = reason
    if (!dry) await saveResult(db, result)
    return result
  }

  // ---------- ① 受付後の申請リマインド ----------
  if (settings.is_active) {
    const interval = settings.remind_interval_days || 3
    const max = settings.remind_max_count || 3
    const rows = (await db.prepare(`
      SELECT ii.id, ii.front_user_id, ii.note, ii.remind_count, ii.last_reminded_at, ii.notified_at, ii.created_at,
             m.name AS mansion_name, r.name AS registered_by_name, f.name AS front_name
      FROM invoice_inbox ii
      LEFT JOIN users f ON f.id = ii.front_user_id
      LEFT JOIN mansions m ON m.id = ii.mansion_id
      LEFT JOIN users r ON r.id = ii.registered_by
      WHERE ii.status = 'pending'
    `).all()).results as any[]
    result.inbox.targets = rows.length
    for (const it of rows) {
      if ((it.remind_count || 0) >= max) { result.inbox.max_reached++; continue }
      const base = latest(it.last_reminded_at, it.notified_at, it.created_at)
      const due = remindDueDate(base, interval)
      if (!due || due > today) { result.inbox.due_later++; continue }
      const newCount = (it.remind_count || 0) + 1
      if (dry) { result.would_send!.push({ kind: '受付', to: it.front_name || String(it.front_user_id), item: it.mansion_name || '', count: newCount }); result.inbox.sent++; continue }
      await db.prepare('UPDATE invoice_inbox SET remind_count = ?, last_reminded_at = ?, updated_at = ? WHERE id = ?')
        .bind(newCount, now, now, it.id).run()
      const delivered = await notifyInbox(db, it.front_user_id, {
        mansionName: it.mansion_name || '',
        registeredBy: it.registered_by_name || '業務管理課',
        note: it.note || '',
        appUrl: `${origin}/applications/new?inbox_id=${it.id}`,
        isReminder: true,
        remindCount: newCount,
        inboxId: it.id,
      })
      sentItems.push({ kind: '受付', to: it.front_name || '', item: it.mansion_name || '', count: newCount, ok: delivered })
      result.inbox.sent++
    }
  }

  // ---------- ② 承認者へのリマインド ----------
  if (settings.review_remind_is_active) {
    const interval = settings.review_remind_interval_days || 2
    const max = settings.review_remind_max_count || 3
    const rows = (await db.prepare(`
      SELECT cs.id AS step_id, cs.application_id, cs.step_number, cs.reviewer_id, cs.remind_count,
             cs.last_reminded_at, cs.created_at AS step_created_at, cs.acted_at AS step_acted_at,
             (SELECT MAX(p.acted_at) FROM circulation_steps p WHERE p.application_id = cs.application_id AND p.step_number < cs.step_number) AS prev_acted_at,
             a.application_number, a.title,
             u.name AS reviewer_name, u.email AS reviewer_email,
             m.name AS mansion_name, ap.name AS applicant_name
      FROM circulation_steps cs
      JOIN applications a ON a.id = cs.application_id
      JOIN users u ON u.id = cs.reviewer_id
      LEFT JOIN mansions m ON m.id = a.mansion_id
      LEFT JOIN users ap ON ap.id = a.applicant_id
      WHERE cs.status = 'pending' AND a.status = 'circulating' AND a.current_step = cs.step_number
        AND COALESCE(a.is_test, 0) = 0   -- テスト申請には送らない
    `).all()).results as any[]
    result.review.targets = rows.length
    for (const t of rows) {
      if ((t.remind_count || 0) >= max) { result.review.max_reached++; continue }
      // 確認待ちになった日時：前の人が確認した日時（1段目は申請日時）。保留の回答があればその日時
      const base = latest(t.last_reminded_at, t.prev_acted_at, t.step_acted_at, t.step_created_at)
      const due = remindDueDate(base, interval)
      if (!due || due > today) { result.review.due_later++; continue }
      const newCount = (t.remind_count || 0) + 1
      if (dry) { result.would_send!.push({ kind: '承認', to: t.reviewer_name, item: `${t.application_number} ${t.mansion_name || t.title || ''}`, count: newCount }); result.review.sent++; continue }
      const subject = `【承認リマインド第${newCount}回】${t.application_number} - ${t.mansion_name || t.title} の確認をお願いします`
      const appUrl = `${origin}/applications/${t.application_id}`
      // その人の通知設定（メール / LINE WORKS / 両方）で送る
      const r = await notifyUser(db, t.reviewer_id, {
        type: 'review_reminder', subject,
        html: reviewReminderHtml(t, newCount, appUrl),
        lwText: [
          `⚠️ 承認リマインド（第${newCount}回）`,
          `申請番号: ${t.application_number}`,
          `件名: ${t.mansion_name || t.title || ''}`,
          `申請者: ${t.applicant_name || ''}`,
          '', `${STEP_LABEL[t.step_number] || '承認'}の確認がまだです。ご確認をお願いします。`,
        ].join('\n'),
        lwButton: { label: '確認・承認する', url: appUrl },
        applicationId: t.application_id,
      })
      sentItems.push({ kind: '承認', to: t.reviewer_name || '', item: `${t.application_number} ${t.mansion_name || t.title || ''}`, count: newCount, ok: r.ok })
      if (r.ok) {
        await db.prepare('UPDATE circulation_steps SET remind_count = ?, last_reminded_at = ? WHERE id = ?').bind(newCount, now, t.step_id).run()
        result.review.sent++
      } else {
        result.review.failed++
      }
    }
  }

  // ---------- 管理者へまとめ（送った件があるときだけ） ----------
  if (!dry && sentItems.length && settings.admin_summary_active !== 0) {
    result.summary = await sendAdminSummary(db, origin, today, trigger, sentItems, settings.admin_summary_ids)
  }

  if (!dry) await saveResult(db, result)
  return result
}

// まとめの送り先：設定で選んだ人。未設定なら管理者全員（有効なユーザーだけ）
export async function adminSummaryRecipients(db: D1Database, idsJson: any): Promise<{ id: number; name: string }[]> {
  let ids: number[] | null = null
  try { const v = idsJson ? JSON.parse(idsJson) : null; if (Array.isArray(v)) ids = v.map(Number).filter(Boolean) } catch { ids = null }
  if (ids) {
    if (!ids.length) return []
    return (await db.prepare(`SELECT id, name FROM users WHERE is_active = 1 AND id IN (SELECT value FROM json_each(?)) ORDER BY id`).bind(JSON.stringify(ids)).all()).results as any[]
  }
  return (await db.prepare('SELECT id, name FROM users WHERE is_active = 1 AND is_admin = 1 ORDER BY id').all()).results as any[]
}

async function sendAdminSummary(db: D1Database, origin: string, today: string, trigger: 'auto' | 'manual', items: SentItem[], idsJson: any) {
  const out = { sent_to: [] as string[], failed_to: [] as string[] }
  const to = await adminSummaryRecipients(db, idsJson)
  if (!to.length) return out
  const [, m, d] = today.split('-').map(Number)
  const inbox = items.filter(i => i.kind === '受付')
  const review = items.filter(i => i.kind === '承認')
  const ng = items.filter(i => !i.ok).length
  const head = `${m}/${d}${trigger === 'auto' ? ' 朝' : '（手動実行）'}のリマインド ${items.length}件${ng ? `（うち送れなかった ${ng}件）` : ''}`
  const subject = `【リマインドのまとめ】${head}`
  const mark = (i: SentItem) => i.ok ? '' : '　※送れませんでした'
  const lines: string[] = [`📋 ${head}`]
  if (inbox.length) { lines.push('', `■ ① 受付後の申請リマインド（${inbox.length}件）`); for (const i of inbox) lines.push(`・${i.to}：${i.item}（${i.count}回目）${mark(i)}`) }
  if (review.length) { lines.push('', `■ ② 承認者リマインド（${review.length}件）`); for (const i of review) lines.push(`・${i.to}：${i.item}（${i.count}回目）${mark(i)}`) }
  const rowsHtml = (list: SentItem[]) => list.map(i => `<tr style="border-bottom:1px solid #e5e7eb;"><td style="padding:6px 10px 6px 0;font-size:13px;white-space:nowrap;"><strong>${esc(i.to)}</strong></td><td style="padding:6px 10px 6px 0;font-size:13px;">${esc(i.item)}</td><td style="padding:6px 0;font-size:13px;white-space:nowrap;">${i.count}回目${i.ok ? '' : ' <span style="color:#dc2626;font-weight:bold;">送れませんでした</span>'}</td></tr>`).join('')
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;color:#333;margin:0;padding:0;background:#f5f5f5;">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#396999;padding:18px 24px;">
      <h2 style="color:#fff;margin:0;font-size:17px;">📋 リマインドのまとめ</h2>
      <p style="color:#bfdbfe;margin:4px 0 0;font-size:13px;">${esc(head)}</p>
    </div>
    <div style="padding:20px 24px;">
      <p style="font-size:13px;margin:0 0 12px;">今日、次の人にリマインド（催促）を送りました。</p>
      ${inbox.length ? `<p style="font-weight:bold;font-size:14px;margin:16px 0 4px;">① 受付後の申請リマインド（${inbox.length}件）</p><table style="border-collapse:collapse;width:100%;">${rowsHtml(inbox)}</table>` : ''}
      ${review.length ? `<p style="font-weight:bold;font-size:14px;margin:16px 0 4px;">② 承認者リマインド（${review.length}件）</p><table style="border-collapse:collapse;width:100%;">${rowsHtml(review)}</table>` : ''}
      <a href="${esc(origin)}/admin/notify-logs" style="display:inline-block;margin-top:18px;padding:10px 22px;background:#396999;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;">通知履歴を見る →</a>
    </div>
    <div style="background:#f9fafb;padding:14px 24px;border-top:1px solid #e5e7eb;">
      <p style="margin:0;font-size:11px;color:#9ca3af;">このメールは建物管理部 請求回覧から自動送信されています。送り先はリマインダー設定の画面で変えられます。</p>
    </div>
  </div>
</body></html>`
  for (const u of to) {
    const r = await notifyUser(db, u.id, { type: 'reminder_summary', subject, html, lwText: lines.join('\n'), lwButton: { label: '通知履歴を見る', url: `${origin}/admin/notify-logs` } })
    ;(r.ok ? out.sent_to : out.failed_to).push(u.name)
  }
  return out
}

async function saveResult(db: D1Database, r: ReminderRunResult): Promise<void> {
  try {
    await db.prepare('UPDATE reminder_settings SET last_run_at = ?, last_run_result = ? WHERE id = 1')
      .bind(r.ran_at, JSON.stringify(r)).run()
  } catch (e) {
    console.error('[reminder] 実行結果の保存に失敗', e)
  }
}

// 画面表示用：実行結果を一文に
export function describeRun(r: ReminderRunResult | null): string {
  if (!r) return 'まだ実行されていません'
  const head = r.trigger === 'auto' ? '自動実行' : '手動実行'
  if (r.skipped_reason) return `${head}：今日は「${r.skipped_reason}」のため送信しませんでした`
  const parts: string[] = []
  parts.push(r.inbox.active ? `① 受付後リマインド ${r.inbox.sent}件送信` : '① 受付後リマインドは無効')
  parts.push(r.review.active ? `② 承認者リマインド ${r.review.sent}件送信${r.review.failed ? `（送れなかった ${r.review.failed}件）` : ''}` : '② 承認者リマインドは無効')
  if (r.summary && (r.summary.sent_to.length || r.summary.failed_to.length)) {
    parts.push(`まとめ：${r.summary.sent_to.length ? r.summary.sent_to.join('・') + 'さんへ送信' : ''}${r.summary.failed_to.length ? `（送れなかった：${r.summary.failed_to.join('・')}）` : ''}`)
  }
  return `${head}：${parts.join(' ／ ')}`
}
