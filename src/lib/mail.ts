// メール送信ユーティリティ
// nodemailer を使った SMTP 直接送信（nodejs_compat フラグ有効時に動作）

import nodemailer from 'nodemailer'

export interface SmtpConfig {
  host: string
  port: number
  username?: string
  password?: string
  from_email: string
  from_name: string
  use_tls: number
}

export interface MailOptions {
  to: string
  subject: string
  html: string
}

// nodemailer 経由で SMTP 送信
export async function sendMail(config: SmtpConfig, options: MailOptions): Promise<boolean> {
  try {
    const transporter = nodemailer.createTransport({
      host: config.host || 'smtp.gmail.com',
      port: config.port || 587,
      secure: config.port === 465,   // 465 の場合は SSL、それ以外は STARTTLS
      auth: (config.username && config.password)
        ? { user: config.username, pass: config.password }
        : undefined,
      tls: { rejectUnauthorized: false },  // 自己署名証明書も許可
    })

    const info = await transporter.sendMail({
      from: `"${config.from_name}" <${config.from_email}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
    })

    console.log(`[MAIL] ✅ 送信成功: To=${options.to}, Subject=${options.subject}, messageId=${info.messageId}`)
    return true
  } catch (err: any) {
    console.error(`[MAIL] ❌ 送信エラー: To=${options.to}, Subject=${options.subject}, Error=${err?.message || err}`)
    return false
  }
}

// ============================================================
// 請求書受付通知メール本文（フロント担当者宛）
// ============================================================
export function buildInboxNotificationBody(data: {
  frontName: string
  mansionName: string
  registeredBy: string
  note: string
  appUrl: string
  isReminder: boolean
  remindCount: number
}): string {
  const headerBg = data.isReminder ? '#d97706' : '#1a56db'
  const headerLabel = data.isReminder
    ? `⚠️ リマインド（${data.remindCount}回目）`
    : '📥 請求書受付のお知らせ'
  const intro = data.isReminder
    ? `<p style="color:#92400e;background:#fffbeb;border-left:4px solid #d97706;padding:8px 12px;border-radius:4px;">
        <strong>まだ回覧申請が完了していません。</strong><br>
        至急、請求書回覧システムから申請をお願いします。
      </p>`
    : `<p>${data.frontName} さん</p>
       <p>業務管理課より、担当マンションの請求書が届きました。<br>
       下記の内容をご確認いただき、<strong>回覧申請</strong>をお願いします。</p>`

  return `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;color:#333;margin:0;padding:0;background:#f5f5f5;">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:${headerBg};padding:20px 24px;">
      <h2 style="color:#fff;margin:0;font-size:18px;">${headerLabel}</h2>
      <p style="color:#bfdbfe;margin:4px 0 0;font-size:13px;">東京ディフェンス株式会社 請求書回覧システム</p>
    </div>
    <div style="padding:24px;">
      ${intro}
      <table style="border-collapse:collapse;margin:16px 0;width:100%;">
        <tr style="border-bottom:1px solid #e5e7eb;">
          <td style="padding:8px 12px 8px 0;color:#6b7280;font-size:13px;white-space:nowrap;">マンション名</td>
          <td style="padding:8px 0;font-size:13px;"><strong>${data.mansionName}</strong></td>
        </tr>
        <tr style="border-bottom:1px solid #e5e7eb;">
          <td style="padding:8px 12px 8px 0;color:#6b7280;font-size:13px;white-space:nowrap;">登録担当者</td>
          <td style="padding:8px 0;font-size:13px;">${data.registeredBy}（業務管理課）</td>
        </tr>
        ${data.note ? `
        <tr>
          <td style="padding:8px 12px 8px 0;color:#6b7280;font-size:13px;white-space:nowrap;">備考</td>
          <td style="padding:8px 0;font-size:13px;">${data.note}</td>
        </tr>` : ''}
      </table>
      <a href="${data.appUrl}"
        style="display:inline-block;padding:12px 28px;background:${headerBg};color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;margin-top:8px;">
        回覧申請を開始する →
      </a>
    </div>
    <div style="background:#f9fafb;padding:16px 24px;border-top:1px solid #e5e7eb;">
      <p style="margin:0;font-size:11px;color:#9ca3af;">
        このメールは請求書回覧システムから自動送信されています。返信しないでください。
      </p>
    </div>
  </div>
</body>
</html>`
}

export function buildMailSubject(type: string, appNumber: string): string {
  const subjects: Record<string, string> = {
    review_request: `【回覧依頼】${appNumber} - 請求書の確認をお願いします`,
    rejected:       `【差し戻し】${appNumber} - 請求書が差し戻されました`,
    on_hold:        `【保留・質問】${appNumber} - 請求書について質問があります`,
    answered:       `【保留回答】${appNumber} - 保留質問への回答があります`,
    completed:      `【承認完了】${appNumber} - 請求書の回覧が完了しました`,
    resubmitted:    `【再提出】${appNumber} - 請求書が再提出されました`,
  }
  return subjects[type] || `【通知】${appNumber}`
}

export function buildMailBody(type: string, data: {
  appNumber: string
  title: string
  applicantName: string
  comment?: string
  appUrl: string
}): string {
  const messages: Record<string, string> = {
    review_request: `<p>下記の請求書回覧の承認をお願いします。</p>`,
    rejected:       `<p>下記の請求書が差し戻されました。</p>${data.comment ? `<p style="background:#fff3f3;border-left:4px solid #e53e3e;padding:8px 12px;margin:8px 0;"><strong>差し戻し理由：</strong>${data.comment}</p>` : ''}`,
    on_hold:        `<p>下記の請求書について質問があります。</p>${data.comment ? `<p style="background:#fffbeb;border-left:4px solid #d97706;padding:8px 12px;margin:8px 0;"><strong>質問内容：</strong>${data.comment}</p>` : ''}`,
    answered:       `<p>保留質問への回答がありました。</p>${data.comment ? `<p style="background:#f0fff4;border-left:4px solid #38a169;padding:8px 12px;margin:8px 0;"><strong>回答：</strong>${data.comment}</p>` : ''}`,
    completed:      `<p>下記の請求書の回覧が<strong style="color:#38a169;">完了</strong>しました。</p>`,
    resubmitted:    `<p>差し戻された請求書が再提出されました。</p>`,
  }

  return `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;color:#333;margin:0;padding:0;background:#f5f5f5;">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <!-- ヘッダー -->
    <div style="background:#1a56db;padding:20px 24px;">
      <h2 style="color:#fff;margin:0;font-size:18px;">📄 請求書回覧システム</h2>
      <p style="color:#bfdbfe;margin:4px 0 0;font-size:13px;">東京ディフェンス株式会社</p>
    </div>
    <!-- 本文 -->
    <div style="padding:24px;">
      ${messages[type] || ''}
      <table style="border-collapse:collapse;margin:16px 0;width:100%;">
        <tr style="border-bottom:1px solid #e5e7eb;">
          <td style="padding:8px 12px 8px 0;color:#6b7280;font-size:13px;white-space:nowrap;">申請番号</td>
          <td style="padding:8px 0;font-size:13px;"><strong>${data.appNumber}</strong></td>
        </tr>
        <tr style="border-bottom:1px solid #e5e7eb;">
          <td style="padding:8px 12px 8px 0;color:#6b7280;font-size:13px;white-space:nowrap;">件名</td>
          <td style="padding:8px 0;font-size:13px;">${data.title}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px 8px 0;color:#6b7280;font-size:13px;white-space:nowrap;">申請者</td>
          <td style="padding:8px 0;font-size:13px;">${data.applicantName}</td>
        </tr>
      </table>
      <a href="${data.appUrl}"
        style="display:inline-block;padding:12px 28px;background:#1a56db;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;margin-top:8px;">
        詳細を確認する →
      </a>
    </div>
    <!-- フッター -->
    <div style="background:#f9fafb;padding:16px 24px;border-top:1px solid #e5e7eb;">
      <p style="margin:0;font-size:11px;color:#9ca3af;">
        このメールは請求書回覧システムから自動送信されています。返信しないでください。<br>
        送信元：${data.appUrl.split('/applications')[0]}
      </p>
    </div>
  </div>
</body>
</html>`
}
