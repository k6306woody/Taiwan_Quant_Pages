/* ═══════════════════════════════════════════════════════
   K 線元件 —— 取代三份近乎相同的實作
   （dashboard / stock_detail / cloud_dashboard）

   契約容錯是關鍵：
     本機 API 回 ma5/ma20/ma60 + markers（伺服器算好）
     雲端 API 只回 candles（無均線、無標記）
   → 欄位缺失即跳過；autoSMA=true 時前端自算均線（雲端用）
   ═══════════════════════════════════════════════════════ */
window.TQKline = {
  /** 簡單移動平均（雲端路徑用：伺服器沒算均線時前端補算）*/
  sma(candles, n) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < candles.length; i++) {
      sum += candles[i].close;
      if (i >= n) sum -= candles[i - n].close;
      if (i >= n - 1) out.push({ time: candles[i].time, value: +(sum / n).toFixed(2) });
    }
    return out;
  },

  /**
   * 繪製 K 線
   * @param {string|Element} target 容器
   * @param {object} data {candles, volume?, ma5?, ma20?, ma60?, markers?}
   * @param {object} opts {height, showVolume, showMarkers, autoSMA}
   * @returns {{chart, destroy}|null}
   */
  render(target, data, opts = {}) {
    const box = (typeof target === 'string') ? document.getElementById(target) : target;
    if (!box || typeof LightweightCharts === 'undefined') return null;
    if (!data || !data.candles || !data.candles.length) {
      box.innerHTML = '<div class="loading">無 K 線資料</div>';
      return null;
    }

    const o = Object.assign(
      { height: 300, showVolume: true, showMarkers: true, autoSMA: false }, opts);
    const cv = (n) => TQ.cssVar(n);

    // 舊圖存在就先清掉（三處原本都各自處理這段，容易漏）
    if (box._tqChart) { try { box._tqChart.remove(); } catch (e) {} box._tqChart = null; }
    box.innerHTML = '';

    const chart = LightweightCharts.createChart(box, {
      width: box.clientWidth, height: o.height,
      // 圖表底色用透明，讓它吃外層面板的底。
      // 原本讀 --card：高對比主題下那是純黑、跟面板同色沒問題，但玻璃
      // 主題的 --card 是半透明 rgba，lightweight-charts 會把它畫成一塊
      // 不透明的深色矩形——半透明面板裡冒出一個實心方塊，
      // 看起來像「卡片裡又有一張卡片」。
      layout: { background: { color: 'transparent' },
                textColor: cv('--text'), fontSize: 10 },
      grid: { vertLines: { color: '#232338' }, horzLines: { color: '#232338' } },
      timeScale: { borderColor: cv('--border'), rightOffset: 2 },
      rightPriceScale: { borderColor: cv('--border') },
      crosshair: { mode: 1 },
    });
    box._tqChart = chart;

    const up = cv('--green'), down = cv('--red');
    const cs = chart.addCandlestickSeries({
      upColor: up, downColor: down, borderUpColor: up,
      borderDownColor: down, wickUpColor: up, wickDownColor: down,
    });
    cs.setData(data.candles);

    if (o.showVolume && data.volume && data.volume.length) {
      const vs = chart.addHistogramSeries({ priceScaleId: '', priceFormat: { type: 'volume' } });
      vs.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
      vs.setData(data.volume);
    }

    // 均線：伺服器有給就用，沒有且 autoSMA 才自算
    const addMA = (arr, color) => {
      if (!arr || !arr.length) return;
      const s = chart.addLineSeries({
        color, lineWidth: 1, priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerVisible: false,
      });
      s.setData(arr);
    };
    const ma5 = data.ma5 && data.ma5.length ? data.ma5
      : (o.autoSMA && data.candles.length >= 5 ? this.sma(data.candles, 5) : null);
    const ma20 = data.ma20 && data.ma20.length ? data.ma20
      : (o.autoSMA && data.candles.length >= 20 ? this.sma(data.candles, 20) : null);
    const ma60 = data.ma60 && data.ma60.length ? data.ma60
      : (o.autoSMA && data.candles.length >= 60 ? this.sma(data.candles, 60) : null);
    addMA(ma5, cv('--purple'));
    addMA(ma20, cv('--blue'));
    addMA(ma60, cv('--orange'));

    // 買賣訊號標記（雲端無此欄位 → 自動跳過）
    if (o.showMarkers && data.markers && data.markers.length) {
      cs.setMarkers(data.markers);
    }

    chart.timeScale().fitContent();

    /* ── 尺寸跟著容器走（不是跟著視窗）─────────────────────
       原本只聽 window.resize，而且只改寬度。兩個問題：

       1. **建立當下容器可能還沒有版面**。總覽頁的 K 線高度由格線分配，
          圖表建立時 box.clientWidth 量到 300，之後版面算完變成 370——
          沒有視窗縮放事件，圖表就永遠停在 300。實測 canvas 的內部寬度
          300 被 CSS 拉伸到 370，價格軸的位置跟著算錯，標籤壓到隔壁的
          排行表上（使用者回報「GUI 元件會疊在一起」）。
       2. 容器變大變小不一定伴隨視窗縮放——換分頁、側欄展開、
          格線重算都會改容器尺寸。

       ResizeObserver 直接盯容器，兩種情況一次解決，也不必再從外面
       手動重畫（重畫會多打一次 API，資料根本沒變）。 */
    const fit = () => {
      const w = box.clientWidth, h = box.clientHeight;
      if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h });
    };
    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(fit);
      ro.observe(box);
    }
    // 沒有 ResizeObserver 的環境（舊 QtWebEngine）退回聽視窗
    const onResize = () => fit();
    if (!ro) window.addEventListener('resize', onResize);

    return {
      chart,
      destroy() {
        if (ro) ro.disconnect();
        else window.removeEventListener('resize', onResize);
        try { chart.remove(); } catch (e) {}
        box._tqChart = null;
      },
    };
  },

  /** 便捷：載入圖表庫 → 抓資料 → 繪製 */
  async load(target, url, opts = {}) {
    await TQ.loadScript(TQ.CDN.lwc);
    const d = await TQ.api(url);
    if (d._error) {
      const box = (typeof target === 'string') ? document.getElementById(target) : target;
      if (box) box.innerHTML = `<div class="loading">K 線載入失敗</div>`;
      return null;
    }
    return this.render(target, d, opts);
  },
};
