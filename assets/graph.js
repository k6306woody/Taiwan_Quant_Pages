/* ═══════════════════════════════════════════════════════
   力導向關聯網路圖（TQGraph）

   為什麼自己寫而不是拉 d3/vis.js：
     這個專案的頁面一律零外部相依（CDN 只用在圖表庫且是按需載入）。
     104 個節點、273 條邊的規模，Fruchterman-Reingold 用純 JS
     跑起來毫無壓力，沒必要為它多背一個 250KB 的函式庫。

   演算法：Fruchterman-Reingold（1991）
     理想間距 k = √(畫布面積 / 節點數)
     斥力  fr(d) = k²/d   作用在所有節點對之間（把圖攤開）
     引力  fa(d) = d²/k   只作用在有連線的節點對（把相關的拉近）
     每回合的位移受「溫度」上限限制，溫度逐回合下降 → 收斂

   實測參數依據（104 節點 / 273 邊 / 平均度 5.2）：
     畫布 1600×1000 → k ≈ 124px，節點不會擠成一團也不會散到看不見
   ═══════════════════════════════════════════════════════ */
window.TQGraph = (function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, text) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * @param {object} opts
   *   container  容器元素或 id
   *   nodes      [{id, label, group, weight}]
   *   edges      [[idA, idB]] 或 [[idA, idB, 權重]]
   *   colorOf    (group) => css color
   *   onSelect   (id) => void   點節點時呼叫
   *
   *   以下皆可省略，省略時行為與加入這些選項之前完全相同：
   *   radiusOf   (node, deg) => 半徑
   *   strokeOf   (node) => 描邊色（預設 colorOf(group)）
   *   fillOf     (node) => 填色（預設 var(--card)）
   *   edgeAttr   (權重, 種類) => {width, stroke, opacity, dash}
   *   pivotOf    (節點) => 是不是 radial 佈局的軸心（預設 kind==='hub'）
   *   alwaysLabel(node, deg) => 是否常駐顯示標籤（預設 deg >= 7）
   *   titleOf    (node, deg) => 滑鼠停留的原生提示文字
   */
  function create(opts) {
    const box = (typeof opts.container === 'string')
      ? document.getElementById(opts.container) : opts.container;
    if (!box) return null;

    // 畫布尺寸可由呼叫端指定。手機是直的，橫向畫布 meet 進去之後
    // 上下會空掉一大半（實測 351×600 的框只用到 226px 高），
    // 直接給一張直式畫布比留白好。省略時維持原本的 1600×1000。
    const W = opts.width || 1600, H = opts.height || 1000;
    const nodes = opts.nodes.map(n => ({ ...n }));
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    // 第三個元素是權重，沒給就當 1——不給權重的呼叫端（名詞解說頁）
    // 因此完全不受影響，引力公式乘上 1 等於沒乘。
    const ew = [];
    const ek = [];                            // 每條邊的關係種類
    const edges = opts.edges
      .map(([a, b, w, k]) => [index.get(a), index.get(b),
                              (w == null ? 1 : w), k])
      .filter(([a, b]) => a != null && b != null && a !== b)
      // 第四個元素是「這條線是什麼關係」（競爭／集團／…）。
      // 權重只能表達強弱，表達不了種類——同一張圖上兩種關係
      // 混在一起而只有粗細差別，沒有人分得出來。
      .map(([a, b, w, kind]) => { ew.push(w); ek.push(kind || ''); return [a, b]; });

    // 引力權重：用絕對值，且下限 0.35。
    // 為什麼要下限——相關性 0.1 的邊如果引力也只有 0.1，那條線會被
    // 斥力扯到畫布對角，看起來像兩個毫無關係的點卻連著一條長線，
    // 比不畫還誤導。下限讓弱連結「近一點但不黏住」。
    const pull = ew.map(w => Math.max(0.35, Math.min(1, Math.abs(w))));

    // 鄰接表：hover 時要立刻知道誰跟誰相連
    const nbr = nodes.map(() => new Set());
    edges.forEach(([a, b]) => { nbr[a].add(b); nbr[b].add(a); });
    nodes.forEach((n, i) => { n.deg = nbr[i].size; });

    // ── 初始位置：依分類分群放在圓周上 ──────────────────
    // 純亂數起始會讓收斂慢且每次結果差很多；先按分類擺開，
    // 力導向只需要微調，圖也比較穩定（重開一次不會整個變樣）。
    const groups = [...new Set(nodes.map(n => n.group))];
    const gIdx = new Map(groups.map((g, i) => [g, i]));
    nodes.forEach((n, i) => {
      const gi = gIdx.get(n.group);
      const ga = (gi / groups.length) * 2 * Math.PI;
      const gx = W / 2 + Math.cos(ga) * W * 0.28;
      const gy = H / 2 + Math.sin(ga) * H * 0.28;
      const a = (i / nodes.length) * 2 * Math.PI * 7;   // 群內散開
      n.x = gx + Math.cos(a) * 60;
      n.y = gy + Math.sin(a) * 60;
      n.vx = 0; n.vy = 0;
    });

    const k = Math.sqrt((W * H) / nodes.length);
    let temp = W / 8;
    let iter = 0;
    const MAX_ITER = 420;

    /* ── 佈局模式（opts.layout）─────────────────────────────
       力導向不是唯一合理的擺法，而且它的座標**本身沒有意義**——
       只有「誰離誰近」有意義。所以提供另外兩種把某個屬性直接編碼
       進座標的擺法，使用者可以自己挑：

         force   力導向（預設）。看整體結構、誰是中心。
         group   依分類分成同心扇區。想比較「哪一類比較密」時最清楚。
         radial  樞紐放中間、成分股繞著它排。ETF／產業模式專用，
                 一眼看出每個樞紐帶多少檔、誰被多個樞紐共用。
         stage   依 opts.colOf(n) 排成直欄。產業鏈模式專用——
                 x 座標＝鏈上位置，左邊是上游、右邊是末端。

       後兩種擺完就不跑力導向了（跑了就會把刻意的排列打散）。 */
    const LAYOUT = opts.layout || 'force';

    function layoutGroup() {
      const byG = new Map();
      nodes.forEach((n, i) => {
        if (!byG.has(n.group)) byG.set(n.group, []);
        byG.get(n.group).push(i);
      });
      const gs = [...byG.keys()];
      const cx = W / 2, cy = H / 2;
      const Rmax = Math.min(W, H) * 0.44;
      gs.forEach((g, gi) => {
        const members = byG.get(g);
        // 每個分類佔一個扇形，扇形的角度寬度正比於它有幾個成員，
        // 這樣大的分類不會被擠成一條線
        const a0 = gs.slice(0, gi).reduce(
          (s, x) => s + byG.get(x).length, 0) / nodes.length * 2 * Math.PI;
        const aw = members.length / nodes.length * 2 * Math.PI;
        members.forEach((idx, j) => {
          const t = members.length === 1 ? 0.5 : j / (members.length - 1);
          const a = a0 + aw * (0.08 + t * 0.84);
          // 半徑交錯，同一扇形裡不會排成一條直線
          const r = Rmax * (0.42 + 0.58 * ((j % 3) / 2)) * (0.9 + 0.1 * t);
          nodes[idx].x = cx + Math.cos(a) * r;
          nodes[idx].y = cy + Math.sin(a) * r * 0.92;
        });
      });
    }

    function layoutRadial() {
      // 「誰是樞紐」由呼叫端決定。預設是 kind==='hub'，但公司關係圖
      // 沒有樞紐節點——它的中心是一檔**股票**，只是圖以它為軸。
      // 不開這個口的話那張圖會退回力導向，中心跟鄰居長得一樣散。
      const isPivot = opts.pivotOf || (n => n.kind === 'hub');
      const hubs = nodes.map((n, i) => [n, i]).filter(([n]) => isPivot(n));
      if (!hubs.length) return false;          // 沒有樞紐就退回力導向
      const cx = W / 2, cy = H / 2;
      const hubR = Math.min(W, H) * 0.30;
      const placed = new Set();

      /* 只有一個軸心時（公司關係圖）要特別處理。

         一般情況下軸心是沿著半徑 hubR 的圓周排開的，因為有好幾個。
         只有一個的時候那套算法會把它擺在圓周上的某一點，鄰居再擠進
         1.9 弧度的扇形裡——實測 29 個鄰居疊成一團，中心還偏在上方。
         一個軸心就該放圓心，鄰居鋪滿整圈。 */
      if (hubs.length === 1) {
        const [, hi] = hubs[0];
        nodes[hi].x = cx;
        nodes[hi].y = cy;
        const ring = [...nbr[hi]];
        const R = Math.min(W, H) * 0.36;
        ring.forEach((j, m) => {
          const a = (m / Math.max(1, ring.length)) * 2 * Math.PI - Math.PI / 2;
          // 半徑交錯兩層，標籤才不會沿著同一個圓環互相貼住
          const rr = R * (m % 2 ? 1 : 0.74);
          nodes[j].x = cx + Math.cos(a) * rr;
          nodes[j].y = cy + Math.sin(a) * rr * 0.92;
        });
        const seen = new Set([hi, ...ring]);
        nodes.forEach((n, i) => {
          if (seen.has(i)) return;
          const a = (i / nodes.length) * 2 * Math.PI;
          nodes[i].x = cx + Math.cos(a) * R * 1.35;
          nodes[i].y = cy + Math.sin(a) * R * 1.24;
        });
        return true;
      }
      hubs.forEach(([, hi], k2) => {
        const a = (k2 / hubs.length) * 2 * Math.PI - Math.PI / 2;
        nodes[hi].x = cx + Math.cos(a) * hubR;
        nodes[hi].y = cy + Math.sin(a) * hubR;
        placed.add(hi);
        // 只有「唯一屬於這個樞紐」的成分股繞著它排；被多個樞紐共用的
        // 留給後面丟到中間——那正好表達「它是共用的」
        const own = [...nbr[hi]].filter(j => nbr[j].size === 1);
        own.forEach((j, m) => {
          const aa = a + (m / Math.max(1, own.length) - 0.5) * 1.9;
          const rr = Math.min(W, H) * 0.17;
          nodes[j].x = nodes[hi].x + Math.cos(aa) * rr;
          nodes[j].y = nodes[hi].y + Math.sin(aa) * rr;
          placed.add(j);
        });
      });
      const rest = nodes.map((_, i) => i).filter(i => !placed.has(i));
      rest.forEach((i, m) => {
        const a = (m / Math.max(1, rest.length)) * 2 * Math.PI;
        const r = Math.min(W, H) * 0.11 * (0.5 + (m % 4) / 4);
        nodes[i].x = cx + Math.cos(a) * r;
        nodes[i].y = cy + Math.sin(a) * r;
      });
      return true;
    }

    /* 分段直欄：把「鏈上位置」直接編碼成 x 座標。
       力導向的座標本身沒有意義，所以它畫不出「上下游」——不管跑幾遍，
       上游都可能跑到右邊。要讓人一眼看出前後端，位置就必須是**規定的**
       而不是算出來的：欄 = 分段，由左至右就是上游→末端。

       欄位由 opts.colOf(n) 決定（回傳 0..k-1）。樞紐排在欄的正中央，
       成分股掛在自己的樞紐旁邊。 */
    /* 直的還是橫的？

       手機是 375px 寬。五欄擠進去每欄只有 66px，碰撞分離一跑，
       欄的結構整個糊掉——實測航運業跑到最左欄、橡膠工業跑到中間，
       欄名也互相疊在一起。等於白畫。

       畫布是直的時候就把分段疊成**橫帶**（上游在最上、末端在最下）。
       順序沒有變，只是換一個軸；而直式畫布上「由上而下」本來就比
       「由左至右」更自然。 */
    const VERT = H > W * 1.05;

    function layoutStage() {
      if (!opts.colOf) return false;
      const col = nodes.map(n => Math.max(0, opts.colOf(n) | 0));
      const ncol = Math.max(...col) + 1;
      if (!isFinite(ncol) || ncol < 2) return false;
      const cw = (VERT ? H : W) / ncol;      // 一段的厚度
      const span = VERT ? W : H;             // 段內可以鋪開的長度

      // 每欄的樞紐；成分股跟著自己的樞紐走（連到多個樞紐時取第一個）
      // 一檔股票可能同時掛在 ETF 與產業底下（全方位模式）。挑**欄號最小**
      // 的那個樞紐當歸屬——ETF 排在最右邊的自己那一欄，這樣挑等於
      // 「優先站在製造鏈上的位置」，圖的主體就是那條鏈，
      // ETF 變成從右邊伸過來的線。反過來挑的話整張圖會塌到 ETF 那一欄。
      const hubOf = nodes.map(() => -1);
      nodes.forEach((n, i) => {
        if (n.kind === 'hub') return;
        let best = -1;
        for (const j of nbr[i]) {
          if (nodes[j].kind !== 'hub') continue;
          if (best < 0 || col[j] < col[best]) best = j;
        }
        hubOf[i] = best;
      });
      // 成分股的欄跟著樞紐——不然「不分段」的個股會被丟到別欄，
      // 線就會橫跨整張圖，欄位的意義立刻消失
      nodes.forEach((n, i) => { if (hubOf[i] >= 0) col[i] = col[hubOf[i]]; });

      const byCol = new Map();
      nodes.forEach((n, i) => {
        if (n.kind !== 'hub') return;
        if (!byCol.has(col[i])) byCol.set(col[i], []);
        byCol.get(col[i]).push(i);
      });

      // 把 (沿段的座標 a, 跨段的座標 b) 寫回節點。
      // 直式時 a 是 x、b 是 y；橫式時反過來。只有這一層要分方向，
      // 上面的配額計算兩種情況完全一樣。
      const put = (i, a, b) => {
        if (VERT) { nodes[i].x = a; nodes[i].y = b; }
        else      { nodes[i].x = b; nodes[i].y = a; }
      };

      for (const [c, hubs] of byCol) {
        // 段內配額正比於成員數，成員多的產業不會被擠成一條線
        const load = hubs.map(h => Math.max(1, nbr[h].size));
        const tot = load.reduce((a, b) => a + b, 0);
        let acc = 0;
        hubs.forEach((h, k2) => {
          const a0 = 40 + (acc / tot) * (span - 80);
          const a1 = 40 + ((acc + load[k2]) / tot) * (span - 80);
          acc += load[k2];
          // 直式時帶子的最上緣要留給欄名，內容整個往下推一點，
          // 不然標題會蓋在節點上（橫式的欄名畫在畫布外的留白，不必推）
          const mid = VERT ? cw * c + cw * 0.58 : cw * (c + 0.5);
          put(h, (a0 + a1) / 2, mid);
          const own = [...nbr[h]].filter(j => hubOf[j] === h);
          const band = Math.max(30, (a1 - a0) * 0.9);
          own.forEach((j, m) => {
            // 在樞紐周圍鋪成一個小網格：沿段先鋪，滿了才往厚度方向疊
            const per = Math.max(2, Math.round(Math.sqrt(own.length) * 1.4));
            const r0 = Math.floor(m / per), c0 = m % per;
            const rows = Math.max(1, Math.ceil(own.length / per));
            put(j,
                (a0 + a1) / 2 + (c0 - (per - 1) / 2) * (band / per),
                mid + (r0 - (rows - 1) / 2) * (cw * 0.62 / rows));
          });
        });
      }
      // 沒掛到任何樞紐的（例如相關性模式的孤點）丟到最後一段的邊上
      nodes.forEach((n, i) => {
        if (n.kind !== 'hub' && hubOf[i] < 0) {
          put(i, span - 40 - (i % 7) * 14,
              cw * (ncol - 0.5) + ((i % 5) - 2) * 18);
        }
      });
      return true;
    }

    function step() {
      const disp = nodes.map(() => ({ x: 0, y: 0 }));

      // 斥力：所有節點對（104² = 10,816 對，純 JS 毫無壓力）
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dx = nodes[i].x - nodes[j].x;
          let dy = nodes[i].y - nodes[j].y;
          let d = Math.hypot(dx, dy) || 0.01;
          // 兩點完全重疊時給一個隨機微小偏移，否則會卡住不動
          if (d < 0.05) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = 0.05; }
          const f = (k * k) / d;
          const ux = dx / d, uy = dy / d;
          disp[i].x += ux * f; disp[i].y += uy * f;
          disp[j].x -= ux * f; disp[j].y -= uy * f;
        }
      }

      // 引力：只沿著邊，強度乘上該條邊的權重
      for (let e = 0; e < edges.length; e++) {
        const [a, b] = edges[e];
        const dx = nodes[a].x - nodes[b].x;
        const dy = nodes[a].y - nodes[b].y;
        const d = Math.hypot(dx, dy) || 0.01;
        const f = (d * d) / k * pull[e];
        const ux = dx / d, uy = dy / d;
        disp[a].x -= ux * f; disp[a].y -= uy * f;
        disp[b].x += ux * f; disp[b].y += uy * f;
      }

      /* ── 向心力：取代原本的「硬性夾邊」────────────────────
         原本每一回合都把座標夾進 [40,W-40]×[30,H-30]。被斥力推出去
         的節點會**貼在邊界上不動**，下一回合再被推、再被夾——結果是
         一排排整齊貼著上緣與左緣的點（使用者的截圖就是這樣，看起來
         完全不像力導向，像被誰用尺排過）。

         改成往中心拉的彈簧：離中心越遠拉得越強，節點自己就不會跑出
         畫布，而且是「被拉回來」不是「被壓在牆上」。

         橫軸與縱軸分開算：寬螢幕的畫布很扁，用同一個強度的話縱向會
         被壓成一條線。各自除以自己那一軸的半徑，圖才會填滿整個框。 */
      const cx = W / 2, cy = H / 2;
      const gx = 0.045, gy = 0.045;
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].fixed) continue;              // 被拖曳中的節點不參與
        disp[i].x -= (nodes[i].x - cx) / (W / 2) * k * gx * nodes.length * 0.5;
        disp[i].y -= (nodes[i].y - cy) / (H / 2) * k * gy * nodes.length * 0.5;

        const d = Math.hypot(disp[i].x, disp[i].y) || 0.01;
        const lim = Math.min(d, temp);
        nodes[i].x += (disp[i].x / d) * lim;
        nodes[i].y += (disp[i].y / d) * lim;
      }
      temp = Math.max(temp * 0.975, 0.6);
      iter++;
    }

    /* ── 碰撞分離：力導向收斂後的補救 ──────────────────────
       Fruchterman-Reingold 只保證「平均」間距是 k，不保證任何一對
       節點不重疊。這張圖 74% 的邊落在同一分類內，形成密集叢集：
       一個有 15 條連線的節點會吃到 15 份引力，卻只有分散的斥力抵抗，
       於是被拉進鄰居身上。實測收斂後仍有 16/104 個節點的最近鄰
       在 20px 內（最近的一對只差 7.3px，圓已經疊在一起）。

       做法跟 d3-force 的 collide 一樣：反覆把距離小於
       「兩半徑相加 + 留白」的節點對，沿連線方向各推開一半。
       O(回合 × n²) = 140 × 5,356，純 JS 幾毫秒，值得。

       PAD 取 8px：兩個最大節點（15 條線，r≈19.4）分開後仍有 8px
       空隙，描邊不會黏在一起。                                */
    // 節點半徑隨連線數成長（開根號，否則 15 條線的節點會大到誇張）
    const rOf = opts.radiusOf
      ? (n => opts.radiusOf(n, n.deg))
      : (n => 7 + Math.sqrt(n.deg) * 3.2);
    // PAD 從 8 加到 14：節點會持續微幅漂移（見下方 drift），
    // 兩顆相向漂移最多各吃掉 3px，留 14 才能保證任何時刻仍有 8px 空隙。
    const PAD = 14;
    function separate(passes) {
      const r = nodes.map(rOf);
      const mx = 26, my = 22;          // 邊界留白
      for (let p = 0; p < passes; p++) {
        let hits = 0;
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const need = r[i] + r[j] + PAD;
            let dx = nodes[j].x - nodes[i].x;
            let dy = nodes[j].y - nodes[i].y;
            let d = Math.hypot(dx, dy);
            if (d >= need) continue;
            if (d < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = 0.01; }
            const push = (need - d) / 2 / d;
            nodes[i].x -= dx * push; nodes[i].y -= dy * push;
            nodes[j].x += dx * push; nodes[j].y += dy * push;
            hits++;
          }
        }
        /* 邊界用「彈回」而不是「夾住」。

           夾住的話，被推到界外的節點會停在**同一個座標**上，一整排
           不同的點疊成一條完美的直線——那正是使用者截圖裡上緣與左緣
           那幾排點的來源。彈回則是把超出的量反射回畫布內，每個點
           反射的距離不同，不會對齊。 */
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i], lo = r[i] + mx, hiX = W - r[i] - mx;
          const loY = r[i] + my, hiY = H - r[i] - my;
          if (n.x < lo)   n.x = lo + (lo - n.x) * 0.5;
          if (n.x > hiX)  n.x = hiX - (n.x - hiX) * 0.5;
          if (n.y < loY)  n.y = loY + (loY - n.y) * 0.5;
          if (n.y > hiY)  n.y = hiY - (n.y - hiY) * 0.5;
          // 反射之後仍可能落在界外（畫布比節點還小時），這時才夾
          n.x = Math.max(lo, Math.min(hiX, n.x));
          n.y = Math.max(loY, Math.min(hiY, n.y));
        }
        if (!hits) break;      // 已經沒有任何重疊，提早結束
      }
    }

    // ── SVG 骨架 ─────────────────────────────────────────
    box.innerHTML = '';
    const svg = el('svg', {
      // viewBox 四周留 20/40px 餘裕：節點座標被夾在 [40,W-40]×[30,H-30]，
      // 但標籤畫在節點下方 r+13 處，最底下那排會超出 3.7px 被裁掉。
      // 留白比夾更緊更好——夾更緊會讓版面被壓縮。
      viewBox: `-20 -20 ${W + 40} ${H + 60}`, class: 'tqg',
      preserveAspectRatio: 'xMidYMid meet',
    });
    const gRoot = el('g', {});                 // 縮放平移都套在這層
    const gBg = el('g', { class: 'tqg-bands' });
    const gEdge = el('g', { class: 'edges' });
    const gNode = el('g', { class: 'nodes' });
    gRoot.appendChild(gBg); gRoot.appendChild(gEdge); gRoot.appendChild(gNode);
    svg.appendChild(gRoot);
    box.appendChild(svg);

    const edgeEls = edges.map((_, i) => {
      const l = el('line', { class: 'tqg-edge' });
      if (opts.edgeAttr) {
        const a = opts.edgeAttr(ew[i], ek[i]) || {};
        if (a.width != null) l.setAttribute('stroke-width', a.width);
        if (a.stroke) l.setAttribute('stroke', a.stroke);
        if (a.opacity != null) l.setAttribute('opacity', a.opacity);
        if (a.dash) l.setAttribute('stroke-dasharray', a.dash);
      }
      gEdge.appendChild(l);
      return l;
    });


    const nodeEls = nodes.map((n, i) => {
      const g = el('g', { class: 'tqg-node', 'data-i': i });
      // 形狀是第二個編碼通道：全方位模式裡 ETF 與產業都是樞紐，
      // 光靠顏色分不出來（顏色已經拿去講訊號了）。
      const r = rOf(n);
      const sq = opts.shapeOf && opts.shapeOf(n) === 'square';
      const c = sq
        ? el('rect', {
            x: -r, y: -r, width: r * 2, height: r * 2,
            rx: Math.max(3, r * 0.32),
            fill: opts.fillOf ? opts.fillOf(n) : 'var(--card)',
            stroke: opts.strokeOf ? opts.strokeOf(n) : opts.colorOf(n.group),
            'stroke-width': 2.2,
          })
        : el('circle', {
            r: r,
            fill: opts.fillOf ? opts.fillOf(n) : 'var(--card)',
            stroke: opts.strokeOf ? opts.strokeOf(n) : opts.colorOf(n.group),
            'stroke-width': 2.2,
          });
      // 標籤：連線多的一直顯示，其餘只在 hover／放大時顯示，
      // 否則 104 個標籤疊在一起完全看不懂
      const always = opts.alwaysLabel
        ? opts.alwaysLabel(n, n.deg) : (n.deg >= 7);
      const t = el('text', {
        class: 'tqg-lbl' + (always ? ' always' : ''),
        y: rOf(n) + 13, 'text-anchor': 'middle',
      }, n.label);
      g.appendChild(c); g.appendChild(t);
      g.appendChild(el('title', {}, opts.titleOf
        ? opts.titleOf(n, n.deg)
        : `${n.label}（${n.group}・${n.deg} 個關聯）`));
      gNode.appendChild(g);
      return g;
    });

    function paint() {
      edges.forEach(([a, b], i) => {
        const e = edgeEls[i];
        e.setAttribute('x1', nodes[a].x); e.setAttribute('y1', nodes[a].y);
        e.setAttribute('x2', nodes[b].x); e.setAttribute('y2', nodes[b].y);
      });
      nodes.forEach((n, i) => {
        nodeEls[i].setAttribute('transform', `translate(${n.x},${n.y})`);
      });
    }

    /* 欄位背景：交錯底色 + 欄名 + 欄與欄之間的箭頭。
       ⚠ 箭頭畫在**欄與欄之間**，不是畫在公司之間——它表達的是
       「上游在左、下游在右」這個順序，不是「A 供貨給 B」。
       畫成公司對公司會憑空生出一份我們根本沒有的供應鏈資料。 */
    function drawBands(cols) {
      const ncol = cols.length;
      const vert = H > W * 1.05;
      const cw = (vert ? H : W) / ncol;
      const defs = el('defs', {});
      defs.innerHTML = '<marker id="tqgArrow" viewBox="0 0 10 10" refX="9" '
        + 'refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
        + '<path d="M0,0 L10,5 L0,10 z" fill="var(--faint)"/></marker>';
      gBg.appendChild(defs);
      cols.forEach((c, i) => {
        const a = i * cw;
        if (i % 2 === 1) {
          gBg.appendChild(el('rect', vert
            ? { x: -18, y: a, width: W + 36, height: cw,
                fill: 'var(--raised)', opacity: 0.35 }
            : { x: a, y: -18, width: cw, height: H + 36,
                fill: 'var(--raised)', opacity: 0.35 }));
        }
        // 直式時欄名靠左貼在帶子的上緣，橫式時置中放在畫布上方
        gBg.appendChild(el('text', vert
          ? { class: 'tqg-band-lbl', x: 4, y: a + 15, 'text-anchor': 'start' }
          : { class: 'tqg-band-lbl', x: a + cw / 2, y: -2,
              'text-anchor': 'middle' }, c.label));
        if (i < ncol - 1) {
          const b = a + cw;
          gBg.appendChild(el('line', vert
            ? { class: 'tqg-band-arrow', x1: -10, y1: b - 14, x2: -10, y2: b + 14,
                stroke: 'var(--faint)', 'stroke-width': 1.4,
                'marker-end': 'url(#tqgArrow)' }
            : { class: 'tqg-band-arrow', x1: b - 26, y1: -7, x2: b + 26, y2: -7,
                stroke: 'var(--faint)', 'stroke-width': 1.4,
                'marker-end': 'url(#tqgArrow)' }));
        }
      });
    }

    // ── 一次算完，不做收斂動畫 ────────────────────────────
    // 原本用 requestAnimationFrame 分批跑，想讓使用者看到圖攤開。
    // 但 **rAF 在未顯示的分頁不會觸發** —— 開了圖之後切到別的分頁，
    // 版面就永遠停在算到一半的樣子（實測 31/104 個節點重疊到 20px 內，
    // 最近的一對只差 0.7px）。
    // 實測整整 420 回合同步跑完只要 **59ms**，動畫根本沒有存在必要，
    // 而且同步跑的結果是確定的：零節點在 20px 內、最近鄰中位數 73px。
    const _t0 = performance.now();
    let usedLayout = LAYOUT;
    if (LAYOUT === 'group') {
      layoutGroup();
    } else if (LAYOUT === 'radial') {
      if (!layoutRadial()) { usedLayout = 'force'; while (iter < MAX_ITER) step(); }
    } else if (LAYOUT === 'stage') {
      if (!layoutStage()) { usedLayout = 'force'; while (iter < MAX_ITER) step(); }
    } else {
      while (iter < MAX_ITER) step();
    }
    // 碰撞分離三種擺法都要跑：刻意的排列一樣會重疊，
    // 而重疊的節點是「看不見」不是「排得緊」。
    separate(140);
    paint();
    if (usedLayout === 'stage' && opts.columns && opts.columns.length) {
      drawBands(opts.columns);
    }
    const layoutMs = Math.round(performance.now() - _t0);
    // 用 setTimeout 讓監聽者來得及掛上（create() 還沒回傳）
    setTimeout(() => box.dispatchEvent(new CustomEvent(
      'tqg:settled', { detail: { ms: layoutMs, layout: usedLayout } })), 0);

    /* ── 持續漂移：讓圖「活著」 ───────────────────────────
       使用者要「node 在一個平面上滑動」的感覺，靜止的圖太死板。

       ⚠ 這裡**不是**拿 rAF 去跑佈局。那個坑已經踩過：rAF 在未顯示的
       分頁不會觸發，用它跑佈局的話，開了圖再切走，版面就永遠停在算到
       一半的樣子（實測 31/104 個節點重疊）。

       這裡的漂移是**疊在已經算好的位置上的偏移量**：
       每個節點有自己的相位與頻率，走一條利薩茹曲線。rAF 沒跑（分頁
       隱藏、或系統設定要求減少動態）時，節點就停在正確的最終位置——
       壞掉的方式是「不會動」，而不是「位置錯了」。

       振幅 3px 對上碰撞分離的 PAD=14：兩顆相向漂移最多各吃 3px，
       任何時刻仍有 8px 空隙，不會互相蓋住。 */
    const AMP = 3;
    nodes.forEach((n, i) => {
      n.bx = n.x; n.by = n.y;
      n.ph = (i * 2.399963) % (Math.PI * 2);      // 黃金角，相位不會撞在一起
      n.fx = 0.00021 + (i % 7) * 0.000032;
      n.fy = 0.00017 + (i % 5) * 0.000041;
    });

    let driftId = null;
    const wantsMotion = opts.drift !== false &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function driftStep(t) {
      for (const n of nodes) {
        if (n.fixed) continue;                     // 拖曳中的不要跟人搶
        n.x = n.bx + Math.sin(t * n.fx + n.ph) * AMP;
        n.y = n.by + Math.cos(t * n.fy + n.ph * 1.7) * AMP;
      }
      paint();
      driftId = requestAnimationFrame(driftStep);
    }
    if (wantsMotion) driftId = requestAnimationFrame(driftStep);

    /* ── 入場動畫 ────────────────────────────────────────
       佈局本身仍然是**一次算完**的（見上面那段：rAF 在隱藏分頁不會
       觸發，分批跑會停在算到一半的樣子）。這裡加的是純視覺的入場：
       節點畫在最終位置上，只是縮放與透明度從 0 漸入，依距離中心的
       遠近錯開。位置從頭到尾沒有動過，所以不會有「算到一半」的風險。

       尊重 prefers-reduced-motion：關掉動畫的人直接跳到最終狀態。 */
    if (opts.animate !== false &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const cx = W / 2, cy = H / 2;
      const far = Math.hypot(W, H) / 2 || 1;
      nodeEls.forEach((g, i) => {
        const d = Math.hypot(nodes[i].x - cx, nodes[i].y - cy) / far;
        g.style.setProperty('--in-delay', (d * 260).toFixed(0) + 'ms');
        g.classList.add('tqg-in');
      });
      edgeEls.forEach(e => e.classList.add('tqg-in'));
      // 動畫跑完就把 class 拿掉，之後拖曳／篩選不會再觸發一次
      setTimeout(() => {
        nodeEls.forEach(g => g.classList.remove('tqg-in'));
        edgeEls.forEach(e => e.classList.remove('tqg-in'));
      }, 1100);
    }

    // ── 互動：hover 高亮 ────────────────────────────────
    let hoverIdx = -1;
    function highlight(i) {
      hoverIdx = i;
      if (i < 0) {
        svg.classList.remove('focusing');
        nodeEls.forEach(g => g.classList.remove('dim', 'hot'));
        edgeEls.forEach(e => e.classList.remove('dim', 'hot'));
        return;
      }
      svg.classList.add('focusing');
      nodeEls.forEach((g, j) => {
        const on = (j === i) || nbr[i].has(j);
        g.classList.toggle('hot', on);
        g.classList.toggle('dim', !on);
      });
      edges.forEach(([a, b], j) => {
        const on = (a === i || b === i);
        edgeEls[j].classList.toggle('hot', on);
        edgeEls[j].classList.toggle('dim', !on);
      });
    }

    nodeEls.forEach((g, i) => {
      g.addEventListener('mouseenter', () => highlight(i));
      g.addEventListener('mouseleave', () => highlight(-1));
      g.addEventListener('click', ev => {
        ev.stopPropagation();
        if (!dragMoved) opts.onSelect && opts.onSelect(nodes[i].id);
      });
      // 拖曳
      g.addEventListener('pointerdown', ev => {
        ev.preventDefault();
        dragIdx = i; dragMoved = false;
        nodes[i].fixed = true;
        g.setPointerCapture(ev.pointerId);
      });
    });

    // ── 拖曳 / 平移 / 縮放 ──────────────────────────────
    let dragIdx = -1, dragMoved = false;
    let panning = false, panStart = null;
    let view = { x: 0, y: 0, s: 1 };

    function applyView() {
      gRoot.setAttribute('transform',
        `translate(${view.x},${view.y}) scale(${view.s})`);
      // 放大到一定程度後把所有標籤打開
      svg.classList.toggle('zoomed', view.s >= 1.6);
    }

    function toSvg(ev) {
      const r = svg.getBoundingClientRect();
      return {
        x: ((ev.clientX - r.left) / r.width) * W,
        y: ((ev.clientY - r.top) / r.height) * H,
      };
    }

    svg.addEventListener('pointermove', ev => {
      if (dragIdx >= 0) {
        const p = toSvg(ev);
        const n = nodes[dragIdx];
        n.x = (p.x - view.x) / view.s;
        n.y = (p.y - view.y) / view.s;
        // 基準位置也要更新，否則放開手之後漂移會把它拉回原處
        n.bx = n.x; n.by = n.y;
        dragMoved = true;
        paint();
      } else if (panning) {
        view.x += ev.clientX - panStart.x;
        view.y += ev.clientY - panStart.y;
        panStart = { x: ev.clientX, y: ev.clientY };
        applyView();
      }
    });
    svg.addEventListener('pointerup', () => {
      if (dragIdx >= 0) nodes[dragIdx].fixed = false;
      dragIdx = -1; panning = false;
    });
    svg.addEventListener('pointerdown', ev => {
      if (dragIdx < 0) { panning = true; panStart = { x: ev.clientX, y: ev.clientY }; }
    });
    /* 縮放要**按住 Ctrl（Mac 是 ⌘）**才會作用。

       原本滾輪直接縮放，結果是想捲頁面看下面的說明時，滑鼠只要經過
       圖上，整張圖就開始亂縮——使用者的回報是「滑鼠滾動卷軸很容易讓
       線路縮放，操作不易」。

       這也是地圖類元件的通用慣例（Google Maps 嵌入、Figma 都這樣）：
       沒按修飾鍵時把滾輪讓給頁面，頁面才捲得動。
       另外提供 zoomBy() 給頁面上的 +/− 按鈕，不必記快捷鍵。 */
    function zoomAt(factor, cx, cy) {
      const before = view.s;
      view.s = Math.max(0.5, Math.min(4, view.s * factor));
      view.x = cx - (cx - view.x) * (view.s / before);
      view.y = cy - (cy - view.y) * (view.s / before);
      applyView();
    }

    svg.addEventListener('wheel', ev => {
      if (!ev.ctrlKey && !ev.metaKey) return;   // 讓頁面自己捲
      ev.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(ev.deltaY < 0 ? 1.15 : 0.87, ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });

    return {
      svg,
      reset() { view = { x: 0, y: 0, s: 1 }; applyView(); highlight(-1); },
      /** 給頁面上的 +/− 按鈕用（不必記「按住 Ctrl 滾輪」） */
      zoomBy(factor) {
        const r = svg.getBoundingClientRect();
        zoomAt(factor, r.width / 2, r.height / 2);
      },
      focus(id) {
        const i = index.get(id);
        if (i != null) highlight(i);
      },
      /** 某個節點的鄰居（含連到它的那條邊的權重），給側欄用 */
      neighbors(id) {
        const i = index.get(id);
        if (i == null) return [];
        const out = [];
        edges.forEach(([a, b], j) => {
          if (a === i) out.push({ node: nodes[b], w: ew[j] });
          else if (b === i) out.push({ node: nodes[a], w: ew[j] });
        });
        return out.sort((p, q) => Math.abs(q.w) - Math.abs(p.w));
      },
      nodeOf(id) {
        const i = index.get(id);
        return i == null ? null : nodes[i];
      },
      /** 只留下某個分類（null = 全部） */
      /* 篩選分類時，**不只留下該分類**。
         整張圖 273 條邊裡有 26% 是跨分類的，那正是「這個名詞
         跟別的領域怎麼扯上關係」最值得看的部分——只留同類會把它
         全部藏掉，剩下幾個孤立的點，反而比不篩選還沒資訊。
         所以：本類實心、**直接鄰居淡顯**、其餘隱藏；
         只要有一端在本類的邊都留著。 */
      filter(group) {
        if (!group) {
          nodeEls.forEach(g => g.classList.remove('off', 'faint'));
          edgeEls.forEach(e => e.classList.remove('off', 'faint'));
          return;
        }
        const inG = nodes.map(n => n.group === group);
        nodeEls.forEach((g, i) => {
          const keep = inG[i] || [...nbr[i]].some(j => inG[j]);
          g.classList.toggle('off', !keep);
          g.classList.toggle('faint', keep && !inG[i]);
        });
        edges.forEach(([a, b], j) => {
          edgeEls[j].classList.toggle('off', !(inG[a] || inG[b]));
          edgeEls[j].classList.remove('faint');
        });
      },
      /* 一定要停掉漂移的 rAF。不停的話，每次換模式／換佈局都會多留
         一個迴圈在背景跑，操作幾次之後就有五六個迴圈同時 paint()
         已經被移除的 DOM——CPU 白燒，而且會越來越卡。 */
      destroy() {
        if (driftId) cancelAnimationFrame(driftId);
        driftId = null;
        box.innerHTML = '';
      },
    };
  }

  return { create };
})();
