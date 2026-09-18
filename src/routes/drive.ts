/**
 * Google Drive 自動保存 — 管理画面 & API
 * 管理者専用。admin.tsからマウントされる想定 (/admin/drive/*)
 */

import { Hono } from 'hono'
import { layout } from './layout'
import { DriveClient } from '../lib/drive-client'
import { syncApplicationToDrive, retryDriveUpload, type SyncEnv } from '../lib/drive-sync'

type Bindings = { DB: D1Database; R2: R2Bucket; [k: string]: any }
const drive = new Hono<{ Bindings: Bindings }>()

// ============================================================
// 一覧画面
// ============================================================
drive.get('/', async (c) => {
  const user = c.get('user' as any) as any
  const db = c.env.DB

  // フィルタ
  const filter = c.req.query('filter') || 'all'  // all / success / failed / pending
  let where = ''
  const params: any[] = []
  if (filter === 'success' || filter === 'failed' || filter === 'pending') {
    where = 'WHERE du.status = ?'
    params.push(filter)
  }

  // 一覧取得 (最新100件)
  const rows = await db.prepare(`
    SELECT du.*, a.application_number, m.name as mansion_name
    FROM drive_uploads du
    LEFT JOIN applications a ON du.application_id = a.id
    LEFT JOIN mansions m ON a.mansion_id = m.id
    ${where}
    ORDER BY du.created_at DESC
    LIMIT 100
  `).bind(...params).all()
  const items = (rows.results || []) as any[]

  // 集計
  const stats = await db.prepare(`
    SELECT status, COUNT(*) as c FROM drive_uploads GROUP BY status
  `).all()
  const statCounts: Record<string, number> = { success: 0, failed: 0, pending: 0 }
  for (const s of (stats.results || []) as any[]) statCounts[s.status] = s.c

  // Secret設定状況
  const hasSecrets = !!(c.env.GOOGLE_OAUTH_CLIENT_ID && c.env.GOOGLE_OAUTH_CLIENT_SECRET &&
                       c.env.GOOGLE_OAUTH_REFRESH_TOKEN && c.env.DRIVE_ROOT_FOLDER_ID)

  const content = `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-5">
      <div class="flex items-center justify-between flex-wrap gap-3 mb-3">
        <div>
          <h2 class="font-semibold text-gray-800 flex items-center gap-2">
            <span class="text-2xl">☁️</span>Google Drive 自動保存
          </h2>
          <p class="text-xs text-gray-500 mt-1">業務管理課(Step2)承認時に、申請の全添付ファイルを共有ドライブへ自動保存します。</p>
        </div>
        <div class="flex gap-2">
          <button type="button" onclick="testConnection()"
            class="bg-[#396999] hover:bg-[#2E5580] text-white text-sm font-semibold px-4 py-2 rounded-lg transition">
            🔌 接続テスト
          </button>
          <a href="/admin/drive" class="border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm font-semibold px-4 py-2 rounded-lg transition">
            🔄 更新
          </a>
        </div>
      </div>

      <!-- 連携状態バー -->
      ${hasSecrets ? `
      <div class="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2 text-sm">
        <span class="w-2 h-2 bg-emerald-500 rounded-full"></span>
        <span class="text-emerald-800 font-semibold">連携済み</span>
        <span class="text-emerald-700">— OAuthクライアントID・refresh_token・保存先フォルダID すべて設定済み</span>
      </div>
      ` : `
      <div class="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2 text-sm">
        <span class="w-2 h-2 bg-red-500 rounded-full"></span>
        <span class="text-red-800 font-semibold">未連携</span>
        <span class="text-red-700">— Cloudflare Pages Secret が未設定です。管理者にお問い合わせください。</span>
      </div>
      `}

      <!-- 集計 -->
      <div class="grid grid-cols-3 gap-3 mt-4">
        <div class="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-center">
          <p class="text-xs text-emerald-700">成功</p>
          <p class="text-2xl font-bold text-emerald-800">${statCounts.success || 0}</p>
        </div>
        <div class="bg-red-50 border border-red-200 rounded-lg p-3 text-center">
          <p class="text-xs text-red-700">失敗</p>
          <p class="text-2xl font-bold text-red-800">${statCounts.failed || 0}</p>
        </div>
        <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-center">
          <p class="text-xs text-yellow-700">保留</p>
          <p class="text-2xl font-bold text-yellow-800">${statCounts.pending || 0}</p>
        </div>
      </div>
    </div>

    <!-- 一覧 -->
    <div class="bg-white rounded-xl shadow-sm border border-gray-100">
      <div class="px-5 py-3 border-b border-gray-100 flex items-center justify-between flex-wrap gap-3">
        <h3 class="font-semibold text-gray-800 text-sm">保存履歴（最新100件）</h3>
        <div class="flex items-center gap-2 text-sm">
          <label class="text-gray-500">表示：</label>
          <select onchange="location.href='/admin/drive?filter='+this.value" class="px-2 py-1 border border-gray-300 rounded text-sm">
            <option value="all" ${filter === 'all' ? 'selected' : ''}>すべて</option>
            <option value="success" ${filter === 'success' ? 'selected' : ''}>成功のみ</option>
            <option value="failed" ${filter === 'failed' ? 'selected' : ''}>失敗のみ</option>
            <option value="pending" ${filter === 'pending' ? 'selected' : ''}>保留のみ</option>
          </select>
        </div>
      </div>
      ${items.length === 0 ? `
      <div class="p-10 text-center text-gray-400 text-sm">記録がありません</div>
      ` : `
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500">申請番号</th>
              <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500">ファイル名</th>
              <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500">保存先フォルダ</th>
              <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500">状態</th>
              <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500">更新日時</th>
              <th class="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            ${items.map(it => {
              const badge = it.status === 'success'
                ? '<span class="inline-flex items-center gap-1 text-xs font-semibold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">✅ 成功</span>'
                : it.status === 'failed'
                ? '<span class="inline-flex items-center gap-1 text-xs font-semibold bg-red-100 text-red-800 px-2 py-0.5 rounded-full">❌ 失敗</span>'
                : '<span class="inline-flex items-center gap-1 text-xs font-semibold bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-full">⏳ 保留</span>'
              const errBlk = it.error_message ? `<div class="mt-1 text-xs text-red-600 truncate" title="${escHtml(it.error_message)}">${escHtml(String(it.error_message).slice(0, 100))}${(it.error_message).length > 100 ? '…' : ''}</div>` : ''
              const openBtn = it.drive_file_url ? `<a href="${escHtml(it.drive_file_url)}" target="_blank" class="text-xs text-[#396999] underline hover:text-[#2E5580]">Driveで開く</a>` : ''
              const retryBtn = it.status === 'failed'
                ? `<button type="button" onclick="retry(${it.id}, this)" class="text-xs bg-orange-500 hover:bg-orange-600 text-white px-2 py-1 rounded transition">🔁 再実行</button>`
                : ''
              return `
              <tr class="border-t border-gray-100 hover:bg-gray-50">
                <td class="px-4 py-2 text-xs">
                  <a href="/applications/${it.application_id}" class="text-[#396999] underline">${escHtml(it.application_number || `#${it.application_id}`)}</a>
                  <div class="text-gray-500 truncate max-w-[180px]" title="${escHtml(it.mansion_name || '')}">${escHtml(it.mansion_name || '')}</div>
                </td>
                <td class="px-4 py-2 text-xs">
                  <div class="font-mono truncate max-w-[280px]" title="${escHtml(it.file_name)}">${escHtml(it.file_name)}</div>
                  ${errBlk}
                </td>
                <td class="px-4 py-2 text-xs text-gray-600 truncate max-w-[200px]" title="${escHtml(it.folder_path)}">${escHtml(it.folder_path)}</td>
                <td class="px-4 py-2">${badge}<div class="text-xs text-gray-400 mt-0.5">試行 ${it.attempts}回</div></td>
                <td class="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">${formatDate(it.updated_at)}</td>
                <td class="px-4 py-2 text-right whitespace-nowrap">${openBtn} ${retryBtn}</td>
              </tr>
              `
            }).join('')}
          </tbody>
        </table>
      </div>
      `}
    </div>

    <script>
      async function testConnection() {
        const btn = event.currentTarget
        const oldText = btn.textContent
        btn.disabled = true
        btn.textContent = '接続中…'
        try {
          const res = await fetch('/admin/drive/health', { method: 'POST' })
          const j = await res.json()
          if (j.ok) {
            alert('✅ 接続OK\\n\\n保存先フォルダ: ' + (j.folderName || '(名前取得不可)') + '\\n共有ドライブID: ' + (j.driveId || '(不明)'))
          } else {
            alert('❌ 接続失敗\\n\\nコード: ' + (j.code || '?') + '\\n' + (j.message || ''))
          }
        } catch (e) {
          alert('❌ 通信エラー: ' + e.message)
        } finally {
          btn.disabled = false
          btn.textContent = oldText
        }
      }
      async function retry(id, btn) {
        btn.disabled = true
        const old = btn.textContent
        btn.textContent = '実行中…'
        try {
          const res = await fetch('/admin/drive/retry/' + id, { method: 'POST' })
          const j = await res.json()
          if (j.ok) {
            alert('✅ 再実行成功。ページを更新します。')
            location.reload()
          } else {
            alert('❌ 再実行失敗: ' + (j.error || '不明なエラー'))
            btn.disabled = false
            btn.textContent = old
          }
        } catch (e) {
          alert('❌ 通信エラー: ' + e.message)
          btn.disabled = false
          btn.textContent = old
        }
      }
    </script>
  `
  return c.html(layout('Drive自動保存', content, user))
})

// ============================================================
// 接続テスト
// ============================================================
drive.post('/health', async (c) => {
  try {
    const client = new DriveClient(c.env as any)
    const result = await client.healthCheck()
    return c.json(result)
  } catch (e: any) {
    return c.json({ ok: false, code: 'init_error', message: String(e?.message || e) })
  }
})

// ============================================================
// 手動再試行
// ============================================================
drive.post('/retry/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  if (!id) return c.json({ ok: false, error: 'invalid id' }, 400)
  try {
    const result = await retryDriveUpload(c.env as SyncEnv, id)
    return c.json(result)
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message || e) })
  }
})

// ============================================================
// 指定申請の手動再同期 (管理者向け・全添付を再アップロード)
// ============================================================
drive.post('/sync-app/:appId', async (c) => {
  const appId = parseInt(c.req.param('appId'))
  if (!appId) return c.json({ ok: false, error: 'invalid appId' }, 400)
  try {
    const result = await syncApplicationToDrive(c.env as SyncEnv, appId)
    return c.json({ ok: true, ...result })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message || e) })
  }
})

// ============================================================
// ユーティリティ
// ============================================================
function escHtml(s: any): string {
  return String(s ?? '').replace(/[<>&"']/g, (ch) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[ch] as string)
  )
}
function formatDate(iso: string): string {
  if (!iso) return '-'
  // D1が返すのはUTC。JSTに変換して表示
  try {
    const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'))
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
    const y = jst.getUTCFullYear()
    const m = String(jst.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(jst.getUTCDate()).padStart(2, '0')
    const hh = String(jst.getUTCHours()).padStart(2, '0')
    const mm = String(jst.getUTCMinutes()).padStart(2, '0')
    return `${y}-${m}-${dd} ${hh}:${mm}`
  } catch {
    return iso
  }
}

export default drive
