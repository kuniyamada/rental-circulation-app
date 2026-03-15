export function layout(title: string, content: string, user: any): string {
  const roleLabel: Record<string, string> = {
    front: 'フロント',
    manager: '上長',
    operations: '業務管理課',
    accounting: '会計担当',
    honsha: '本社経理',
    admin: '管理者',
  }

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - 請求書回覧システム</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .sidebar-item { @apply flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-blue-50 hover:text-blue-600 transition cursor-pointer; }
    .sidebar-item.active { @apply bg-blue-50 text-blue-600 font-semibold; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  <!-- ヘッダー -->
  <header class="bg-white border-b border-gray-200 fixed top-0 left-0 right-0 z-50">
    <div class="flex items-center justify-between px-4 h-14">
      <div class="flex items-center gap-3">
        <button onclick="toggleSidebar()" class="p-1.5 rounded-lg hover:bg-gray-100 transition lg:hidden">
          <svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
        </button>
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          </div>
          <span class="font-bold text-gray-800 text-sm">請求書回覧システム</span>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <div class="text-right hidden sm:block">
          <p class="text-sm font-semibold text-gray-800">${user.name}</p>
          <p class="text-xs text-gray-400">${roleLabel[user.role] || user.role} / ${user.employee_number}</p>
        </div>
        <form method="POST" action="/logout">
          <button type="submit" class="text-xs text-gray-500 hover:text-red-500 border border-gray-200 px-3 py-1.5 rounded-lg hover:border-red-200 transition">
            ログアウト
          </button>
        </form>
      </div>
    </div>
  </header>

  <div class="flex pt-14">
    <!-- サイドバー -->
    <aside id="sidebar" class="w-60 bg-white border-r border-gray-200 fixed left-0 top-14 bottom-0 overflow-y-auto z-40 transform -translate-x-full lg:translate-x-0 transition-transform duration-200">
      <nav class="p-3 space-y-1">
        <a href="/" class="sidebar-item ${title === 'ダッシュボード' ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
          ダッシュボード
        </a>
        <a href="/applications/new" class="sidebar-item ${title === '新規申請' ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          新規申請
        </a>
        <a href="/applications" class="sidebar-item ${title === '申請一覧' ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
          申請一覧・検索
        </a>
        <a href="/change-password" class="sidebar-item ${title === 'パスワード変更' ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg>
          パスワード変更
        </a>
        ${user.is_admin ? `
        <div class="pt-3 pb-1">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider px-4">管理者メニュー</p>
        </div>
        <a href="/admin/users" class="sidebar-item ${title.includes('ユーザー') ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
          ユーザー管理
        </a>
        <a href="/admin/mansions" class="sidebar-item ${title.includes('マンション') ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
          マンション管理
        </a>
        <a href="/admin/staff" class="sidebar-item ${title.includes('スタッフ') ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
          担当者設定
        </a>
        <a href="/admin/smtp" class="sidebar-item ${title.includes('メール') ? 'active' : ''}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
          メール設定
        </a>
        ` : ''}
      </nav>
    </aside>

    <!-- オーバーレイ（モバイル） -->
    <div id="overlay" onclick="toggleSidebar()" class="fixed inset-0 bg-black bg-opacity-30 z-30 hidden lg:hidden"></div>

    <!-- メインコンテンツ -->
    <main class="flex-1 lg:ml-60 p-6">
      <div class="max-w-6xl mx-auto">
        <h1 class="text-xl font-bold text-gray-800 mb-6">${title}</h1>
        ${content}
      </div>
    </main>
  </div>

  <script>
    function toggleSidebar() {
      const sidebar = document.getElementById('sidebar')
      const overlay = document.getElementById('overlay')
      sidebar.classList.toggle('-translate-x-full')
      overlay.classList.toggle('hidden')
    }
  </script>
</body>
</html>`
}

export function statusBadge(status: string): string {
  const map: Record<string, { label: string; cls: string }> = {
    draft:       { label: '下書き',   cls: 'bg-gray-100 text-gray-600' },
    circulating: { label: '回覧中',   cls: 'bg-blue-100 text-blue-600' },
    approved:    { label: '承認済',   cls: 'bg-green-100 text-green-700' },
    rejected:    { label: '差し戻し', cls: 'bg-red-100 text-red-600' },
    on_hold:     { label: '保留中',   cls: 'bg-yellow-100 text-yellow-700' },
    completed:   { label: '完了',     cls: 'bg-purple-100 text-purple-700' },
  }
  const s = map[status] || { label: status, cls: 'bg-gray-100 text-gray-600' }
  return `<span class="text-xs font-semibold px-2 py-0.5 rounded-full ${s.cls}">${s.label}</span>`
}

export function paymentLabel(target: string, tdType?: string): string {
  if (target === 'kumiai') return '管理組合'
  if (tdType === 'ittaku') return '会社（委託内）'
  if (tdType === 'motouke') return '会社（元請）'
  return '会社（TD）'
}
