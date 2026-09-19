# B5: メール (SMTP) + LINE WORKS 統合通知

**用途**: 承認依頼・完了・差戻し等の通知を、ユーザーが選んだチャネル(メール/LINE WORKS/両方)で送信

**特徴**:
- 通知タイプごとに件名・本文テンプレート
- SMTP と LINE WORKS API v2 の両対応
- JWT による LINE WORKS 認証（Refresh Tokenで自動更新）
- 統合ヘルパー `sendNotification()` で1回呼ぶだけ

---

## 📁 DBカラム追加

### users テーブル
```sql
ALTER TABLE users ADD COLUMN notify_method TEXT DEFAULT 'email';  -- 'email' / 'lineworks' / 'both'
ALTER TABLE users ADD COLUMN lineworks_user_id TEXT;               -- LINE WORKS のユーザーID
```

### smtp_settings テーブル
```sql
CREATE TABLE IF NOT EXISTS smtp_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 587,
  username TEXT,
  password TEXT,
  from_email TEXT NOT NULL,
  from_name TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### lineworks_config テーブル
```sql
CREATE TABLE IF NOT EXISTS lineworks_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  is_active INTEGER NOT NULL DEFAULT 1,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  service_account_id TEXT NOT NULL,
  private_key TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### notification_logs テーブル
```sql
CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  notification_type TEXT NOT NULL,
  email_to TEXT NOT NULL,
  subject TEXT NOT NULL,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'sent',       -- sent / failed
  error_message TEXT
);
```

---

## 🎯 統合ヘルパー: sendNotification

```typescript
// src/routes/requests.ts の先頭
async function sendNotification(
  db: D1Database,
  type: string,       // 'review_request' / 'approved' / 'rejected' / 'returned' / 'completed' 等
  recipientId: number,
  data: {
    appNumber: string
    title: string
    applicantName: string
    comment?: string
    returnedReason?: string
    appUrl: string
    isTest?: boolean
  }
): Promise<void> {
  const recipient = await db.prepare(
    'SELECT email, notify_method, lineworks_user_id FROM users WHERE id = ?'
  ).bind(recipientId).first() as any
  if (!recipient) return

  const method = recipient.notify_method || 'email'
  const mailPrefix = data.isTest ? '[TEST] ' : ''
  const lwPrefix   = data.isTest ? '🧪TEST ' : ''

  // メール送信
  if (method === 'email' || method === 'both') {
    const smtp = await db.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any
    if (smtp && recipient.email) {
      await sendMail(smtp, {
        to: recipient.email,
        subject: mailPrefix + buildMailSubject(type, data.appNumber),
        html: (data.isTest ? '<div style="background:#fef3c7;padding:10px;">🧪 テスト依頼</div>' : '') + buildMailBody(type, data),
      })
    }
  }

  // LINE WORKS送信
  if (method === 'lineworks' || method === 'both') {
    const lwConfig = await db.prepare('SELECT * FROM lineworks_config WHERE is_active = 1 LIMIT 1').first() as any
    if (lwConfig && recipient.lineworks_user_id) {
      const message = buildLineWorksMessage(type, { ...data, appNumber: lwPrefix + data.appNumber })
      await sendLineWorksMessage(rowToConfig(lwConfig), recipient.lineworks_user_id, message,
        async (tokenData) => {
          // Refresh Tokenでトークン更新時のコールバック（DB更新）
          await db.prepare('UPDATE lineworks_config SET access_token=?, refresh_token=?, token_expires_at=? WHERE is_active=1')
            .bind(tokenData.access_token, tokenData.refresh_token || null, Math.floor(Date.now()/1000) + tokenData.expires_in).run()
        }
      )
    }
  }
}
```

---

## 📮 SMTP送信 (Cloudflare Workers対応)

Workersでは `nodemailer` が使えないので、`fetch()` ベースの SMTP over HTTP サービス（例: MailChannels, Resend, SendGrid Web API）を使う。

