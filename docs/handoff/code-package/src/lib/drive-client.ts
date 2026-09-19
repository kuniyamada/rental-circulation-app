/**
 * Google Drive 自動保存クライアント（Cloudflare Workers 用・OAuth 2.0 方式）
 *
 * 【方式】OAuth 2.0 refresh_token を使用（サービスアカウント方式は tokyodefense.net の
 * 組織ポリシー `iam.disableServiceAccountKeyCreation` で鍵が発行できないため採用不可）
 *
 * 【前提】保存先は必ず「共有ドライブ」内のフォルダであること
 * （マイドライブに保存しようとすると 403 storageQuotaExceeded で必ず失敗）
 *
 * 【組み込み済みノウハウ】
 * - 全API呼び出しに supportsAllDrives=true (共有ドライブ対応)
 * - PDF等アップロード時はメタデータに mimeType を入れない (Docs変換防止)
 * - access_token は1時間キャッシュ (KV渡した場合) / 401時に自動リトライ
 * - 429/5xx は指数バックオフで最大3回リトライ
 * - 設定ミス系(403 storageQuotaExceeded / 404)は即エラー
 * - 同名ファイルは PATCH で上書き（新版として保存）
 */

export interface DriveEnv {
  GOOGLE_OAUTH_CLIENT_ID: string
  GOOGLE_OAUTH_CLIENT_SECRET: string
  GOOGLE_OAUTH_REFRESH_TOKEN: string
  DRIVE_ROOT_FOLDER_ID: string
  // 任意: トークンキャッシュ用KV (無くても動く)
  SESSION_KV?: KVNamespace
}

export interface SaveFileOptions {
  path: string[]                       // ROOT配下のフォルダ階層 (自動作成)
  name: string                         // ファイル名
  mimeType: string                     // 'application/pdf' 等
  body: ArrayBuffer | Uint8Array | string
  mode?: 'upsert' | 'always-new'       // upsert(既定): 同名は上書き / always-new: 常に新規
}

export interface SaveFileResult {
  id: string
  name: string
  url: string
  updated: boolean                     // true: 既存を上書き / false: 新規作成
}

