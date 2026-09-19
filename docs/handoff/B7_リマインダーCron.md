# B7: リマインダー Cron 処理 (Cloudflare Cron Triggers)

**用途**: 未承認のまま放置されている案件を定期的に検知して、承認者にリマインドメール/LINE WORKS通知

**特徴**:
- Cloudflare Workers の scheduled ハンドラで定期実行
- 例: 毎日9時、12時、17時に実行
- リマインド回数を DBに記録して過剰通知を防ぐ

---

## 📅 wrangler.jsonc 設定

```jsonc
{
  "name": "webapp-production",
  "compatibility_date": "2024-01-01",
  "pages_build_output_dir": "./dist",
  "triggers": {
    "crons": ["0 0,3,8 * * *"]  // UTC 0時,3時,8時 = JST 9時,12時,17時
  }
}
```

⚠️ **Genspark Hosted Deploy を使う場合は crons が使えない**（要ユーザー自身のCloudflareアカウントデプロイ = BYOK）

**代替策**: リクエストが来たときに `last_run` タイムスタンプをチェックし、時間が経っていればリマインダー処理を実行する「遅延処理」パターン

---

## 🎯 scheduled ハンドラ

```typescript
// src/index.tsx
export default {
  fetch: app.fetch,  // 通常のHTTPリクエスト
  async scheduled(event, env, ctx) {
    // cron triggerで呼ばれる
    ctx.waitUntil(runReminderJob(env))
  }
}

async function runReminderJob(env: Bindings) {
  const db = env.DB

  // 24時間以上前に通知した回覧中案件を検索
  const staleSteps = await db.prepare(`
    SELECT cs.id as step_id, cs.reviewer_id, cs.reminder_count,
           a.id as application_id, a.application_number, a.title,
           u.email as reviewer_email, u.name as reviewer_name
    FROM circulation_steps cs
    JOIN applications a ON cs.application_id = a.id
    JOIN users u ON cs.reviewer_id = u.id
    WHERE a.status = 'circulating'
      AND cs.status = 'pending'
      AND cs.step_number = a.current_step
      AND (cs.last_reminder_at IS NULL OR cs.last_reminder_at < datetime('now', '-24 hours'))
      AND cs.reminder_count < 5  -- 最大5回まで
  `).all()

  for (const s of staleSteps.results as any[]) {
    try {
      const newCount = (s.reminder_count || 0) + 1
      const subject = `【承認リマインド第${newCount}回】${s.application_number} の確認をお願いします`
      const html = `... リマインドメール本文 ...`

      const smtp = await db.prepare('SELECT * FROM smtp_settings LIMIT 1').first() as any
      await sendMail(smtp, { to: s.reviewer_email, subject, html })

      await db.prepare(
        'UPDATE circulation_steps SET reminder_count = ?, last_reminder_at = datetime("now") WHERE id = ?'
      ).bind(newCount, s.step_id).run()
    } catch (e) {
      console.error(`[cron] reminder error step=${s.step_id}:`, e)
    }
  }
}
```

---

## 📊 circulation_steps テーブルに追加カラム

```sql
ALTER TABLE circulation_steps ADD COLUMN reminder_count INTEGER DEFAULT 0;
ALTER TABLE circulation_steps ADD COLUMN last_reminder_at DATETIME;
```

---

## 🎛 管理画面での手動発火 (テスト用)

```typescript
app.get('/api/trigger-review-reminders', async (c) => {
  const user = await getSessionUser(...)
  if (!user || !user.is_admin) return c.notFound()
  await runReminderJob(c.env)
  return c.json({ ok: true, message: 'リマインダー処理を実行しました' })
})
```

---

## 💡 遅延処理パターン（cron無しでリマインダー実現）

Genspark Hosted等でcronが使えない場合、通常リクエストの延長でリマインダーを起動：

```typescript
// リクエスト時に last_reminder_run を確認
app.use('*', async (c, next) => {
  await next()  // 通常処理を先に

  // レスポンス返した後、waitUntilでバックグラウンド処理
  c.executionCtx.waitUntil((async () => {
    const meta = await c.env.DB.prepare('SELECT value FROM system_meta WHERE key = "last_reminder_run"').first() as any
    const lastRun = meta ? parseInt(meta.value) : 0
    const now = Math.floor(Date.now() / 1000)
    if (now - lastRun > 60 * 60 * 3) {  // 3時間以上経過なら
      await runReminderJob(c.env)
      await c.env.DB.prepare('INSERT OR REPLACE INTO system_meta (key, value) VALUES ("last_reminder_run", ?)').bind(String(now)).run()
    }
  })())
})
```

---

## 📚 rental-circulation-app での実装

- `wrangler.jsonc` の triggers
- `src/index.tsx` の scheduled ハンドラ
- `circulation_steps.reminder_count` / `last_reminder_at`
