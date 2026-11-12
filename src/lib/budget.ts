/**
 * 予算書の検索・表示（請求回覧が自分で Googleドライブ「物件決算書類関係」を読む）
 *
 * 予算書ビューア（別システム）には問い合わせない。探し方のルールは予算書ビューアの
 * src/budget.ts（2026-11 に実データ 189フォルダ・175物件で検証済み）から移植し、
 * 年度フォルダ（例: 2025年度）にも対応させたもの。
 *
 * 物件決算書類関係/
 *   102　サンライズ大雄/        ← 先頭の数字＝物件番号（「1」「001」「１」は同じ扱い）。後ろが物件名
 *     第39期/  40期/  2025年度/  ← 期フォルダ・年度フォルダ（「第」の有無・全角半角・空白が混在）
 *       102収支予算案.pdf        ← 名前に「予算」を含むファイル
 *       102収支予算案(修正).pdf  ← 修正版・②③④ などが同じフォルダに複数ある（会計別ではなく版違い）
 *
 * ルール
 *   - 期/年度フォルダを数字の大きい順に最大3つ見て、「予算」を含むファイルが最初に見つかったフォルダを採用
 *   - その中で更新日時がいちばん新しいもの＝最新版。残りは「以前の版」
 *   - 期/年度フォルダが無い物件は、物件フォルダ直下の「予算」ファイルを見る
 *   - desktop.ini 等は無視
 *
 * Googleドライブへの接続は、Drive自動保存と同じ OAuth（GOOGLE_OAUTH_*）を使う。
 * この接続は書き込みもできる権限のため、ここでは読み取りの API だけを呼び、
 * 表示するファイルは「物件決算書類関係」の中の「予算」を含むファイルに限定する（assertViewableFile）。
 */
import { DriveClient } from './drive-client'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const ID_RE = /^[A-Za-z0-9_-]{10,200}$/

const ROOT_TTL_MS = 6 * 60 * 60 * 1000 // 物件フォルダの一覧: 6時間
const PROP_TTL_MS = 30 * 60 * 1000     // 物件ごとの結果: 30分
const MAX_KI_FOLDERS = 3

export type DriveItem = {
  id: string; name: string; mimeType: string
  modifiedTime?: string; size?: string; parents?: string[]; trashed?: boolean
}
export type Property = { no: string; name: string; folder_id: string; folder_name: string }
export type BudgetFile = { id: string; name: string; modified_time: string; size: number | null; mime_type: string }
export type BudgetResult = {
  status: 'ok' | 'no_property' | 'no_budget'
  property_no: string
  property_name?: string
  folder_name?: string
  ki_folder_name?: string
  latest_ki_folder_name?: string
  from_older_ki?: boolean
  latest?: BudgetFile
  older: BudgetFile[]
  message?: string
  checked_at: string
}

export interface BudgetEnv {
  GOOGLE_OAUTH_CLIENT_ID?: string
  GOOGLE_OAUTH_CLIENT_SECRET?: string
  GOOGLE_OAUTH_REFRESH_TOKEN?: string
  DRIVE_ROOT_FOLDER_ID?: string
  BUDGET_ROOT_FOLDER_ID?: string
}

/** 利用者に見せるエラー（code は画面には出さず、ログ・調査用） */
export class BudgetError extends Error {
  constructor(public code: string, message: string, public status = 500) {
    super(message)
  }
}

/** 必要な設定がそろっているか（そろうまで画面に予算書の欄を出さない） */
export function budgetConfigured(env: BudgetEnv): boolean {
  return !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN &&
    env.DRIVE_ROOT_FOLDER_ID && env.BUDGET_ROOT_FOLDER_ID)
}

// Workers の同じインスタンス内でだけ有効なキャッシュ（消えても再取得するだけ）
let rootCache: { at: number; folderId: string; props: Property[] } | null = null
const propCache = new Map<string, { at: number; data: BudgetResult }>()
let sharedClient: { key: string; client: DriveClient } | null = null

function getClient(env: BudgetEnv): DriveClient {
  if (!budgetConfigured(env)) {
    throw new BudgetError('BUDGET_NOT_CONFIGURED', '予算書の表示機能が設定されていません', 500)
  }
  const key = String(env.GOOGLE_OAUTH_REFRESH_TOKEN)
  if (!sharedClient || sharedClient.key !== key) {
    sharedClient = { key, client: new DriveClient(env as any) }
  }
  return sharedClient.client
}

