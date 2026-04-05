// LINE WORKS Bot API 送信ユーティリティ
// Bot API v2 + JWT認証 (Service Account)
// アクセストークンをDBキャッシュして使用（RSA署名問題を回避）

export interface LineWorksConfig {
  botId: string
  clientId: string
  clientSecret: string
  serviceAccount: string
  privateKey: string
  // DBキャッシュ済みトークン（あれば署名をスキップ）
  accessToken?: string | null
  refreshToken?: string | null
  tokenExpiresAt?: number | null
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

// Base64URL エンコード（Uint8Array → base64url 文字列）
function base64urlEncodeBytes(bytes: Uint8Array): string {
  const len = bytes.length
  let binary = ''
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

// Base64URL エンコード（文字列 → base64url）
function base64urlEncodeStr(str: string): string {
  return base64urlEncodeBytes(new TextEncoder().encode(str))
}

// Refresh Token でアクセストークンを更新
// JWT署名不要（client_id + client_secret + refresh_token のみ）
export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  })

  const res = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Refresh token error: ${res.status} ${text}`)
  }

  return res.json() as Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>
}

// JWT生成 (RS256) - Web Crypto API + JWK 形式インポート
// ⚠️ Cloudflare Workers 無料プランでは crypto.subtle.sign(RSA) がCPU制限で失敗することがある
async function generateJWT(
  serviceAccount: string,
  clientId: string,
  privateKeyData: string
): Promise<string> {
  const trimmed = privateKeyData.trim()

  if (!trimmed.startsWith('{')) {
    throw new Error('秘密鍵はJWK形式（JSON）が必要です。')
  }

  const jwk = JSON.parse(trimmed) as JsonWebKey

  const subtle = globalThis.crypto.subtle
  const cryptoKey = await subtle.importKey(
    'jwk',
    { ...jwk, alg: 'RS256', use: 'sig' } as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } },
    false,
    ['sign']
  )

  const now = Math.floor(Date.now() / 1000)
  const headerB64 = base64urlEncodeStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payloadB64 = base64urlEncodeStr(JSON.stringify({
    iss: clientId,
    sub: serviceAccount,
    iat: now,
    exp: now + 3600,
  }))
  const signingInput = `${headerB64}.${payloadB64}`

  const sigBuffer = await subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  )

  const sigB64 = base64urlEncodeBytes(new Uint8Array(sigBuffer))
  return `${headerB64}.${payloadB64}.${sigB64}`
}

// JWT でアクセストークンを取得
export async function getAccessTokenViaJWT(
  config: Pick<LineWorksConfig, 'clientId' | 'clientSecret' | 'serviceAccount' | 'privateKey'>
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
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
    throw new Error(`JWT token error: ${res.status} ${text}`)
  }

  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>
}

// アクセストークンを取得（キャッシュ優先、Refresh Token次点）
// DB にキャッシュされたトークンがあればそれを使用
// 期限切れの場合は Refresh Token で更新
// どちらもない場合は JWT 署名を試みる（Workers で失敗する可能性あり）
// 戻り値: { token, newTokenData } - newTokenData があれば DB 更新が必要
async function getAccessToken(config: LineWorksConfig): Promise<{
  token: string
  newTokenData?: { access_token: string; refresh_token?: string; expires_in?: number }
}> {
  const now = Math.floor(Date.now() / 1000)

  // 1. キャッシュされた access_token が有効な場合はそのまま使用
  if (config.accessToken && config.tokenExpiresAt && config.tokenExpiresAt > now + 300) {
    console.log('[LW] キャッシュされたアクセストークンを使用')
    return { token: config.accessToken }
  }

  // 2. Refresh Token がある場合はそれで更新（JWT署名不要）
  if (config.refreshToken) {
    console.log('[LW] Refresh Token でアクセストークンを更新')
    const tokenData = await refreshAccessToken(config.clientId, config.clientSecret, config.refreshToken)
    return { token: tokenData.access_token, newTokenData: tokenData }
  }

  // 3. JWT署名でトークン取得（Workersで失敗する可能性あり）
  console.log('[LW] JWT署名でアクセストークンを取得')
  const tokenData = await getAccessTokenViaJWT(config)
  return { token: tokenData.access_token, newTokenData: tokenData }
}

// LINE WORKS Bot メッセージ送信（DBトークン更新コールバック付き）
// 成功時: true、失敗時: エラー文字列 を返す
// onTokenRefresh: Refresh Token でトークンが更新された場合に呼ばれる（DB更新用）
export async function sendLineWorksMessage(
  config: LineWorksConfig,
  userId: string,
  message: LineWorksMessage,
  onTokenRefresh?: (tokenData: { access_token: string; refresh_token?: string; expires_in?: number }) => Promise<void>
): Promise<true | string> {
  try {
    const { token: accessToken, newTokenData } = await getAccessToken(config)

    // 新しいトークンが取得された場合、コールバックでDB更新を通知
    if (newTokenData && onTokenRefresh) {
      try {
        await onTokenRefresh(newTokenData)
      } catch (e) {
        console.error('[LW] トークンDB更新エラー:', e)
      }
    }

    const url = `https://www.worksapis.com/v1.0/bots/${config.botId}/users/${userId}/messages`


    // LINE WORKS API v2 のリクエストボディを構築
    let body: any

    if (message.type === 'button_template' && message.template) {
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
      try {
        const errObj = JSON.parse(text)
        return `HTTP ${res.status}: ${errObj.code || ''} - ${errObj.description || text}`
      } catch {
        return `HTTP ${res.status}: ${text}`
      }
    }

    console.log(`[LW] ✅ 送信成功: userId=${userId}`)
    return true
  } catch (err: any) {
    const msg = err?.message || String(err)
    console.error(`[LW] ❌ 送信エラー: userId=${userId}, error=${msg}`)
    return msg
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
  access_token?: string | null
  refresh_token?: string | null
  token_expires_at?: number | null
}

// DBの設定行からLineWorksConfigを生成
export function rowToConfig(row: LineWorksConfigRow): LineWorksConfig {
  return {
    botId:          row.bot_id,
    clientId:       row.client_id,
    clientSecret:   row.client_secret,
    serviceAccount: row.service_account,
    privateKey:     row.private_key,
    accessToken:    row.access_token,
    refreshToken:   row.refresh_token,
    tokenExpiresAt: row.token_expires_at,
  }
}