export interface HealthCheckResult {
  ok: boolean
  code?: string
  message?: string
  folderName?: string
  driveId?: string
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const TOKEN_KV_KEY = 'drive:access_token'
const TOKEN_TTL_SEC = 3300  // 55min (実際は1hだが安全マージン)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** レスポンスを安全にJSONパース */
async function safeJson(res: Response): Promise<any> {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

/** Google APIエラーのコード抽出 */
function extractErrorCode(json: any): string | undefined {
  return json?.error?.errors?.[0]?.reason || json?.error?.status || undefined
}

/** リトライしても直らない設定ミス系エラー */
function isFatalError(status: number, code?: string): boolean {
  if (status === 401 || status === 403) {
    // storageQuotaExceeded = マイドライブ保存試行 (共有ドライブ設定漏れ)
    // notFound / userPermissionDenied = 権限・IDミス
    if (code === 'storageQuotaExceeded') return true
    if (code === 'notFound') return true
    if (code === 'userPermissionDenied') return true
    if (code === 'forbidden') return true
  }
  if (status === 404) return true
  if (status === 400) return true  // invalid_grant等 (refresh_token失効)
  return false
}

export class DriveClient {
  private env: DriveEnv
  private kv?: KVNamespace
  private cachedToken?: { token: string; expiresAt: number }

  constructor(env: DriveEnv, opts?: { kv?: KVNamespace }) {
    this.env = env
    this.kv = opts?.kv || env.SESSION_KV
    // 起動時チェック
    if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET ||
        !env.GOOGLE_OAUTH_REFRESH_TOKEN || !env.DRIVE_ROOT_FOLDER_ID) {
      throw new Error('DriveClient: 必須Secret未設定 (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN / DRIVE_ROOT_FOLDER_ID)')
    }
  }

  /** access_token を取得 (キャッシュ優先) */
  async getAccessToken(forceRefresh = false): Promise<string> {
    const now = Math.floor(Date.now() / 1000)

    // メモリキャッシュ
    if (!forceRefresh && this.cachedToken && this.cachedToken.expiresAt > now + 60) {
      return this.cachedToken.token
    }

    // KVキャッシュ
    if (!forceRefresh && this.kv) {
      const cached = await this.kv.get(TOKEN_KV_KEY, 'json') as { token: string; expiresAt: number } | null
      if (cached && cached.expiresAt > now + 60) {
        this.cachedToken = cached
        return cached.token
      }
    }

    // refresh_token でトークン交換
    const body = new URLSearchParams({
      client_id: this.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: this.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: this.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    })
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const json = await safeJson(res)
    if (!res.ok || !json.access_token) {
      const msg = json.error_description || json.error || `HTTP ${res.status}`
      throw new Error(`Drive: access_token取得失敗: ${msg}`)
    }
    const token = json.access_token as string
    const expiresAt = now + Math.min(Number(json.expires_in || 3600), TOKEN_TTL_SEC)
    this.cachedToken = { token, expiresAt }
    if (this.kv) {
      await this.kv.put(TOKEN_KV_KEY, JSON.stringify({ token, expiresAt }), {
        expirationTtl: TOKEN_TTL_SEC,
      })
    }
    return token
  }

  /** Drive API 汎用呼び出し (401時1回自動リトライ + 一時エラー指数バックオフ) */
  private async apiFetch(url: string, init: RequestInit = {}, retryCount = 0): Promise<Response> {
    const token = await this.getAccessToken()
    const headers = new Headers(init.headers || {})
    headers.set('Authorization', `Bearer ${token}`)
    const res = await fetch(url, { ...init, headers })

    if (res.ok) return res

    // 401: トークン失効 → 強制再取得して1回リトライ
    if (res.status === 401 && retryCount === 0) {
      await this.getAccessToken(true)
      return this.apiFetch(url, init, retryCount + 1)
    }

    // レスポンス消費してエラーコード取得
    const json = await safeJson(res.clone())
    const code = extractErrorCode(json)

    // 設定ミス系は即エラー
    if (isFatalError(res.status, code)) {
      const err: any = new Error(`Drive API ${res.status} ${code || ''}: ${json?.error?.message || 'unknown'}`)
      err.status = res.status
      err.code = code
      throw err
    }

    // 429/5xx: 指数バックオフで最大3回
    if ((res.status === 429 || res.status >= 500) && retryCount < 3) {
      const waitMs = Math.pow(2, retryCount) * 1000  // 1s -> 2s -> 4s
      await sleep(waitMs)
      return this.apiFetch(url, init, retryCount + 1)
    }

    const err: any = new Error(`Drive API ${res.status} ${code || ''}: ${json?.error?.message || 'unknown'}`)
    err.status = res.status
    err.code = code
    throw err
  }

  /** 保存先ルートフォルダの情報を取得 (healthCheck用) */
  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const url = `${DRIVE_API}/files/${encodeURIComponent(this.env.DRIVE_ROOT_FOLDER_ID)}?supportsAllDrives=true&fields=id,name,driveId,mimeType`
      const res = await this.apiFetch(url)
      const info = await res.json() as any
      if (info.mimeType !== 'application/vnd.google-apps.folder') {
        return { ok: false, code: 'not_a_folder', message: `指定IDはフォルダではありません (mimeType=${info.mimeType})` }
      }
      if (!info.driveId) {
        return { ok: false, code: 'not_shared_drive', message: '指定フォルダは共有ドライブ内にありません。マイドライブでは自動保存できません。' }
      }
      return { ok: true, folderName: info.name, driveId: info.driveId }
    } catch (e: any) {
      return { ok: false, code: e.code || 'unknown', message: e.message }
    }
  }

  /** フォルダ階層を辿る/作成 (パス配列の順に子フォルダを解決) */
  async ensureFolder(pathSegments: string[]): Promise<string> {
    let parentId = this.env.DRIVE_ROOT_FOLDER_ID
    for (const seg of pathSegments) {
      const trimmed = String(seg).trim()
      if (!trimmed) continue
      parentId = await this.getOrCreateChildFolder(parentId, trimmed)
    }
    return parentId
  }

  /** 指定親フォルダ配下から同名フォルダを探し、無ければ作成 */
  private async getOrCreateChildFolder(parentId: string, name: string): Promise<string> {
    // 検索
    const q = `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${escapeQ(name)}' and trashed=false`
    const searchUrl = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`
    const searchRes = await this.apiFetch(searchUrl)
    const searchJson = await searchRes.json() as any
    if (searchJson.files && searchJson.files.length > 0) {
      return searchJson.files[0].id as string
    }
    // 作成
    const createRes = await this.apiFetch(`${DRIVE_API}/files?supportsAllDrives=true&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      }),
    })
    const createJson = await createRes.json() as any
    return createJson.id as string
  }

  /** メインAPI: フォルダ作成 → ファイル保存 (同名は上書き) */
  async saveFile(opts: SaveFileOptions): Promise<SaveFileResult> {
    const folderId = await this.ensureFolder(opts.path)
    const mode = opts.mode || 'upsert'

    // upsert: 同名ファイルを検索
    let existingId: string | null = null
    if (mode === 'upsert') {
      const q = `'${folderId}' in parents and name='${escapeQ(opts.name)}' and trashed=false`
      const searchUrl = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`
      const searchRes = await this.apiFetch(searchUrl)
      const searchJson = await searchRes.json() as any
      if (searchJson.files && searchJson.files.length > 0) {
        existingId = searchJson.files[0].id as string
      }
    }

    // Body準備
    const bodyBytes = typeof opts.body === 'string'
      ? new TextEncoder().encode(opts.body)
      : opts.body instanceof Uint8Array
        ? opts.body
        : new Uint8Array(opts.body as ArrayBuffer)

    if (existingId) {
      // 既存を PATCH で上書き (multipart不要, ボディだけ差し替え)
      const url = `${UPLOAD_API}/files/${encodeURIComponent(existingId)}?uploadType=media&supportsAllDrives=true&fields=id,name,webViewLink`
      const res = await this.apiFetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': opts.mimeType },
        body: bodyBytes,
      })
      const json = await res.json() as any
      return {
        id: json.id,
        name: json.name,
        url: json.webViewLink || `https://drive.google.com/file/d/${json.id}/view`,
        updated: true,
      }
    }

    // 新規作成: multipart upload
    // NOTE: メタデータには mimeType を入れない (入れるとDocs変換されて壊れる)
    const boundary = '----drive_upload_' + Math.random().toString(36).slice(2)
    const metadata = { name: opts.name, parents: [folderId] }
    const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    const filePartHeader = `--${boundary}\r\nContent-Type: ${opts.mimeType}\r\n\r\n`
    const closing = `\r\n--${boundary}--\r\n`

    // ボディ結合
    const enc = new TextEncoder()
    const p1 = enc.encode(metaPart)
    const p2 = enc.encode(filePartHeader)
    const p4 = enc.encode(closing)
    const total = p1.length + p2.length + bodyBytes.length + p4.length
    const merged = new Uint8Array(total)
    merged.set(p1, 0)
    merged.set(p2, p1.length)
    merged.set(bodyBytes, p1.length + p2.length)
    merged.set(p4, p1.length + p2.length + bodyBytes.length)

    const url = `${UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`
    const res = await this.apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: merged,
    })
    const json = await res.json() as any
    return {
      id: json.id,
      name: json.name,
      url: json.webViewLink || `https://drive.google.com/file/d/${json.id}/view`,
      updated: false,
    }
  }
}

/** Drive検索クエリ内のシングルクォート/バックスラッシュをエスケープ */
function escapeQ(s: string): string {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}
