// 請求書受付の添付PDF（最大3つ）
//   1つ目 = 請求書（attachment_key）／ 2つ目・3つ目 = その他資料（attachment2_key / attachment3_key）
export const INBOX_MAX_PDFS = 3

export interface InboxFile { n: number; key: string; name: string }

export function inboxFiles(item: any): InboxFile[] {
  const out: InboxFile[] = []
  if (!item) return out
  if (item.attachment_key) out.push({ n: 1, key: item.attachment_key, name: item.attachment_name || 'invoice.pdf' })
  if (item.attachment2_key) out.push({ n: 2, key: item.attachment2_key, name: item.attachment2_name || 'document2.pdf' })
  if (item.attachment3_key) out.push({ n: 3, key: item.attachment3_key, name: item.attachment3_name || 'document3.pdf' })
  return out
}

export function inboxFileLabel(n: number): string {
  return n === 1 ? '請求書' : n === 2 ? 'その他資料①' : 'その他資料②'
}

export function fileOf(v: any): File | null {
  return v && typeof v === 'object' && typeof v.arrayBuffer === 'function' && v.size > 0 ? (v as File) : null
}

export function validPdf(f: File): boolean {
  const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '')
  return isPdf && f.size <= 10 * 1024 * 1024
}

export async function putInboxPdf(r2: R2Bucket, f: File, n: number): Promise<{ key: string; name: string }> {
  const name = f.name || 'invoice.pdf'
  const key = `inbox/${Date.now()}_${n}_${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
  await r2.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type || 'application/pdf' } })
  return { key, name }
}

// 回覧申請の添付として使われていないPDFだけ R2 から消す
export async function deleteInboxPdfIfUnused(db: D1Database, r2: R2Bucket, key: string | null | undefined): Promise<void> {
  if (!key) return
  try {
    const used = await db.prepare(`
      SELECT 1 FROM attachments WHERE file_key = ?1
      UNION ALL SELECT 1 FROM invoice_inbox WHERE attachment_key = ?1 OR attachment2_key = ?1 OR attachment3_key = ?1
      UNION ALL SELECT 1 FROM estimate_ledger WHERE r2_key = ?1
      LIMIT 1`).bind(key).first()
    if (!used) await r2.delete(key)
  } catch (e) {
    console.error('[inbox] R2 delete failed', key, e)
  }
}
