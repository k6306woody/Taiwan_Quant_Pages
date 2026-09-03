/* ═══════════════════════════════════════════════════════
   共用前端工具 —— 取代三頁各自複製的 fnum/fmtChip/switchTab 等
   ═══════════════════════════════════════════════════════ */

/* ── 嵌入模式偵測（必須在這裡、不能等 DOMContentLoaded）──────
   桌面版用 QWebEngineView 把這些頁嵌進 PyQt 分頁，網址帶 ?embed=1。
   桌面已經有自己的分頁列，頁內再放一份導覽只會出事：在「總覽」
   分頁裡點「模型績效」，分頁標題還是總覽、內容卻換掉了。

   這段刻意寫在 tq.js 最上面：tq.js 是在 <head> 載入的，所以類別
   會在 <body> 開始解析**之前**就掛上，導覽不會先畫出來再消失。
   放進 DOMContentLoaded 就會閃一下。                          */
if (location.search.indexOf('embed=1') >= 0) {
  document.documentElement.classList.add('embed');
}

/* ── 主題 ──────────────────────────────────────────────────
   兩個主題：
     dark   高對比（純黑底 + 實心分層）  ← 預設，PyQt 桌面版鏡射的就是它
     glass  黑曜石玻璃（半透明面板 + 背景模糊）

   跟嵌入偵測一樣寫在最上面、同步執行：tq.js 在 <head>，所以屬性會在
   <body> 開始解析**之前**掛上。放進 DOMContentLoaded 的話會先用預設
   主題畫一次再換掉，整頁閃一下白光——深色介面上特別刺眼。

   localStorage 讀取包 try：無痕視窗與部分嵌入情境會直接丟例外，
   讓它掛掉的話整個 tq.js 就不會載入，全站空白。 */
(function () {
  var t = 'dark';
  // 嵌入 PyQt 時一律用高對比：桌面版自己的面板是高對比配色，
  // 網頁若跟著瀏覽器的玻璃主題走，同一個視窗裡會有兩種質感。
  // localStorage 是同源共用的，不擋的話在瀏覽器選了玻璃，桌面也會變。
  if (document.documentElement.classList.contains('embed')) {
    document.documentElement.setAttribute('data-theme', 'dark');
    return;
  }
  try { t = localStorage.getItem('tq-theme') || 'dark'; } catch (e) {}
  if (t !== 'dark' && t !== 'glass') t = 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();
window.TQ = {
  // ── 資料 ──
  async api(url) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      return j.error ? { _error: j.error } : (j.data !== undefined ? j.data : j);
    } catch (e) {
      return { _error: e.message };
    }
  },

  // ── 格式化（一律 round，避免浮點長尾）──
  num(v, d = 2) {
    return (v === null || v === undefined || isNaN(v)) ? '—' : Number(v).toFixed(d);
  },
  pct(v, d = 2, sign = true) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    const s = (sign && v >= 0) ? '+' : '';
    return s + (v * 100).toFixed(d) + '%';
  },
  pctRaw(v, d = 2) {   // 已經是百分比數值（非小數）
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v >= 0 ? '+' : '') + Number(v).toFixed(d) + '%';
  },
  signed(v, d = 2) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v >= 0 ? '+' : '') + Number(v).toFixed(d);
  },
  chip(v) {   // 法人金額 → 億元
    if (v === null || v === undefined || isNaN(v)) return '—';
    const e = v / 1e8;
    return (e >= 0 ? '+' : '') + e.toFixed(2) + '億';
  },
  vol(v) {    // 成交量 → 張/萬張
    if (!v) return '—';
    const lots = v / 1000;
    return lots >= 10000 ? (lots / 10000).toFixed(1) + '萬' : Math.round(lots).toLocaleString();
  },

  // ── 主題 ──
  theme() { return document.documentElement.getAttribute('data-theme') || 'dark'; },
  setTheme(t) {
    if (t !== 'dark' && t !== 'glass') return;
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('tq-theme', t); } catch (e) {}
    document.querySelectorAll('.theme-btn').forEach(b =>
      b.classList.toggle('on', b.dataset.theme === t));
    // 畫布類元件的顏色是在建立當下讀 CSS 變數寫進 SVG 屬性的，
    // 換主題後不會自己更新——發個事件讓它們重畫。
    window.dispatchEvent(new CustomEvent('tq:theme', { detail: { theme: t } }));
  },
  /** 在指定容器裡塞一組主題切換鈕（各頁的標頭列共用同一份） */
  themeSwitch(el) {
    if (!el) return;
    el.innerHTML =
      '<button class="theme-btn" data-theme="dark" title="高對比">高對比</button>' +
      '<button class="theme-btn" data-theme="glass" title="黑曜石玻璃">玻璃</button>';
    el.querySelectorAll('.theme-btn').forEach(b => {
      b.classList.toggle('on', b.dataset.theme === this.theme());
      b.addEventListener('click', () => this.setTheme(b.dataset.theme));
    });
  },

  // ── 顏色（讀 CSS 變數，不硬編 hex）──
  cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  },
  signClass(v) { return v > 0 ? 'up' : v < 0 ? 'down' : ''; },
  signColor(v) { return this.cssVar(v >= 0 ? '--green' : '--red'); },

  // ── DOM ──
  el(id) { return document.getElementById(id); },
  html(id, s) { const e = this.el(id); if (e) e.innerHTML = s; },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  // ── 迷你因子條 ──
  bar(v) {
    const pct = Math.min(Math.abs(v || 0) * 100, 100);
    return `<div class="bar"><i style="width:${pct}%;background:${this.signColor(v || 0)}"></i></div>`;
  },
  bars(f) {
    return `<div class="bars">${this.bar(f.tech)}${this.bar(f.chip)}${this.bar(f.sent)}${this.bar(f.fund)}</div>`;
  },

  // ── 動態載入圖表庫（同 URL 只載一次）──
  _scripts: {},
  loadScript(url) {
    if (this._scripts[url]) return this._scripts[url];
    this._scripts[url] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = res;
      s.onerror = () => rej(new Error('載入失敗: ' + url));
      document.head.appendChild(s);
    });
    return this._scripts[url];
  },
  CDN: {
    lwc: 'https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js',
    chartjs: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  },

  // ── 表格排序（點表頭）──
  sortBy(rows, key, dir) {
    return [...rows].sort((a, b) => {
      const x = a[key], y = b[key];
      const nx = (x === null || x === undefined) ? -Infinity : x;
      const ny = (y === null || y === undefined) ? -Infinity : y;
      if (typeof nx === 'string' || typeof ny === 'string')
        return dir * String(nx).localeCompare(String(ny));
      return dir * (nx - ny);
    });
  },
};

