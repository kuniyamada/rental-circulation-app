// 請求書受付: PDFを最大3つまで付ける部品
//   1つ目 = 請求書 / 2つ目・3つ目 = その他資料
//   「＋ PDFを追加」で1つずつ追加、付けたものは「外す」で1つずつ外せる（ドラッグ＆ドロップも可）
//   既存ファイル（編集画面）は existing で渡す。外したものは hidden input remove_files に番号を入れて送る
(function () {
  var MAX = 3
  var LABELS = ['請求書', 'その他資料①', 'その他資料②']

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    })
  }
  function isValidPdf(file) {
    if (!file) return false
    var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    if (!isPdf) { alert('PDFファイルを選択してください（' + file.name + '）'); return false }
    if (file.size > 10 * 1024 * 1024) { alert('ファイルサイズが10MBを超えています（' + file.name + '）'); return false }
    return true
  }

  var state = { existing: [], added: [], removed: [], opts: null }

  function items() {
    var list = []
    state.existing.forEach(function (e) { if (state.removed.indexOf(e.n) < 0) list.push({ kind: 'existing', e: e }) })
    state.added.forEach(function (f, i) { list.push({ kind: 'added', f: f, i: i }) })
    return list
  }

  function sync() {
    var o = state.opts
    var input = document.getElementById(o.inputId)
    if (input) {
      var dt = new DataTransfer()
      state.added.forEach(function (f) { dt.items.add(f) })
      input.files = dt.files
    }
    var rm = document.getElementById(o.removeId)
    if (rm) rm.value = state.removed.join(',')
  }

  function render() {
    var o = state.opts
    var box = document.getElementById(o.listId)
    var addBtn = document.getElementById(o.addBtnId)
    var list = items()
    var html = list.map(function (it, idx) {
      var name = it.kind === 'existing' ? it.e.name : it.f.name
      var badge = idx === 0
        ? '<span class="text-[11px] font-bold px-2 py-0.5 rounded bg-[#396999] text-white whitespace-nowrap">' + LABELS[idx] + '</span>'
        : '<span class="text-[11px] font-bold px-2 py-0.5 rounded bg-gray-200 text-gray-700 whitespace-nowrap">' + LABELS[idx] + '</span>'
      var tag = it.kind === 'existing' ? '<span class="text-[11px] text-gray-400 whitespace-nowrap">登録済み</span>' : '<span class="text-[11px] text-green-600 whitespace-nowrap">追加</span>'
      var ref = it.kind === 'existing' ? 'e:' + it.e.n : 'a:' + it.i
      return '<div class="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-lg bg-white">' +
        badge +
        '<span class="flex-1 min-w-0 truncate text-sm text-gray-800" title="' + esc(name) + '">📄 ' + esc(name) + '</span>' + tag +
        '<button type="button" data-ref="' + ref + '" onclick="InboxPdfPicker.preview(this.dataset.ref)" class="px-2 py-1 text-xs bg-[#EEF4FA] text-[#396999] rounded hover:bg-[#D5E5F2] whitespace-nowrap">👁 確認</button>' +
        '<button type="button" data-ref="' + ref + '" onclick="InboxPdfPicker.remove(this.dataset.ref)" class="px-2 py-1 text-xs bg-red-50 text-red-600 rounded hover:bg-red-100 whitespace-nowrap">✕ 外す</button>' +
        '</div>'
    }).join('')
    if (!list.length) html = '<p class="text-xs text-gray-400 px-1">まだPDFが付いていません</p>'
    box.innerHTML = html
    if (addBtn) {
      var full = list.length >= MAX
      addBtn.disabled = full
      addBtn.classList.toggle('opacity-40', full)
      addBtn.classList.toggle('cursor-not-allowed', full)
      var lab = addBtn.querySelector('[data-label]')
      if (lab) lab.textContent = full ? 'これ以上追加できません（最大' + MAX + 'つ）' : (list.length === 0 ? '＋ 請求書PDFを追加' : '＋ PDFを追加（あと' + (MAX - list.length) + 'つ）')
    }
    var cnt = document.getElementById(o.countId)
    if (cnt) cnt.textContent = list.length + ' / ' + MAX
    if (list.length > 0) {
      var msg = document.getElementById(o.requiredMsgId)
      if (msg) msg.classList.add('hidden')
      var zone = document.getElementById(o.zoneId)
      if (zone) zone.classList.remove('border-red-400', 'bg-red-50')
    }
    sync()
  }

  function addFiles(files) {
    var arr = Array.prototype.slice.call(files || [])
    for (var k = 0; k < arr.length; k++) {
      if (items().length >= MAX) { alert('PDFは最大' + MAX + 'つまでです'); break }
      if (!isValidPdf(arr[k])) continue
      state.added.push(arr[k])
    }
    render()
  }

  window.InboxPdfPicker = {
    init: function (opts) {
      state.opts = opts
      state.existing = opts.existing || []
      state.added = []
      state.removed = []
      var picker = document.getElementById(opts.pickerId)
      if (picker) picker.addEventListener('change', function () { addFiles(picker.files); picker.value = '' })
      var zone = document.getElementById(opts.zoneId)
      if (zone) {
        var on = function () { zone.classList.add('border-[#396999]', 'bg-[#EEF4FA]') }
        var off = function () { zone.classList.remove('border-[#396999]', 'bg-[#EEF4FA]') }
        ;['dragenter', 'dragover'].forEach(function (ev) {
          zone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); on() })
        })
        zone.addEventListener('dragleave', function (e) { e.preventDefault(); if (!zone.contains(e.relatedTarget)) off() })
        zone.addEventListener('drop', function (e) {
          e.preventDefault(); e.stopPropagation(); off()
          addFiles(e.dataTransfer && e.dataTransfer.files)
        })
      }
      // 枠の外にドロップしたときにブラウザがPDFを開いて画面遷移しないようにする
      ;['dragover', 'drop'].forEach(function (ev) { window.addEventListener(ev, function (e) { e.preventDefault() }) })
      render()
    },
    openPicker: function () {
      if (items().length >= MAX) return
      var p = document.getElementById(state.opts.pickerId)
      if (p) p.click()
    },
    remove: function (ref) {
      var parts = String(ref).split(':')
      if (parts[0] === 'e') state.removed.push(Number(parts[1]))
      else state.added.splice(Number(parts[1]), 1)
      render()
    },
    preview: function (ref) {
      var parts = String(ref).split(':')
      if (parts[0] === 'e') {
        var e = state.existing.filter(function (x) { return x.n === Number(parts[1]) })[0]
        if (e) { if (window.openSavedFilePreview) openSavedFilePreview(e.url, e.name); else window.open(e.url, '_blank') }
      } else {
        var f = state.added[Number(parts[1])]
        if (!f) return
        var url = URL.createObjectURL(f)
        if (window.openSavedFilePreview) openSavedFilePreview(url, f.name); else window.open(url, '_blank')
      }
    },
    count: function () { return items().length },
    names: function () {
      return items().map(function (it, idx) { return LABELS[idx] + '：' + (it.kind === 'existing' ? it.e.name : it.f.name) })
    },
    showRequired: function () {
      var msg = document.getElementById(state.opts.requiredMsgId)
      if (msg) msg.classList.remove('hidden')
      var zone = document.getElementById(state.opts.zoneId)
      if (zone) { zone.classList.add('border-red-400', 'bg-red-50'); zone.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
    },
    sync: sync,
  }
})()
