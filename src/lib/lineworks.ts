// LINE WORKS Bot API 送信ユーティリティ
// Bot API v2 + JWT認証 (Service Account)

export interface LineWorksConfig {
  botId: string
  clientId: string
  clientSecret: string
  serviceAccount: string
  privateKey: string
}

// LINE WORKS メッセージタイプ定義
export interface LineWorksMessage {
  type: 'text' | 'button_template'
  text?: string
  altText?: string
  template?: {
    type: 'buttons'
    text: string
    actions: Array<{
      type: 'uri'
      label: string
      uri: string
    }>
  }
}

// LINE WORKS API v2 の実際のリクエストボディ形式
// テキスト: { "content": { "type": "text", "text": "..." } }
// リンクボタン: { "content": { "type": "button_template", "contentText": "...", "actions": [...] } }


// JWT生成 (RS256)
async function generateJWT(serviceAccount: string, clientId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: clientId,
    sub: serviceAccount,
    iat: now,
    exp: now + 3600,
  }

  const encode = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')

  const headerB64 = encode(header)
  const payloadB64 = encode(payload)
  const signingInput = `${headerB64}.${payloadB64}`

  // PEM → CryptoKey
  const pemContents = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '')
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0))

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  )

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

  return `${headerB64}.${payloadB64}.${sigB64}`
}

// アクセストークン取得
async function getAccessToken(config: LineWorksConfig): Promise<string> {
  const jwt = await generateJWT(config.serviceAccount, config.clientId, config.privateKey)

  const params = new URLSearchParams({
    assertion: jwt,
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'bot',
  })

  const res = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LINE WORKS トークン取得エラー: ${res.status} ${text}`)
  }

  const data = await res.json() as { access_token: string }
  return data.access_token
}

// LINE WORKS Bot メッセージ送信
export async function sendLineWorksMessage(
  config: LineWorksConfig,
  userId: string,
  message: LineWorksMessage
): Promise<boolean> {
  try {
    const accessToken = await getAccessToken(config)

    const url = `https://www.worksapis.com/v1.0/bots/${config.botId}/users/${userId}/messages`

    // LINE WORKS API v2 のリクエストボディを構築
    let body: any

    if (message.type === 'button_template' && message.template) {
      // ボタンテンプレート: contentText + actions の形式
      body = {
        content: {
          type: 'button_template',
          contentText: message.template.text,
          actions: message.template.actions.map(a => ({
            type: 'uri',
            label: a.label,
            uri: a.uri,
          }))
        }
      }
    } else {
      // テキストメッセージ
      body = {
        content: {
          type: 'text',
          text: message.text || '',
        }
      }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error(`[LW] ❌ 送信エラー: userId=${userId}, status=${res.status}, body=${text}`)
      return false
    }

    console.log(`[LW] ✅ 送信成功: userId=${userId}`)
    return true
  } catch (err: any) {
    console.error(`[LW] ❌ 送信エラー: userId=${userId}, error=${err?.message || err}`)
    return false
  }
}

// ============================================================
// 通知タイプ別メッセージ構築
// ============================================================
export function buildLineWorksMessage(
  type: string,
  data: {
    appNumber: string
    title: string
    applicantName: string
    comment?: string
    returnedReason?: string
    reapplyReason?: string
    returnedByName?: string
    returnedFromStep?: number
    appUrl: string
  }
): LineWorksMessage {
  const typeLabels: Record<string, string> = {
    review_request: '📋 回覧依頼',
    rejected:       '❌ 差し戻し',
    on_hold:        '⏸ 保留・質問',
    answered:       '💬 保留回答',
    completed:      '✅ 承認完了',
    resubmitted:    '🔄 再提出',
    returned:       '↩ 差し戻し',
    reapplied:      '🔄 差し戻し再申請',
  }

  const label = typeLabels[type] || '📄 通知'

  let lines: string[] = [
    `${label}`,
    `申請番号: ${data.appNumber}`,
    `件名: ${data.title}`,
    `申請者: ${data.applicantName}`,
  ]

  if (type === 'review_request') {
    lines.push('', '請求書の確認・承認をお願いします。')
  } else if (type === 'rejected' && data.comment) {
    lines.push('', `差し戻し理由: ${data.comment}`)
  } else if (type === 'on_hold' && data.comment) {
    lines.push('', `質問内容: ${data.comment}`)
  } else if (type === 'answered' && data.comment) {
    lines.push('', `回答: ${data.comment}`)
  } else if (type === 'returned') {
    if (data.returnedByName) {
      lines.push(``, `差し戻した担当: ステップ${data.returnedFromStep}（${data.returnedByName}）`)
    }
    if (data.returnedReason) {
      lines.push(`差し戻し理由: ${data.returnedReason}`)
    }
    lines.push('', '修正の上、再申請をお願いします。')
  } else if (type === 'reapplied') {
    if (data.returnedReason) {
      lines.push('', `元の差し戻し理由: ${data.returnedReason}`)
    }
    if (data.reapplyReason) {
      lines.push(`再申請理由: ${data.reapplyReason}`)
    }
    lines.push('', '内容をご確認の上、承認をお願いします。')
  } else if (type === 'completed') {
    lines.push('', '請求書回覧が完了しました。')
  }

  // ボタン付きメッセージ（詳細確認リンク）
  // LINE WORKS API v2: button_template の contentText は160文字以内
  const fullText = lines.join('\n')
  const contentText = fullText.length > 155 ? fullText.substring(0, 155) + '...' : fullText

  return {
    type: 'button_template',
    altText: fullText,
    template: {
      type: 'buttons',
      text: contentText,
      actions: [
        {
          type: 'uri',
          label: '詳細を確認する',
          uri: data.appUrl,
        }
      ]
    }
  }
}

// LINE WORKS設定をDBから取得するヘルパー型
export interface LineWorksConfigRow {
  bot_id: string
  client_id: string
  client_secret: string
  service_account: string
  private_key: string
}

// DBの設定行からLineWorksConfigを生成
export function rowToConfig(row: LineWorksConfigRow): LineWorksConfig {
  return {
    botId:          row.bot_id,
    clientId:       row.client_id,
    clientSecret:   row.client_secret,
    serviceAccount: row.service_account,
    privateKey:     row.private_key,
  }
}
