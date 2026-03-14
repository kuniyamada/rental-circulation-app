// メール送信ユーティリティ（SMTP経由）
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

export async function sendMail(config: SmtpConfig, options: MailOptions): Promise<boolean> {
  // Cloudflare Workers環境ではSMTP直接接続が不可のため
  // fetch APIを使った外部メールAPIか、Workers Email APIを利用
  // 開発環境ではコンソールログ出力
  console.log(`[MAIL] To: ${options.to}, Subject: ${options.subject}`)
  console.log(`[MAIL] Config: ${config.host}:${config.port}`)
  // 本番実装時はSMTPリレーAPIを設定
  return true
}

export function buildMailSubject(type: string, appNumber: string): string {
  const subjects: Record<string, string> = {
    review_request: `【回覧依頼】${appNumber} - 請求書の確認をお願いします`,
    rejected: `【差し戻し】${appNumber} - 請求書が差し戻されました`,
    on_hold: `【保留・質問】${appNumber} - 請求書について質問があります`,
    answered: `【保留回答】${appNumber} - 保留質問への回答があります`,
    completed: `【承認完了】${appNumber} - 請求書の回覧が完了しました`,
    resubmitted: `【再提出】${appNumber} - 請求書が再提出されました`,
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
  const baseStyle = `font-family: sans-serif; color: #333;`
  const buttonStyle = `display: inline-block; padding: 10px 24px; background: #1a56db; color: #fff; text-decoration: none; border-radius: 4px; margin-top: 16px;`

  const messages: Record<string, string> = {
    review_request: `<p>下記の請求書回覧の承認をお願いします。</p>`,
    rejected: `<p>下記の請求書が差し戻されました。</p>${data.comment ? `<p><strong>差し戻し理由：</strong>${data.comment}</p>` : ''}`,
    on_hold: `<p>下記の請求書について質問があります。</p>${data.comment ? `<p><strong>質問内容：</strong>${data.comment}</p>` : ''}`,
    answered: `<p>保留質問への回答がありました。</p>${data.comment ? `<p><strong>回答：</strong>${data.comment}</p>` : ''}`,
    completed: `<p>下記の請求書の回覧が完了しました。</p>`,
    resubmitted: `<p>差し戻された請求書が再提出されました。</p>`,
  }

  return `
    <div style="${baseStyle}">
      <h2 style="color: #1a56db;">請求書回覧システム</h2>
      ${messages[type] || ''}
      <table style="border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">申請番号</td><td style="padding: 4px 0;"><strong>${data.appNumber}</strong></td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">件名</td><td style="padding: 4px 0;">${data.title}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">申請者</td><td style="padding: 4px 0;">${data.applicantName}</td></tr>
      </table>
      <a href="${data.appUrl}" style="${buttonStyle}">詳細を確認する</a>
      <p style="margin-top: 24px; font-size: 12px; color: #999;">このメールは自動送信です。返信しないでください。</p>
    </div>
  `
}
