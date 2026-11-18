// ============================================================
// リマインドの日付ルール（すべて日本時間で判断）
//   ・送らない日：日曜日 / 国民の祝日（振替休日・国民の休日を含む）/ 年末年始（12/29〜1/4）
//   ・土曜日は送る
//   ・「N日ごと」は、実際に送った日（初回は送信・申請した日）から N日後
//     その日が送らない日なら、次の送れる日に送る
// ============================================================

const pad = (n: number) => String(n).padStart(2, '0')
const toDateStr = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
const split = (ds: string) => ds.split('-').map(Number) as [number, number, number]

// DBの日時（'2026-11-17 03:13:37' や '2026-11-17T02:43:20.741Z'。どちらもUTC）を Date に
export function parseUtc(v: any): Date | null {
  if (v instanceof Date) return v
  if (!v) return null
  let s = String(v).trim()
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) s = s.replace(' ', 'T') + 'Z'
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

// 日本時間の日付（YYYY-MM-DD）
export function jstDate(v: any = new Date()): string | null {
  const d = parseUtc(v)
  if (!d) return null
  const j = new Date(d.getTime() + 9 * 3600 * 1000)
  return toDateStr(j.getUTCFullYear(), j.getUTCMonth() + 1, j.getUTCDate())
}

export function addDays(ds: string, n: number): string {
  const [y, m, d] = split(ds)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return toDateStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

export function dayOfWeek(ds: string): number {
  const [y, m, d] = split(ds)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

const WEEK_JA = ['日', '月', '火', '水', '木', '金', '土']
// 例: 11/19（木）
export function fmtDateJa(ds: string): string {
  const [, m, d] = split(ds)
  return `${m}/${d}（${WEEK_JA[dayOfWeek(ds)]}）`
}

function nthMonday(y: number, m: number, n: number): string {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  const firstMonday = 1 + ((1 - first + 7) % 7)
  return toDateStr(y, m, firstMonday + (n - 1) * 7)
}

// 国民の祝日（祝日法に基づく計算。毎年の登録は不要）
const holidayCache: Record<number, Map<string, string>> = {}
export function japaneseHolidays(y: number): Map<string, string> {
  if (holidayCache[y]) return holidayCache[y]
  const h = new Map<string, string>()
  const add = (m: number, d: number, name: string) => h.set(toDateStr(y, m, d), name)
  const k = y - 1980
  add(1, 1, '元日')
  h.set(nthMonday(y, 1, 2), '成人の日')
  add(2, 11, '建国記念の日')
  add(2, 23, '天皇誕生日')
  add(3, Math.floor(20.8431 + 0.242194 * k - Math.floor(k / 4)), '春分の日')
  add(4, 29, '昭和の日')
  add(5, 3, '憲法記念日')
  add(5, 4, 'みどりの日')
  add(5, 5, 'こどもの日')
  h.set(nthMonday(y, 7, 3), '海の日')
  add(8, 11, '山の日')
  h.set(nthMonday(y, 9, 3), '敬老の日')
  add(9, Math.floor(23.2488 + 0.242194 * k - Math.floor(k / 4)), '秋分の日')
  h.set(nthMonday(y, 10, 2), 'スポーツの日')
  add(11, 3, '文化の日')
  add(11, 23, '勤労感謝の日')
  // 国民の休日（祝日に挟まれた日）
  for (const ds of [...h.keys()].sort()) {
    const mid = addDays(ds, 1)
    if (h.has(addDays(ds, 2)) && !h.has(mid) && dayOfWeek(mid) !== 0) h.set(mid, '国民の休日')
  }
  // 振替休日（祝日が日曜日なら、その後の最初の祝日でない日）
  for (const ds of [...h.keys()].sort()) {
    if (dayOfWeek(ds) !== 0) continue
    let d = addDays(ds, 1)
    while (h.has(d)) d = addDays(d, 1)
    h.set(d, '振替休日')
  }
  holidayCache[y] = h
  return h
}

// 送らない日なら理由を返す（送れる日は null）
export function noSendReason(ds: string): string | null {
  const [y, m, d] = split(ds)
  if ((m === 12 && d >= 29) || (m === 1 && d <= 4)) return '年末年始'
  if (dayOfWeek(ds) === 0) return '日曜日'
  return japaneseHolidays(y).get(ds) || null
}

// その日以降で最初の「送れる日」
export function nextSendDay(ds: string): string {
  let d = ds
  for (let i = 0; i < 60 && noSendReason(d); i++) d = addDays(d, 1)
  return d
}

// 次にリマインドを送る日（基準日時 + N日。送らない日なら次の送れる日）
export function remindDueDate(baseUtc: any, intervalDays: number): string | null {
  const b = jstDate(baseUtc)
  if (!b) return null
  return nextSendDay(addDays(b, Math.max(1, intervalDays)))
}

// これから先の送らない日の一覧（画面表示・スケジュール例の計算用）
export function noSendDays(fromDs: string, days: number): { date: string; reason: string }[] {
  const out: { date: string; reason: string }[] = []
  for (let i = 0; i < days; i++) {
    const d = addDays(fromDs, i)
    const r = noSendReason(d)
    if (r) out.push({ date: d, reason: r })
  }
  return out
}

// 送信スケジュールの例（startDs に送った場合の、1回目〜count回目の送信日）
//   shiftedFrom: 本来の予定日（送らない日だったため後ろへずれた場合のみ）
export function scheduleFrom(startDs: string, intervalDays: number, count: number): { date: string; shiftedFrom?: string; reason?: string }[] {
  const out: { date: string; shiftedFrom?: string; reason?: string }[] = []
  let base = startDs
  for (let i = 0; i < count; i++) {
    const planned = addDays(base, Math.max(1, intervalDays))
    const date = nextSendDay(planned)
    out.push(date === planned ? { date } : { date, shiftedFrom: planned, reason: noSendReason(planned) || '' })
    base = date   // 実際に送った日から数える
  }
  return out
}

// 次の自動実行（毎朝8:00 日本時間）。送らない日は飛ばして、次の送れる日の8:00
export function nextAutoRunDate(now: Date = new Date()): string {
  const j = new Date(now.getTime() + 9 * 3600 * 1000)
  let ds = toDateStr(j.getUTCFullYear(), j.getUTCMonth() + 1, j.getUTCDate())
  if (j.getUTCHours() >= 8) ds = addDays(ds, 1)
  return nextSendDay(ds)
}