**MailChannels の例**（無料・Cloudflare Workersと相性◎）:
```typescript
// src/lib/mail.ts
export async function sendMail(smtp: any, opts: { to: string; subject: string; html: string }) {
  const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: opts.to }] }],
      from: { email: smtp.from_email, name: smtp.from_name || 'System' },
      subject: opts.subject,
      content: [{ type: 'text/html', value: opts.html }]
    })
  })
  if (!res.ok) throw new Error(`Mail送信失敗: ${res.status}`)
}
```

---

## 💬 LINE WORKS Bot API v2

**JWT認証 + Refresh Token方式**（rental-circulation-appの `src/lib/lineworks.ts` に実装あり）:

```typescript
// アクセストークン取得（JWT → access_token）
async function getAccessToken(config: LineWorksConfig, onTokenRefresh?: Function): Promise<string> {
  // access_token 有効ならそれを返す
  if (config.accessToken && config.tokenExpiresAt && config.tokenExpiresAt > Math.floor(Date.now()/1000) + 60) {
    return config.accessToken
  }

  // JWT生成
  const jwt = await createJWT(config.serviceAccountId, config.privateKey, config.clientId)

  // トークン交換
  const res = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      assertion: jwt,
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: 'bot',
    })
  })
  const data = await res.json()
  if (onTokenRefresh) await onTokenRefresh(data)
  return data.access_token
}

// メッセージ送信
export async function sendLineWorksMessage(config, userId: string, message: string, onTokenRefresh?: Function): Promise<boolean | string> {
  const token = await getAccessToken(config, onTokenRefresh)
  const url = `https://www.worksapis.com/v1.0/bots/${config.botId}/users/${userId}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: { type: 'text', text: message } })
  })
  if (!res.ok) return `${res.status} ${await res.text()}`
  return true
}
```

**JWT生成** (Web Crypto API使用):
```typescript
async function createJWT(serviceAccountId, privateKeyPem, clientId): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: clientId,
    sub: serviceAccountId,
    iat: now,
    exp: now + 3600,
  }
  const enc = (obj: any) => btoa(JSON.stringify(obj)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
  const signingInput = `${enc(header)}.${enc(payload)}`

  // PEM → CryptoKey
  const pemBody = privateKeyPem.replace(/-----.*?-----/g, '').replace(/\s+/g, '')
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])

  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')

  return `${signingInput}.${sigB64}`
}
```

---

## 📝 通知テンプレート例

```typescript
// src/lib/mail.ts
export function buildMailSubject(type: string, appNumber: string): string {
  const map: Record<string, string> = {
    review_request: `【承認依頼】${appNumber} の承認をお願いします`,
    approved:       `【承認】${appNumber} が承認されました`,
    rejected:       `【否決】${appNumber} が否決されました`,
    returned:       `【差戻し】${appNumber} が差し戻されました`,
    on_hold:        `【保留】${appNumber} が保留になりました`,
    answered:       `【回答】${appNumber} に回答がありました`,
    completed:      `【完了】${appNumber} の承認が完了しました`,
    reapplied:      `【再申請】${appNumber} が再申請されました`,
  }
  return map[type] || `${appNumber}`
}

export function buildMailBody(type: string, data: any): string {
  // 各タイプに応じたHTML本文
  return `
    <div style="font-family:sans-serif;">
      <h2>${buildMailSubject(type, data.appNumber)}</h2>
      <p>依頼者: ${data.applicantName}</p>
      <p>件名: ${data.title}</p>
      ${data.comment ? `<p>コメント: ${data.comment}</p>` : ''}
      <p><a href="${data.appUrl}">詳細を確認する</a></p>
    </div>
  `
}
```

---

## 📚 rental-circulation-app での実装

- `src/lib/mail.ts` — MailChannels経由のSMTP送信
- `src/lib/lineworks.ts` — LINE WORKS API v2 + JWT実装
- `src/routes/applications.ts` の `sendNotification()` — 統合ヘルパー
- `src/routes/admin.ts` の `/admin/smtp` `/admin/lineworks` — 設定画面