/** Drive API（読み取り専用の GET のみ） */
async function driveGet(env: BudgetEnv, path: string): Promise<Response> {
  const client = getClient(env)
  let token: string
  try {
    token = await client.getAccessToken()
  } catch (e) {
    console.error('[budget] token error', e)
    throw new BudgetError('DRIVE_AUTH_FAILED', '予算書を取得できませんでした（Googleドライブの接続エラー）', 502)
  }
  let res = await fetch(DRIVE_API + path, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 401) {
    try { token = await client.getAccessToken(true) } catch (e) {
      console.error('[budget] token refresh error', e)
      throw new BudgetError('DRIVE_AUTH_FAILED', '予算書を取得できませんでした（Googleドライブの接続エラー）', 502)
    }
    res = await fetch(DRIVE_API + path, { headers: { Authorization: `Bearer ${token}` } })
  }
  return res
}

function assertDriveId(id: string): void {
  if (!ID_RE.test(id)) throw new BudgetError('BAD_ID', '不正なIDです', 400)
}

async function listChildren(env: BudgetEnv, folderId: string): Promise<DriveItem[]> {
  assertDriveId(folderId)
  const out: DriveItem[] = []
  let pageToken = ''
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`)
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime,size)')
    const res = await driveGet(env, `/files?q=${q}&fields=${fields}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`)
    if (res.status === 404) {
      console.error('[budget] folder not found', folderId)
      throw new BudgetError('FOLDER_NOT_FOUND', '予算書のフォルダを開けませんでした（Googleドライブの権限を確認してください）', 502)
    }
    if (res.status === 403) {
      console.error('[budget] forbidden', (await res.text()).slice(0, 200))
      throw new BudgetError('DRIVE_FORBIDDEN', '予算書のフォルダを開けませんでした（Googleドライブの権限を確認してください）', 502)
    }
    if (!res.ok) {
      console.error('[budget] list failed', res.status, (await res.text()).slice(0, 200))
      throw new BudgetError('DRIVE_FAILED', '予算書を取得できませんでした。時間をおいて再度お試しください', 502)
    }
    const data = await res.json() as { files?: DriveItem[]; nextPageToken?: string }
    out.push(...(data.files || []))
    pageToken = data.nextPageToken || ''
  } while (pageToken)
  return out
}

async function getItem(env: BudgetEnv, id: string): Promise<DriveItem | null> {
  assertDriveId(id)
  const fields = encodeURIComponent('id,name,mimeType,modifiedTime,size,parents,trashed')
  const res = await driveGet(env, `/files/${id}?fields=${fields}&supportsAllDrives=true`)
  if (res.status === 404) return null
  if (!res.ok) {
    console.error('[budget] get failed', res.status)
    throw new BudgetError('DRIVE_FAILED', '予算書を取得できませんでした。時間をおいて再度お試しください', 502)
  }
  return await res.json() as DriveItem
}

const nfkc = (s: string) => String(s ?? '').normalize('NFKC')
export function normNo(v: string): string {
  const t = nfkc(v).trim()
  if (!/^\d{1,5}$/.test(t)) return ''
  return String(parseInt(t, 10)).padStart(3, '0')
}
/** 期フォルダ（第43期・43期）または年度フォルダ（2025年度）の数字。どちらでもなければ null */
export function kiOf(name: string): number | null {
  const n = nfkc(name)
  const ki = n.match(/(\d+)\s*期/)
  if (ki) return parseInt(ki[1], 10)
  const year = n.match(/(\d{4})\s*年度/)
  if (year) return parseInt(year[1], 10)
  return null
}
const isFolder = (f: DriveItem) => f.mimeType === FOLDER_MIME
export const isBudgetName = (name: string) => /予算/.test(nfkc(name)) && name.toLowerCase() !== 'desktop.ini'

async function getProperties(env: BudgetEnv, refresh = false): Promise<Property[]> {
  const rootId = String(env.BUDGET_ROOT_FOLDER_ID)
  if (!refresh && rootCache && rootCache.folderId === rootId && Date.now() - rootCache.at < ROOT_TTL_MS) return rootCache.props
  const items = await listChildren(env, rootId)
  const props: Property[] = []
  const seen = new Set<string>()
  for (const f of items.filter(isFolder).sort((a, b) => a.name.localeCompare(b.name, 'ja'))) {
    const m = nfkc(f.name).match(/^\s*(\d{1,5})\s*(.*)$/)
    if (!m) continue
    const no = normNo(m[1])
    if (!no || seen.has(no)) continue // 同じ番号が複数あれば最初の1つ
    seen.add(no)
    props.push({ no, name: m[2].trim(), folder_id: f.id, folder_name: f.name.trim() })
  }
  props.sort((a, b) => a.no.localeCompare(b.no))
  rootCache = { at: Date.now(), folderId: rootId, props }
  return props
}

function toFile(f: DriveItem): BudgetFile {
  return { id: f.id, name: f.name, modified_time: f.modifiedTime || '', size: f.size ? Number(f.size) : null, mime_type: f.mimeType }
}
function pickBudget(items: DriveItem[]): BudgetFile[] {
  return items.filter(f => !isFolder(f) && isBudgetName(f.name)).map(toFile)
    .sort((a, b) => b.modified_time.localeCompare(a.modified_time) || b.name.localeCompare(a.name, 'ja'))
}

export async function findBudget(env: BudgetEnv, rawNo: string, refresh = false): Promise<BudgetResult> {
  const no = normNo(rawNo)
  if (!no) throw new BudgetError('BAD_NO', '物件番号は数字で入力してください', 400)
  const hit = propCache.get(no)
  if (!refresh && hit && Date.now() - hit.at < PROP_TTL_MS) return hit.data

  let props = await getProperties(env, refresh)
  let prop = props.find(p => p.no === no)
  if (!prop && !refresh) { props = await getProperties(env, true); prop = props.find(p => p.no === no) } // 新しいフォルダ対策
  const base = { property_no: no, older: [] as BudgetFile[], checked_at: new Date().toISOString() }
  let result: BudgetResult
  if (!prop) {
    result = { ...base, status: 'no_property', message: `物件番号 ${no} のフォルダが「物件決算書類関係」にありません` }
  } else {
    const kids = await listChildren(env, prop.folder_id)
    const kiFolders = kids.filter(isFolder).map(f => ({ f, ki: kiOf(f.name) }))
      .filter((x): x is { f: DriveItem; ki: number } => x.ki !== null).sort((a, b) => b.ki - a.ki)
    result = {
      ...base, status: 'no_budget', property_name: prop.name, folder_name: prop.folder_name,
      latest_ki_folder_name: kiFolders[0]?.f.name.trim(), message: 'この物件の予算書が見つかりません',
    }
    let files: BudgetFile[] = []
    for (let i = 0; i < Math.min(MAX_KI_FOLDERS, kiFolders.length); i++) {
      files = pickBudget(await listChildren(env, kiFolders[i].f.id))
      if (files.length) {
        result = { ...result, status: 'ok', message: undefined, ki_folder_name: kiFolders[i].f.name.trim(), from_older_ki: i > 0 }
        break
      }
    }
    if (!files.length) {
      files = pickBudget(kids)
      if (files.length) result = { ...result, status: 'ok', message: undefined, ki_folder_name: '', from_older_ki: kiFolders.length > 0 }
    }
    if (files.length) { result.latest = files[0]; result.older = files.slice(1) }
  }
  propCache.set(no, { at: Date.now(), data: result })
  return result
}

/**
 * 表示してよいファイルか（「物件決算書類関係」の中の、名前に「予算」を含むファイルだけ）
 * 親フォルダをたどって確認する: ファイル → (期/年度フォルダ) → 物件フォルダ → 物件決算書類関係
 */
export async function assertViewableFile(env: BudgetEnv, fileId: string): Promise<DriveItem> {
  const file = await getItem(env, fileId)
  if (!file || file.trashed || isFolder(file) || !isBudgetName(file.name)) {
    throw new BudgetError('FILE_NOT_ALLOWED', 'このファイルは表示できません', 404)
  }
  const rootId = String(env.BUDGET_ROOT_FOLDER_ID)
  let parent = file.parents?.[0]
  for (let depth = 0; depth < 3 && parent; depth++) {
    if (parent === rootId) {
      if (depth === 0) break // 物件フォルダを経由しない（ルート直下の）ファイルは対象外
      return file
    }
    const p = await getItem(env, parent)
    parent = p?.parents?.[0]
  }
  throw new BudgetError('FILE_NOT_ALLOWED', 'このファイルは表示できません', 404)
}

/** 予算書ファイル本体（assertViewableFile を通したものだけ） */
export async function openBudgetFile(env: BudgetEnv, fileId: string): Promise<{ file: DriveItem; res: Response }> {
  const file = await assertViewableFile(env, fileId)
  const res = await driveGet(env, `/files/${fileId}?alt=media&supportsAllDrives=true`)
  if (!res.ok) {
    console.error('[budget] download failed', res.status)
    throw new BudgetError('DOWNLOAD_FAILED', '予算書を取得できませんでした。時間をおいて再度お試しください', 502)
  }
  return { file, res }
}
