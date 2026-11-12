// 物件担当マスタ（一元管理システム）→ マンション管理マスタ への担当者同期
//   - 読み取り専用の参照APIから取得し、mansions の front/supervisor/accounting だけを更新する
//   - 物件名は反映しない / マスタにしか無い物件（例: 212）は追加しない
//   - 取得失敗時は今の値のまま（何も書き換えない）
//   - 取得元: 物件担当マスタのD1（MASTER_DB, 送金依頼管理と同じ方式・読み取りのみ）
//             MASTER_DB が無く ASSIGNEE_REF_TOKEN がある場合のみ参照APIを使う
//   - どちらも無ければ同期は無効（従来どおり画面で手動編集）

const REF_URL = 'https://assignee-ref-api.kunihiro72.workers.dev/api/v1/properties'
export const SYNC_INTERVAL_MIN = 30

export const normName = (s: any) => String(s == null ? '' : s).replace(/[\s\u3000]/g, '')

export function assigneeSyncEnabled(env: any): boolean {
  return !!(env && (env.MASTER_DB || env.ASSIGNEE_REF_TOKEN))
}

type FieldKey = 'front_user_id' | 'supervisor_user_id' | 'accounting_user_id'
const FIELDS: { key: FieldKey; src: 'front' | 'mgr' | 'acct'; roles: string[]; label: string }[] = [
  { key: 'front_user_id', src: 'front', roles: ['front', 'front_supervisor'], label: 'フロント' },
  { key: 'supervisor_user_id', src: 'mgr', roles: ['front_supervisor'], label: '上長' },
  { key: 'accounting_user_id', src: 'acct', roles: ['accounting'], label: '会計' },
]

export type SyncResult = {
  ok: boolean
  message: string
  changed: { mansion_number: number; name: string; label: string; from: string; to: string }[]
  warnings: string[]
}

export async function getSyncState(db: D1Database): Promise<any> {
  try {
    return await db.prepare('SELECT * FROM assignee_sync_state WHERE id = 1').first()
  } catch {
    return null
  }
}

// 物件担当マスタのD1から直接読む（SELECTのみ）
async function readMasterDb(mdb: D1Database): Promise<{ updatedAt: string | null; items: any[] }> {
  const staff = ((await mdb.prepare('SELECT staff_id, name FROM staff').all()).results || []) as any[]
  const nameOf = new Map<string, string>()
  for (const st of staff) nameOf.set(String(st.staff_id), st.name)
  const props = ((await mdb.prepare(
    'SELECT property_no, front_id, mgr_id, acct_id, updated_at FROM properties ORDER BY property_no'
  ).all()).results || []) as any[]
  if (!props.length) throw new Error('物件担当マスタに物件がありません')
  let updatedAt: string | null = null
  const ref = (id: any) => (id ? { id, name: nameOf.get(String(id)) || null } : null)
  const items = props.map(p => {
    if (p.updated_at && (!updatedAt || p.updated_at > updatedAt)) updatedAt = p.updated_at
    return { property_no: p.property_no, front: ref(p.front_id), mgr: ref(p.mgr_id), acct: ref(p.acct_id) }
  })
  return { updatedAt, items }
}

