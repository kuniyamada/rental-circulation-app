// 請求書をまとめて登録（複数物件）
//   ファイル名「物件番号3桁＋空白＋担当者名.pdf」から物件と担当フロントを自動で入れる
//   - 物件が見つからない行: 赤（番号を入れ直す）
//   - ファイル名の名前とマスタの担当者が違う行: 黄色（マスタの担当者を入れ、必要なら選び直す）
//   - 登録は1件ずつサーバーへ送り、最後に担当者ごとに1通お知らせ
(function () {
  var D = window.BULK_DATA || { max: 30, mansions: [], fronts: [] }
  var MAX = D.max || 30
  var rows = [] // { uid, file, num, mansionId, frontId, fileName(name in filename), status:'' | 'done' | 'error', error }
  var seq = 0
  var submitting = false

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    })
  }
  function norm(s) { return String(s || '').replace(/[\s\u3000]/g, '') }
  function pad3(n) { return n == null || n === '' ? '' : String(n).padStart(3, '0') }
  function findMansion(num) {
    if (num == null || isNaN(num)) return null
    for (var i = 0; i < D.mansions.length; i++) if (D.mansions[i].number === num) return D.mansions[i]
    return null
  }
  function findFront(id) {
    for (var i = 0; i < D.fronts.length; i++) if (String(D.fronts[i].id) === String(id)) return D.fronts[i]
    return null
  }
  function findFrontByName(name) {
    var n = norm(name)
    if (!n) return null
    var hit = D.fronts.filter(function (f) { return norm(f.name).indexOf(n) === 0 || norm(f.name) === n })
    return hit.length === 1 ? hit[0] : null
  }

  // 「005 上野.pdf」「021② 立花.pdf」「044 上野_(2).pdf」
  function parseName(fileName) {
    var base = String(fileName || '').replace(/\.pdf$/i, '')
    base = base.replace(/[０-９]/g, function (d) { return String.fromCharCode(d.charCodeAt(0) - 0xFEE0) })
    var m = /^\s*(\d{1,4})\S*[\s\u3000_]*(.*)$/.exec(base)
    if (!m) return { num: null, name: '' }
    var name = (m[2] || '').replace(/[_＿]?\s*[（(]\s*\d+\s*[)）]\s*$/, '').replace(/[_＿\s\u3000]+$/, '').trim()
    return { num: parseInt(m[1], 10), name: name }
  }

  function makeRow(file) {
    var p = parseName(file.name)
    var r = { uid: ++seq, file: file, num: p.num, fileName: p.name, mansionId: null, frontId: null, status: '', error: '' }
    applyNumber(r, p.num)
    return r
  }
  function applyNumber(r, num) {
    r.num = num
    var m = findMansion(num)
    r.mansionId = m ? m.id : null
    var f = m && m.frontId ? findFront(m.frontId) : null
    if (!f && r.fileName) f = findFrontByName(r.fileName) // マスタに担当がいないときだけファイル名から
    r.frontId = f ? f.id : null
  }
  function check(r) {
    if (r.status === 'done') return { cls: 'bg-green-50', html: '<span class="text-green-700 font-semibold whitespace-nowrap">✅ 登録しました</span>' }
    if (r.status === 'error') return { cls: 'bg-red-50', html: '<span class="text-red-600 font-semibold">⚠️ ' + esc(r.error) + '</span>' }
    if (!r.mansionId) return { cls: 'bg-red-50', bad: true, html: '<span class="text-red-600 font-semibold whitespace-nowrap">⚠️ 物件が見つかりません</span><div class="text-[11px] text-red-500">番号を入れ直してください</div>' }
    if (!r.frontId) return { cls: 'bg-red-50', bad: true, html: '<span class="text-red-600 font-semibold whitespace-nowrap">⚠️ 担当フロントを選んでください</span>' }
    var f = findFront(r.frontId)
    if (r.fileName && f && norm(f.name).indexOf(norm(r.fileName)) !== 0 && norm(f.name) !== norm(r.fileName)) {
      return { cls: 'bg-yellow-50', warn: true, html: '<span class="text-amber-700 font-semibold whitespace-nowrap">⚠️ ファイル名と担当者が違います</span><div class="text-[11px] text-amber-700">ファイル名：' + esc(r.fileName) + '／マスタ：' + esc(f.name) + '</div>' }
    }
    return { cls: '', html: '<span class="text-green-700 whitespace-nowrap">✅ OK</span>' }
  }

  function frontOptions(sel) {
    var html = '<option value="">-- 選択 --</option>'
    D.fronts.forEach(function (f) {
      html += '<option value="' + f.id + '"' + (String(sel) === String(f.id) ? ' selected' : '') + '>' + (f.test ? '★ ' : '') + esc(f.name) + (f.test ? '【テスト】' : '') + '</option>'
    })
    return html
  }

  function render() {
    var tbody = document.getElementById('bulkRows')
    var wrap = document.getElementById('bulkTableWrap')
    var footer = document.getElementById('bulkFooter')
    wrap.classList.toggle('hidden', rows.length === 0)
    footer.classList.toggle('hidden', rows.length === 0)
    var nOk = 0, nWarn = 0, nBad = 0, nDone = 0
    tbody.innerHTML = rows.map(function (r, i) {
      var ck = check(r)
      if (r.status === 'done') nDone++
      else if (ck.bad || r.status === 'error') nBad++
      else if (ck.warn) nWarn++
      else nOk++
      var m = findMansion(r.num)
      var locked = r.status === 'done' || submitting
      return '<tr class="' + ck.cls + ' align-top">' +
        '<td class="px-3 py-2 text-xs text-gray-400">' + (i + 1) + '</td>' +
        '<td class="px-3 py-2"><button type="button" data-uid="' + r.uid + '" onclick="Bulk.preview(this.dataset.uid)" class="text-[#396999] hover:underline text-left break-all">📄 ' + esc(r.file.name) + '</button></td>' +
        '<td class="px-3 py-2 whitespace-nowrap">' +
          '<input type="text" inputmode="numeric" value="' + esc(pad3(r.num)) + '" data-uid="' + r.uid + '" onchange="Bulk.setNum(this.dataset.uid, this.value)" ' + (locked ? 'disabled' : '') +
          ' class="w-16 px-2 py-1 border border-gray-300 rounded text-center text-sm">' +
          '<span class="ml-2 text-sm ' + (m ? 'text-gray-800 font-semibold' : 'text-red-500') + '">' + (m ? esc(m.name) : '見つかりません') + '</span>' +
        '</td>' +
        '<td class="px-3 py-2"><select data-uid="' + r.uid + '" onchange="Bulk.setFront(this.dataset.uid, this.value)" ' + (locked ? 'disabled' : '') +
          ' class="border border-gray-300 rounded px-2 py-1 text-sm min-w-[140px]">' + frontOptions(r.frontId) + '</select></td>' +
        '<td class="px-3 py-2 text-xs">' + ck.html + '</td>' +
        '<td class="px-3 py-2 text-right">' + (locked ? '' : '<button type="button" data-uid="' + r.uid + '" onclick="Bulk.remove(this.dataset.uid)" class="text-xs px-2 py-1 bg-red-50 text-red-600 hover:bg-red-100 rounded whitespace-nowrap">✕ 外す</button>') + '</td>' +
        '</tr>'
    }).join('')
    document.getElementById('bulkCount').textContent = rows.length
    var parts = []
    if (nDone) parts.push('<span class="text-green-700">登録済 ' + nDone + '</span>')
    if (nOk) parts.push('<span class="text-green-700">OK ' + nOk + '</span>')
    if (nWarn) parts.push('<span class="text-amber-700">要確認 ' + nWarn + '</span>')
    if (nBad) parts.push('<span class="text-red-600">要修正 ' + nBad + '</span>')
    document.getElementById('bulkSummary').innerHTML = parts.join('　') + '　<span class="text-gray-400">（最大' + MAX + '件）</span>'
    var btn = document.getElementById('bulkSubmitBtn')
    var pending = rows.filter(function (r) { return r.status !== 'done' }).length
    btn.disabled = submitting || pending === 0
    btn.classList.toggle('opacity-50', btn.disabled)
    if (!submitting) btn.textContent = pending ? '📤 まとめて登録して送信（' + pending + '件）' : '登録済み'
    document.getElementById('bulkClearBtn').classList.toggle('hidden', submitting)
  }

  function addFiles(list) {
    var arr = Array.prototype.slice.call(list || [])
    var skipped = []
    arr.forEach(function (f) {
      var isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
      if (!isPdf) { skipped.push(f.name + '（PDFではありません）'); return }
      if (f.size > 10 * 1024 * 1024) { skipped.push(f.name + '（10MBを超えています）'); return }
      if (rows.length >= MAX) { skipped.push(f.name + '（最大' + MAX + '件を超えています）'); return }
      if (rows.some(function (r) { return r.file.name === f.name && r.file.size === f.size && r.status !== 'done' })) { skipped.push(f.name + '（すでに追加済み）'); return }
      rows.push(makeRow(f))
    })
    rows.sort(function (a, b) {
      if (a.status === 'done' && b.status !== 'done') return -1
      if (b.status === 'done' && a.status !== 'done') return 1
      return (a.num == null ? 99999 : a.num) - (b.num == null ? 99999 : b.num) || a.file.name.localeCompare(b.file.name, 'ja')
    })
    render()
    if (skipped.length) alert('次のファイルは追加しませんでした：\n\n' + skipped.join('\n'))
  }

  function byUid(uid) { for (var i = 0; i < rows.length; i++) if (String(rows[i].uid) === String(uid)) return rows[i]; return null }

  window.Bulk = {
    setNum: function (uid, v) {
      var r = byUid(uid); if (!r) return
      var n = parseInt(String(v).replace(/[０-９]/g, function (d) { return String.fromCharCode(d.charCodeAt(0) - 0xFEE0) }), 10)
      applyNumber(r, isNaN(n) ? null : n)
      r.status = ''; r.error = ''
      render()
    },
    setFront: function (uid, v) {
      var r = byUid(uid); if (!r) return
      r.frontId = v ? Number(v) : null
      r.status = ''; r.error = ''
      render()
    },
    remove: function (uid) {
      rows = rows.filter(function (r) { return String(r.uid) !== String(uid) })
      render()
    },
    clearAll: function () {
      if (!rows.length || !confirm('追加したPDFをすべて外しますか？')) return
      rows = rows.filter(function (r) { return r.status === 'done' })
      render()
    },
    preview: function (uid) {
      var r = byUid(uid); if (!r) return
      var url = URL.createObjectURL(r.file)
      if (window.openSavedFilePreview) openSavedFilePreview(url, r.file.name); else window.open(url, '_blank')
    },
    submit: async function () {
      if (submitting) return
      var targets = rows.filter(function (r) { return r.status !== 'done' })
      if (!targets.length) return
      var bad = targets.filter(function (r) { return check(r).bad })
      if (bad.length) { alert('赤い行（' + bad.length + '件）を直すか、外してから送信してください'); return }
      var warn = targets.filter(function (r) { return check(r).warn }).length
      var byFront = {}
      targets.forEach(function (r) { var f = findFront(r.frontId); var k = f ? f.name : '?'; byFront[k] = (byFront[k] || 0) + 1 })
      var lines = Object.keys(byFront).map(function (k) { return '・' + k + ' さん：' + byFront[k] + '件' })
      var msg = targets.length + '件の請求書を登録し、担当者ごとにまとめてお知らせを送ります。よろしいですか？\n\n' + lines.join('\n')
      if (warn) msg += '\n\n⚠️ ファイル名と担当者が違う行が ' + warn + '件 あります（黄色の行）。'
      if (!confirm(msg)) return

      submitting = true
      var note = document.getElementById('bulkNote').value || ''
      var btn = document.getElementById('bulkSubmitBtn')
      render()
      var ids = []
      for (var i = 0; i < targets.length; i++) {
        var r = targets[i]
        btn.textContent = '登録中… ' + (i + 1) + ' / ' + targets.length
        try {
          var fd = new FormData()
          fd.append('mansion_id', r.mansionId)
          fd.append('front_user_id', r.frontId)
          fd.append('note', note)
          fd.append('pdf_file', r.file, r.file.name)
          var res = await fetch('/inbox/bulk/item', { method: 'POST', body: fd, headers: { 'X-Requested-With': 'XMLHttpRequest' } })
          var j = null
          try { j = await res.json() } catch (e) { j = null }
          if (res.ok && j && j.ok) { r.status = 'done'; r.error = ''; ids.push(j.id) }
          else { r.status = 'error'; r.error = (j && j.error) || ('登録に失敗しました（' + res.status + '）') }
        } catch (e) {
          r.status = 'error'; r.error = '通信に失敗しました'
        }
        render()
      }
      var notifyMsg = ''
      if (ids.length) {
        btn.textContent = 'お知らせを送信中…'
        try {
          var nr = await fetch('/inbox/bulk/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids }) })
          var nj = await nr.json()
          notifyMsg = nr.ok && nj.ok ? '担当者 ' + nj.groups + '人にお知らせを送りました（結果は一覧の「通知」列で確認できます）。' : 'お知らせの送信に失敗しました。一覧の「再通知」から送ってください。'
        } catch (e) {
          notifyMsg = 'お知らせの送信に失敗しました。一覧の「再通知」から送ってください。'
        }
      }
      submitting = false
      render()
      var failed = rows.filter(function (r) { return r.status === 'error' }).length
      var box = document.getElementById('bulkResult')
      box.classList.remove('hidden')
      box.className = 'rounded-lg px-4 py-3 text-sm ' + (failed ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-green-50 border border-green-200 text-green-800')
      box.innerHTML = (ids.length ? '✅ ' + ids.length + '件を登録しました。' + esc(notifyMsg) : '') +
        (failed ? '<div class="mt-1 font-semibold">⚠️ ' + failed + '件は登録できませんでした（赤い行）。直してもう一度「まとめて登録して送信」を押してください。</div>' : '') +
        '<div class="mt-2"><a href="/inbox" class="inline-block px-3 py-1.5 bg-[#396999] text-white rounded hover:bg-[#2E5580]">請求書受付管理を開く →</a></div>'
      box.scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
  }

  // ファイル選択・ドラッグ＆ドロップ
  var picker = document.getElementById('bulkPicker')
  picker.addEventListener('change', function () { addFiles(picker.files); picker.value = '' })
  var zone = document.getElementById('bulkDropZone')
  var on = function () { zone.classList.add('border-[#396999]', 'bg-[#EEF4FA]') }
  var off = function () { zone.classList.remove('border-[#396999]', 'bg-[#EEF4FA]') }
  ;['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); on() }) })
  zone.addEventListener('dragleave', function (e) { e.preventDefault(); if (!zone.contains(e.relatedTarget)) off() })
  zone.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); off(); if (!submitting) addFiles(e.dataTransfer && e.dataTransfer.files) })
  ;['dragover', 'drop'].forEach(function (ev) { window.addEventListener(ev, function (e) { e.preventDefault() }) })
  // 送信中・未登録の行があるときに画面を閉じようとしたら確認
  window.addEventListener('beforeunload', function (e) {
    if (submitting || rows.some(function (r) { return r.status !== 'done' })) { e.preventDefault(); e.returnValue = '' }
  })
  render()
})()