/* ═══════════════════════════════════════════════════════
   磚牆排版（masonry）—— 把高度不一的區塊塞進 N 欄，欄高盡量齊

   為什麼不用 CSS multi-column：
     實測過。區塊不可分割時瀏覽器的平衡演算法會失手——
     5 個區塊（370/470/185/414/396px）分 3 欄，結果只用了 2 欄，
     最高欄 1094px，比分 4 欄的 861px 還糟。
   為什麼不用 CSS Grid：
     同列會對齊到最高者，短區塊下方留大片空白。
   這裡用最簡單的貪婪法：量完高度後，逐一放進「當下最矮的那欄」。
     同一組資料算出來 599px，比上面兩種都好。
   ═══════════════════════════════════════════════════════ */
window.TQMasonry = {
  /**
   * @param {string|Element} container 內含 .pane 子元素的容器
   * @param {number} cols 欄數
   */
  layout(container, cols) {
    const box = (typeof container === 'string')
      ? document.getElementById(container) : container;
    if (!box) return;

    // 第一次呼叫時把原始順序記下來，之後重排都以它為準
    if (!box._panes) box._panes = Array.from(box.querySelectorAll('.pane'));
    const panes = box._panes;
    if (!panes.length) return;

    if (cols <= 1) {                    // 單欄：還原成直接排列
      box.classList.remove('masonry');
      box.innerHTML = '';
      panes.forEach(p => box.appendChild(p));
      return;
    }

    // 先量高度（要在有版面的狀態下量，所以先照單欄放回去）
    box.classList.remove('masonry');
    box.innerHTML = '';
    panes.forEach(p => box.appendChild(p));
    const heights = panes.map(p => p.offsetHeight);

    // 建欄
    box.classList.add('masonry');
    box.innerHTML = '';
    const colEls = [], colH = [];
    for (let i = 0; i < cols; i++) {
      const c = document.createElement('div');
      c.className = 'mcol';
      box.appendChild(c);
      colEls.push(c);
      colH.push(0);
    }
    // 貪婪：每塊放進當下最矮的欄
    panes.forEach((p, i) => {
      let k = 0;
      for (let j = 1; j < cols; j++) if (colH[j] < colH[k]) k = j;
      colEls[k].appendChild(p);
      colH[k] += heights[i];
    });
    return colH;
  },

  /**
   * 丟掉快取的區塊清單。
   * 呼叫端若重建了容器的 innerHTML（例如搜尋結果重繪），
   * 必須先呼叫這個，否則 layout() 會去排一堆已經被換掉的舊元素。
   */
  reset(container) {
    const box = (typeof container === 'string')
      ? document.getElementById(container) : container;
    if (box) box._panes = null;
  },

  /** 依視窗寬度決定欄數並排版；回傳實際欄數 */
  auto(container, breakpoints) {
    const bp = breakpoints || [[2600, 4], [1700, 3], [1100, 2], [0, 1]];
    const w = window.innerWidth;
    const cols = (bp.find(([min]) => w >= min) || [0, 1])[1];
    this.layout(container, cols);
    return cols;
  },
};

/* 主題鈕自動接線：每頁的標頭列都有 <span class="theme-sw" id="themeSw">，
   在這裡統一填內容與掛事件，六個頁面不必各寫一次（寫六次就會分歧）。 */
document.addEventListener('DOMContentLoaded', () => {
  TQ.themeSwitch(document.getElementById('themeSw'));
});