async function fetchMaster(token: string): Promise<{ updatedAt: string | null; items: any[] }> {
  const r = await fetch(REF_URL, { headers: { authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(r.status === 401 ? '合言葉が一致しません（HTTP 401）' : `HTTP ${r.status}`)
  const data: any = await r.json()
  if (!data || !Array.isArray(data.items)) throw new Error('応答の形式が想定と異なります')
  return { updatedAt: data.updatedAt ?? null, items: data.items }
}

export async function runAssigneeSync(env: any, trigger: 'auto' | 'manual' = 'auto'): Promise<SyncResult> {
  const db: D1Database = env.DB
  const now = () => new Date().toISOString()
  if (!assigneeSyncEnabled(env)) {
    return { ok: false, message: '物件担当マスタへの接続が設定されていないため同期は無効です', changed: [], warnings: [] }
  }
  await db.prepare(
    "INSERT OR IGNORE INTO assignee_sync_state (id) VALUES (1)"
  ).run()
  await db.prepare('UPDATE assignee_sync_state SET last_attempt_at = ? WHERE id = 1').bind(now()).run()

  let master: { updatedAt: string | null; items: any[] }
  try {
    master = env.MASTER_DB ? await readMasterDb(env.MASTER_DB) : await fetchMaster(env.ASSIGNEE_REF_TOKEN)
  } catch (e: any) {
    const msg = '物件担当マスタを読み込めませんでした（' + String(e?.message || e) + '）'
    await db.prepare("UPDATE assignee_sync_state SET last_status = 'error', last_message = ? WHERE id = 1").bind(msg).run()
    return { ok: false, message: msg, changed: [], warnings: [] }
  }

  // ユーザー：氏名（空白除去）→ 役割ごとの候補
  const users = ((await db.prepare('SELECT id, name, role FROM users WHERE is_active = 1').all()).results || []) as any[]
  const userName = new Map<number, string>()
  for (const u of users) userName.set(u.id, u.name)
  const findUser = (name: string, roles: string[]): { id?: number; err?: string } => {
    const n = normName(name)
    const hits = users.filter(u => normName(u.name) === n && roles.includes(u.role))
    if (hits.length === 1) return { id: hits[0].id }
    if (hits.length === 0) {
      const anyRole = users.find(u => normName(u.name) === n)
      return { err: anyRole ? `役割が合いません（${anyRole.role}）` : 'このシステムに該当ユーザーがいません' }
    }
    return { err: '同じ氏名のユーザーが複数います' }
  }

  // マンション：物件№（数値）→ 行（複数あり得る）
  const mansions = ((await db.prepare(
    'SELECT id, name, mansion_number, front_user_id, supervisor_user_id, accounting_user_id FROM mansions WHERE mansion_number IS NOT NULL'
  ).all()).results || []) as any[]
  const byNo = new Map<number, any[]>()
  for (const m of mansions) {
    const n = parseInt(String(m.mansion_number))
    if (!Number.isFinite(n)) continue
    if (!byNo.has(n)) byNo.set(n, [])
    byNo.get(n)!.push(m)
  }

  const warnings: string[] = []
  const changed: SyncResult['changed'] = []
  const stmts: D1PreparedStatement[] = []
  for (const it of master.items) {
    const no = parseInt(String(it?.property_no ?? ''))
    if (!Number.isFinite(no)) continue
    const rows = byNo.get(no)
    if (!rows) continue // こちらに無い物件（例: 212）は追加しない
    for (const f of FIELDS) {
      const name = it?.[f.src]?.name
      if (!name) {
        // マスタ側が空なら今の値のまま（IDだけあって氏名が引けない場合は知らせる）
        if (it?.[f.src]?.id) warnings.push(`№${String(no).padStart(3, '0')} ${f.label}（${it[f.src].id}）: 物件担当マスタに氏名がありません`)
        continue
      }
      const hit = findUser(name, f.roles)
      if (!hit.id) {
        warnings.push(`№${String(no).padStart(3, '0')} ${f.label}「${name}」: ${hit.err}`)
        continue
      }
      for (const m of rows) {
        if (m[f.key] === hit.id) continue
        const fromName = m[f.key] ? (userName.get(m[f.key]) || `ID${m[f.key]}`) : '（未設定）'
        const toName = userName.get(hit.id) || name
        stmts.push(db.prepare(`UPDATE mansions SET ${f.key} = ?, updated_at = datetime('now') WHERE id = ?`).bind(hit.id, m.id))
        stmts.push(db.prepare(
          'INSERT INTO assignee_sync_log (mansion_id, mansion_number, field, old_user_id, new_user_id, old_name, new_name) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(m.id, no, f.key, m[f.key] || null, hit.id, fromName, toName))
        changed.push({ mansion_number: no, name: m.name, label: f.label, from: fromName, to: toName })
        m[f.key] = hit.id
      }
    }
  }
  if (stmts.length) await db.batch(stmts)

  const msg = changed.length ? `${changed.length}件の担当者を反映しました` : '変更はありませんでした'
  await db.prepare(
    "UPDATE assignee_sync_state SET last_status = 'ok', last_success_at = ?, last_message = ?, master_updated_at = ?, last_changed_count = ?, last_warnings = ? WHERE id = 1"
  ).bind(now(), msg, master.updatedAt, changed.length, JSON.stringify(warnings)).run()
  if (changed.length) {
    // 実際に担当者が変わった反映だけを記録（後から「変更なし」の反映があっても消えない）
    await db.prepare(
      'UPDATE assignee_sync_state SET last_change_at = ?, last_change_count = ?, last_change_trigger = ? WHERE id = 1'
    ).bind(now(), changed.length, trigger).run().catch(() => {})
  }
  return { ok: true, message: msg, changed, warnings }
}

// 画面表示のついでに、前回から30分以上経っていれば裏で同期する（表示は待たせない）
export async function maybeSyncAssignees(c: any): Promise<void> {
  try {
    if (!assigneeSyncEnabled(c.env)) return
    const st = await getSyncState(c.env.DB)
    if (!st) return // マイグレーション未適用
    const last = st.last_attempt_at ? Date.parse(st.last_attempt_at) : 0
    if (Date.now() - last < SYNC_INTERVAL_MIN * 60 * 1000) return
    const task = runAssigneeSync(c.env, 'auto').catch(e => console.error('[assignee-sync]', e))
    try { c.executionCtx.waitUntil(task) } catch { await task }
  } catch (e) {
    console.error('[assignee-sync] maybe', e)
  }
}
