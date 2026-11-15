// ==UserScript==
// @name         Xbox 家庭组内购送礼（网页版）
// @namespace    https://github.com/theslugger/xbox-family-gift
// @version      3.7.0
// @description  子号加购游戏/内购 → 子号发起 → 主号 family safety 批准 → 付款时换成内购。GM存储跨域共享 + unsafeWindow劫持页面真实请求
// @author       theslugger
// @match        https://www.xbox.com/*
// @match        https://www.microsoft.com/*
// @match        https://account.microsoft.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const KEY_GAME = 'xfg_idsGame';
  const KEY_IAP  = 'xfg_idsIAP';
  const KEY_LOCK = 'xfg_locked';
  const KEY_MARKET = 'xfg_targetMarket';   // 目标结算市场：AR / US / JP / ''=跟随订单
  const DEBUG = true;

  // ============================================================
  // 存储（GM_* 优先）
  // ============================================================
  const store = {
    get(k) {
      try { if (typeof GM_getValue === 'function') { const v = GM_getValue(k, ''); if (v) return JSON.parse(v); } } catch (e) {}
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; }
    },
    set(k, obj) {
      const s = JSON.stringify(obj);
      try { if (typeof GM_setValue === 'function') { GM_setValue(k, s); return; } } catch (e) {}
      try { localStorage.setItem(k, s); } catch (e) {}
    },
    del(k) {
      try { if (typeof GM_deleteValue === 'function') { GM_deleteValue(k); return; } } catch (e) {}
      try { localStorage.removeItem(k); } catch (e) {}
    }
  };

  // ============================================================
  // 通知
  // ============================================================
  function notify(title, sub, body) {
    try { if (typeof GM_notification === 'function') GM_notification({ title, text: [sub, body].filter(Boolean).join('\n'), timeout: 6000 }); } catch (e) {}
    toast(title, sub, body);
    panelAdd(title + ' ' + (sub || ''));
    refreshPanel();
    log('NOTIFY', title, sub, body);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function toast(title, sub, body) {
    try {
      if (!document.body) { setTimeout(() => toast(title, sub, body), 300); return; }
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:340px;padding:12px 14px;border-radius:10px;background:#107C10;color:#fff;font:13px/1.5 -apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);opacity:0;transition:opacity .2s';
      el.innerHTML = '<div style="font-weight:700;margin-bottom:4px">' + esc(title) + '</div>' +
        (sub ? '<div style="font-weight:600;word-break:break-all">' + esc(sub) + '</div>' : '') +
        (body ? '<div style="opacity:.85;margin-top:2px;word-break:break-all">' + esc(body) + '</div>' : '');
      document.documentElement.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = '1'; });
      setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 6000);
    } catch (e) {}
  }
  function log(...a) { if (DEBUG) console.log('%c[XFG]', 'color:#107C10;font-weight:700', ...a); }

  // ============================================================
  // 常驻面板（页面右下角，可折叠）：实时显示采集状态 + 最近事件
  // ============================================================
  var panelEl = null, logEl = null, bodyEl = null;
  var logLines = [];

  function panelAdd(msg) {
    logLines.push(new Date().toLocaleTimeString() + ' ' + msg);
    if (logLines.length > 30) logLines.shift();
    if (logEl) logEl.textContent = logLines.join('\n');
  }

  function buildPanel() {
    if (panelEl || !document.body) return;
    panelEl = document.createElement('div');
    panelEl.id = 'xfg-panel';
    panelEl.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;width:330px;' +
      'background:#0b0b0b;color:#eee;border:1px solid #107C10;border-radius:10px;' +
      'font:12px/1.45 -apple-system,Segoe UI,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden';

    panelEl.innerHTML =
      '<div id="xfg-hd" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#107C10;cursor:pointer">' +
        '<b>Xbox 送礼脚本</b><span style="font-size:10px;opacity:.8">' + location.host + '</span><span id="xfg-tg" style="margin-left:8px">收起</span>' +
      '</div>' +
      '<div id="xfg-bd" style="padding:10px">' +
        '<div id="xfg-state" style="margin-bottom:8px"></div>' +
        '<div id="xfg-log" style="max-height:160px;overflow:auto;background:#000;border-radius:6px;padding:6px;' +
          'font:11px/1.4 ui-monospace,Menlo,monospace;color:#9c9;white-space:pre-wrap"></div>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<button id="xfg-refresh" style="flex:1;padding:5px;background:#222;color:#eee;border:1px solid #444;border-radius:6px;cursor:pointer">刷新</button>' +
          '<button id="xfg-clear" style="flex:1;padding:5px;background:#3a1a1a;color:#f99;border:1px solid #633;border-radius:6px;cursor:pointer">清空</button>' +
          '<button id="xfg-test" style="flex:1;padding:5px;background:#1a2a3a;color:#9cf;border:1px solid #246;border-radius:6px;cursor:pointer">自检</button>' +
        '<button id="xfg-export" style="flex:1;padding:5px;background:#222;color:#ff0;border:1px solid #444;border-radius:6px;cursor:pointer">导出</button>' +
        '<button id="xfg-import" style="flex:1;padding:5px;background:#222;color:#0ff;border:1px solid #444;border-radius:6px;cursor:pointer">导入</button>' +
        '<button id="xfg-swap" style="flex:1;padding:5px;background:#2a1a3a;color:#c9f;border:1px solid #536;border-radius:6px;cursor:pointer">交换①②</button>' +
        '<button id="xfg-manual" style="flex:1;padding:5px;background:#2a2a1a;color:#ff9;border:1px solid #553;border-radius:6px;cursor:pointer">手动指定</button>' +
        '<button id="xfg-mkt" style="flex:1;padding:5px;background:#1a2a1a;color:#9f9;border:1px solid #365;border-radius:6px;cursor:pointer">市场</button>' +
        '</div>' +
      '</div>';
    document.documentElement.appendChild(panelEl);

    bodyEl = panelEl.querySelector('#xfg-bd');
    logEl = panelEl.querySelector('#xfg-log');
    var hd = panelEl.querySelector('#xfg-hd');
    var tg = panelEl.querySelector('#xfg-tg');
    hd.addEventListener('click', function () {
      var open = bodyEl.style.display !== 'none';
      bodyEl.style.display = open ? 'none' : '';
      tg.textContent = open ? '展开' : '收起';
    });
    panelEl.querySelector('#xfg-refresh').addEventListener('click', refreshPanel);
    panelEl.querySelector('#xfg-clear').addEventListener('click', function () {
      store.del(KEY_GAME); store.del(KEY_IAP); store.del(KEY_LOCK);
      logLines = []; refreshPanel(); panelAdd('已清空 idsGame/idsIAP');
    });
    panelEl.querySelector('#xfg-test').addEventListener('click', function () {
      handleCaptureItems([{ productId: 'TESTPROD0001', availabilityId: 'TESTAVAIL01', skuId: '0010' }]);
    });
    panelEl.querySelector('#xfg-export').addEventListener('click', function () {
      var txt = JSON.stringify({ game: store.get(KEY_GAME), iap: store.get(KEY_IAP) });
      try { navigator.clipboard.writeText(txt); } catch (e) {}
      prompt('已复制。到另一页面点【导入】粘贴：', txt);
    });
    panelEl.querySelector('#xfg-swap').addEventListener('click', function () {
      var g = store.get(KEY_GAME), t = store.get(KEY_IAP);
      if (!g || !t) { panelAdd('①② 需要都有值才能交换'); return; }
      store.set(KEY_GAME, t); store.set(KEY_IAP, g);
      panelAdd('已交换 ①游戏 ↔ ②内购');
      refreshPanel();
    });
    panelEl.querySelector('#xfg-manual').addEventListener('click', function () {
      var raw = prompt('手动指定【内购】，格式 productId/availabilityId/skuId（例：9N1Q2GBW6LP0/B21NVMHMJ32K/0010）：');
      if (!raw) return;
      var parts = raw.split('/');
      if (parts.length < 2) { panelAdd('格式错误，需要 productId/availabilityId[/skuId]'); return; }
      var obj = { productId: parts[0].trim(), availabilityId: parts[1].trim(), skuId: (parts[2] || '0010').trim() };
      store.set(KEY_IAP, obj);
      panelAdd('已手动指定内购: ' + obj.productId + ' / ' + obj.availabilityId);
      refreshPanel();
    });
    panelEl.querySelector('#xfg-mkt').addEventListener('click', function () {
      var cur = String(store.get(KEY_MARKET) || '') || '跟随订单';
      var raw = prompt(
        '目标结算市场（两字母代码，留空=跟随订单）：\n' +
        '当前：' + cur + '\n\n' +
        '常用：AR 阿根廷 / US 美国 / JP 日本 / TR 土耳其 / NG 尼日利亚\n\n' +
        '注意：主号账单地区必须与该市场一致，否则下单会被拒。',
        store.get(KEY_MARKET) || ''
      );
      if (raw === null) return;
      raw = raw.trim().toUpperCase();
      if (!raw) { store.del(KEY_MARKET); panelAdd('目标市场：跟随订单'); }
      else { store.set(KEY_MARKET, raw); panelAdd('目标市场已设为 ' + raw + '（订单/付款页都会用这个市场）'); }
      refreshPanel();
    });
    panelEl.querySelector('#xfg-import').addEventListener('click', function () {
      var raw = prompt('粘贴导出的 JSON：');
      if (!raw) return;
      try {
        var o = JSON.parse(raw);
        if (o.game) store.set(KEY_GAME, o.game);
        if (o.iap) store.set(KEY_IAP, o.iap);
        if (o.game && o.iap) store.set(KEY_LOCK, true);
        refreshPanel(); panelAdd('已导入 ID');
      } catch (e) { panelAdd('导入失败: JSON 格式错误'); }
    });
    refreshPanel();
    panelAdd('脚本已注入页面世界(@grant none)');
  }

  function refreshPanel() {
    if (!panelEl) return;
    var st = panelEl.querySelector('#xfg-state');
    if (!st) return;
    var g = store.get(KEY_GAME), t = store.get(KEY_IAP), lk = store.get(KEY_LOCK);
    st.innerHTML =
      '<div>① 游戏: <b style="color:#7fd">' + (g ? g.productId + '<br><span style="color:#888">avail ' + g.availabilityId + ' sku ' + g.skuId + (g.market ? ' · market ' + g.market : '') + '</span>' : '<span style="color:#f77">未采集</span>') + '</b></div>' +
      '<div style="margin-top:4px">② 内购: <b style="color:#7fd">' + (t ? t.productId + '<br><span style="color:#888">avail ' + t.availabilityId + ' sku ' + t.skuId + (t.market ? ' · market ' + t.market : '') + '</span>' : '<span style="color:#f77">未采集</span>') + '</b></div>' +
      '<div style="margin-top:4px">状态: ' + (lk ? '<b style="color:#ff0">🔒 已锁定</b>' : '<span style="color:#888">采集中</span>') + '</div>';
  }


  // ============================================================
  // 采集
  // ============================================================
  function collectItems(bodyStr) {
    let o; try { o = JSON.parse(bodyStr); } catch (e) { return []; }
    if (!o) return [];
    var mk = o.market || '', lc = o.locale || '';
    let arr = null;
    if (o.itemsToAdd && Array.isArray(o.itemsToAdd.items)) arr = o.itemsToAdd.items;
    else if (Array.isArray(o.items)) arr = o.items;
    else if (Array.isArray(o.lineItems)) arr = o.lineItems;
    if (!arr) return [];
    const out = [];
    for (const it of arr) {
      const pid = it && (it.productId || it.ProductId);
      const sid = it && (it.skuId || it.SkuId);
      const aid = it && (it.availabilityId || it.AvailabilityId || '');
      if (pid && sid) out.push({ productId: pid, availabilityId: aid, skuId: sid, market: mk, locale: lc });
    }
    return out;
  }
  function fullId(a) { return !!(a && a.productId && a.availabilityId && a.skuId); }
  function sameProduct(a, b) { return !!(a && b && a.productId === b.productId); }

  function handleCapture(bodyStr) {
    const items = collectItems(bodyStr);
    log('handleCapture items=', items);
    handleCaptureItems(items);
  }

  /**
   * 与 Surge 版 script.js 语义对齐：
   *   Surge 取请求体 itemsToAdd.items[0] —— 即"本次加购的那一个商品"
   *   网页版：
   *     - 优先用请求体 itemsToAdd.items[0]（source='request'）
   *     - 退而用响应体 lineItems，但仅当【只有 1 个商品】时才认为是本次加购（source='response'）
   *     - 多个商品时不猜顺序，避免把游戏错记成内购
   */
  function handleCaptureItems(items, source) {
    if (!items || !items.length) return;

    if (source === 'response' && items.length > 1) {
      // 多商品购物车：不猜，只做命中提示
      var g0 = store.get(KEY_GAME), t0 = store.get(KEY_IAP);
      for (var k = 0; k < items.length; k++) {
        var it0 = items[k];
        if (g0 && sameProduct(g0, it0)) panelAdd('命中①游戏 ' + it0.productId);
        else if (t0 && sameProduct(t0, it0)) panelAdd('命中②内购 ' + it0.productId);
      }
      refreshPanel();
      return;
    }

    let game = store.get(KEY_GAME), iap = store.get(KEY_IAP);
    const locked = store.get(KEY_LOCK);

    if (locked && game && iap) {
      for (const ids of items) {
        if (sameProduct(game, ids)) notify('①【游戏】命中(已锁定)', ids.productId, '不覆盖');
        else if (sameProduct(iap, ids)) notify('②【内购】命中(已锁定)', ids.productId, '不覆盖');
      }
      return;
    }
    for (const ids of items) {
      if (game && sameProduct(game, ids)) {
        if (!fullId(game) || game.availabilityId !== ids.availabilityId || game.skuId !== ids.skuId) {
          store.set(KEY_GAME, ids); game = ids;
          notify('①【游戏】ID已更新', ids.productId, 'avail:' + ids.availabilityId + ' sku:' + ids.skuId);
        } else notify('①【游戏】命中', ids.productId, 'avail:' + ids.availabilityId);
        continue;
      }
      if (iap && sameProduct(iap, ids)) {
        if (!fullId(iap) || iap.availabilityId !== ids.availabilityId || iap.skuId !== ids.skuId) {
          store.set(KEY_IAP, ids); iap = ids;
          notify('②【内购】ID已更新', ids.productId, 'avail:' + ids.availabilityId + ' sku:' + ids.skuId);
        } else notify('②【内购】命中', ids.productId, 'avail:' + ids.availabilityId);
        continue;
      }
      if (!game) {
        store.set(KEY_GAME, ids); game = ids;
        notify('①【游戏】已记录', ids.productId, 'avail:' + ids.availabilityId + ' sku:' + ids.skuId);
      } else if (!iap) {
        store.set(KEY_IAP, ids); iap = ids;
        notify('②【内购】已记录', ids.productId, 'avail:' + ids.availabilityId + ' sku:' + ids.skuId);
      }
    }
    if (game && iap && fullId(game) && fullId(iap)) {
      store.set(KEY_LOCK, true);
      notify('🔒 已锁定采集结果', '游戏+内购齐备', '付款时将自动替换为内购');
    }
  }

  // ============================================================
  // 替换
  // ============================================================
  function swapOne(obj, g, t) {
    if (!(t.productId && t.availabilityId)) return 0;
    if (obj.productId !== g.productId) return 0;
    obj.productId = t.productId;
    if (obj.availabilityId !== undefined) obj.availabilityId = t.availabilityId;
    if (obj.skuId !== undefined && t.skuId) obj.skuId = t.skuId;
    return 1;
  }
  // availabilityId 是按市场分配的；已知映射用于兜底反查
  // availabilityId 按市场分配；同一 productId+skuId 在不同市场有不同 availabilityId
  var AVAIL_BY_MARKET = {
    '9P6LX2D15SD7': {
      'US': '9XPHQG4220WG',
      'AR': 'B2XRTR8KPHPM',
      'JP': '9XJRWRN87FRX'
    }
  };
  var AVAIL_MARKET = {
    'B2XRTR8KPHPM': 'AR', 'B26TLGNG62BG': 'AR',
    '9XPHQG4220WG': 'US', '9N3TNRFCDFGJ': 'US',
    '9XJRWRN87FRX': 'JP', '9V7LMZ5BPBXJ': 'JP'
  };
  function marketOfAvail(aid) { return AVAIL_MARKET[String(aid).toUpperCase()] || ''; }
  // 把 availabilityId 归一到订单所属市场，避免跨市场 404
  function alignAvail(t, orderMarket) {
    if (!t || !t.productId || !orderMarket) return t;
    var m = AVAIL_BY_MARKET[String(t.productId).toUpperCase()];
    if (!m) return t;
    var want = m[String(orderMarket).toUpperCase()];
    if (!want || want === t.availabilityId) return t;
    var out = { productId: t.productId, availabilityId: want, skuId: t.skuId, market: orderMarket };
    log('availabilityId 按市场归一: ' + t.availabilityId + ' -> ' + want + ' (' + orderMarket + ')');
    return out;
  }

  function swapOrdersJson(bodyStr, g, t) {
    let o; try { o = JSON.parse(bodyStr); } catch (e) { return null; }
    let n = 0;
    // 市场必须与内购 ID 所属市场一致，否则 DisplayCatalog 404
    // 优先：保持订单原 market，把内购 availabilityId 换成该市场对应的值
    // 目标市场优先（面板/菜单设定），否则跟随订单
    var tgt = String(store.get(KEY_MARKET) || '').toUpperCase();
    var orderMk = tgt || (o.market || '').toUpperCase();
    if (orderMk) t = alignAvail(t, orderMk);
    if (tgt && o.market && o.market.toUpperCase() !== tgt) {
      log('订单市场强制 ' + o.market + ' -> ' + tgt);
      o.market = tgt;
      n++;
    }
    var mk = (t && t.market) ? String(t.market).toUpperCase() : '';
    if (!mk && t && t.availabilityId) mk = marketOfAvail(t.availabilityId) || '';
    if (mk && o.market && o.market.toUpperCase() !== mk) {
      o.market = mk;
      n++;
    }
    var lc = (t && t.locale) ? String(t.locale) : '';
    if (lc && o.language && /^[a-z]{2}-[a-z]{2}$/i.test(lc) && o.language.toLowerCase() !== lc.toLowerCase()) {
      o.language = lc;
      n++;
    }
    (function walk(x) {
      if (x === null || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (x.productId === g.productId) n += swapOne(x, g, t);
      for (const k in x) if (Object.prototype.hasOwnProperty.call(x, k)) walk(x[k]);
    })(o);
    return n > 0 ? { body: JSON.stringify(o), n } : null;
  }
  function unq(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function qq(s) { return encodeURIComponent(s); }
  function swapBuynowForm(bodyStr, g, t) {
    const d = {};
    bodyStr.split('&').forEach(p => { const i = p.indexOf('='); if (i < 0) return; d[unq(p.slice(0, i))] = p.slice(i + 1); });
    const caller = d['callerApplicationId'] ? unq(d['callerApplicationId']) : '';
    const scen = d['scenario'] ? unq(d['scenario']) : '';
    // 实测值可能是 AMCFamilySafetyApp / AMCFamilySafetyWeb，统一按前缀匹配
    const isFamilySafety = /^AMCFamilySafety/i.test(caller) || scen === 'parentApproval';
    if (!isFamilySafety) return null;
    if (d['products'] === undefined) return null;
    let arr; try { arr = JSON.parse(unq(d['products'])); } catch (e) { return null; }
    if (!Array.isArray(arr)) return null;
    // buynow 的 market 参数决定目录查询市场；内购 availabilityId 需与之对齐
    const tgt = String(store.get(KEY_MARKET) || '').toUpperCase();
    const formMarket = tgt || (d['market'] ? unq(d['market']).toUpperCase() : '');
    let tt = t;
    if (formMarket && t && t.productId) tt = alignAvail(t, formMarket);
    let cn = 0; arr.forEach(it => { cn += swapOne(it, g, tt); });
    if (!cn) return null;
    const parts = bodyStr.split('&').map(p => {
      const i = p.indexOf('='); if (i < 0) return p;
      const k = unq(p.slice(0, i));
      if (k === 'products') return p.slice(0, i) + '=' + qq(JSON.stringify(arr));
      if (k === 'market' && tgt) return p.slice(0, i) + '=' + qq(tgt);
      return p;
    });
    return { body: parts.join('&'), n: cn };
  }
  function maybeSwap(url, bodyStr) {
    if (typeof bodyStr !== 'string' || !bodyStr) return null;
    const g = store.get(KEY_GAME), t = store.get(KEY_IAP);
    if (!g || !t) return null;
    if (!t.availabilityId) { log('内购缺 availabilityId，跳过替换防404'); return null; }
    if (/purchase\.md\.mp\.microsoft\.com\/v\d+\.\d+\/users\/me\/orders/.test(url)) {
      const r = swapOrdersJson(bodyStr, g, t);
      if (r) { notify('✅ 订单已换内购', t.productId, '字段:' + r.n); return r.body; }
      return null;
    }
    if (/www\.microsoft\.com\/store\/purchase\/buynowui\/buynow/.test(url)) {
      const r = swapBuynowForm(bodyStr, g, t);
      if (r) { notify('✅ safety购买页已换内购', t.productId + ' · sku ' + t.skuId, '字段:' + r.n); return r.body; }
      return null;
    }
    return null;
  }

  // ============================================================
  // 统一请求处理：支持 fetch(Request) / 字符串 body / 非字符串
  // ============================================================
  const RE_CAPTURE = /cart\.production\.store-web\.dynamics\.com\/.*\/cart\/(loadCart|addItems|add)/;
  const RE_SWAP = /(purchase\.md\.mp\.microsoft\.com\/v\d+\.\d+\/users\/me\/orders|www\.microsoft\.com\/store\/purchase\/buynowui\/buynow)/;

  // 从 Request 对象读 body（克隆避免消费原请求）
  function readRequestBody(input) {
    try {
      if (input && typeof input.clone === 'function' && typeof input.text === 'function') {
        return input.clone().text();
      }
    } catch (e) {}
    return Promise.resolve(null);
  }

  // ============================================================
  // 从【响应体】采集（最可靠：loadCart 响应里就带完整 lineItems）
  // ============================================================
  // 从网址/页面路径推断市场（如 /es-ar/ -> es-AR, /en-us/ -> en-US）
  function inferMarket() {
    try {
      var m = (location.pathname || '').match(/^\/([a-z]{2})-([a-z]{2})\//i);
      if (m) return { market: (m[1] + '-' + m[2]).toUpperCase().replace('-', '-'), locale: m[1].toLowerCase() + '-' + m[2].toUpperCase() };
    } catch (e) {}
    return null;
  }

  function captureFromResponse(url, text) {
    if (!text) return;
    if (!/cart\.production\.store-web\.dynamics\.com\/.*\/cart\/loadCart/i.test(url)) return;
    let o;
    try { o = JSON.parse(text); } catch (e) { return; }
    if (!o) return;
    const cart = o.cart;
    if (!cart) return;
    const arr = cart.lineItems || [];
    if (!arr.length) return;
    const items = [];
    for (const it of arr) {
      const pid = it && it.productId;
      const sid = it && it.skuId;
      const aid = it && (it.availabilityId || "");
      if (pid && sid && aid) items.push({ productId: pid, availabilityId: aid, skuId: sid });
    }
    if (!items.length) return;
    var im = inferMarket();
    if (im) {
      for (var q = 0; q < items.length; q++) {
        if (!items[q].market) items[q].market = im.market;
        if (!items[q].locale) items[q].locale = im.locale;
      }
    }
    log('响应采集 items=', items);
    handleCaptureItems(items, 'response');
  }

  // 把 handleCapture 拆出可复用的 items 版本
  // ============================================================
  const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const origFetch = PAGE.fetch;
  if (origFetch) {
    PAGE.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const isCap = RE_CAPTURE.test(url);
      const isSwap = RE_SWAP.test(url);

      // 先做请求侧替换
      let args = arguments;
      if (isSwap) {
        const bodyStr = init && typeof init.body === "string" ? init.body : null;
        if (bodyStr) {
          try {
            const nb = maybeSwap(url, bodyStr);
            if (nb) args = [input, Object.assign({}, init, { body: nb })];
          } catch (e) { log("swap sync err", e); }
        }
      }

      const p = origFetch.apply(this, args);
      if (isCap) {
        p.then(resp => {
          try { resp.clone().text().then(t => captureFromResponse(url, t)).catch(() => {}); } catch (e) {}
        }).catch(() => {});
      }
      return p;
    };
  }

  // ============================================================
  // XHR hook（请求替换 + 响应采集）
  // ============================================================
  const XHR = PAGE.XMLHttpRequest;
  if (XHR) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try { this.__xfgUrl = String(url); } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const url = this.__xfgUrl || "";
      try {
        if (typeof body === "string" && RE_SWAP.test(url)) {
          const nb = maybeSwap(url, body);
          if (nb) body = nb;
        }
      } catch (e) { log("xhr swap err", e); }
      if (RE_CAPTURE.test(url)) {
        const xhr = this;
        xhr.addEventListener("load", function () {
          try {
            const rt = xhr.responseType;
            let text = null;
            if (rt === "" || rt === "text") text = xhr.responseText;
            else if (rt === "json") text = JSON.stringify(xhr.response);
            captureFromResponse(url, text);
          } catch (e) {}
        });
      }
      return origSend.call(this, body);
    };
  }


  // ============================================================
  // 表单提交 hook —— buynow 是 <form target=iframe> 的 document 级 POST，
  // fetch/XHR 都拦不到，必须在 submit 前改写 products 字段
  // HAR 证据：_resourceType=document, sec-fetch-dest=iframe, accel 由主页面表单发起
  // ============================================================
  function isBuynowAction(act) {
    return /\/store\/purchase\/buynowui\/buynow/i.test(String(act || ''));
  }

  // 从 form 里读出所有字段，重组 body，替换 products 后写回
  function patchBuynowForm(form) {
    try {
      if (!form || !isBuynowAction(form.action)) return 0;
      const g = store.get(KEY_GAME), t = store.get(KEY_IAP);
      if (!g || !t || !t.productId || !t.availabilityId) return 0;

      // 找 products 输入框
      let inp = null;
      for (let i = 0; i < form.elements.length; i++) {
        const el = form.elements[i];
        if (el && el.name === 'products') { inp = el; break; }
      }
      if (!inp) return 0;

      // 取 market 字段做 availabilityId 对齐
      let mk = '';
      for (let i = 0; i < form.elements.length; i++) {
        const el = form.elements[i];
        if (el && el.name === 'market') { mk = String(el.value || '').toUpperCase(); break; }
      }
      const tgt = String(store.get(KEY_MARKET) || '').toUpperCase();
      if (tgt) mk = tgt;
      let tt = t;
      if (mk) tt = alignAvail(t, mk);

      let arr;
      try { arr = JSON.parse(inp.value); } catch (e) { return 0; }
      if (!Array.isArray(arr)) return 0;
      let n = 0;
      arr.forEach(it => { n += swapOne(it, g, tt); });
      if (!n) return 0;

      inp.value = JSON.stringify(arr);
      if (tgt) {
        for (let i = 0; i < form.elements.length; i++) {
          const el = form.elements[i];
          if (el && el.name === 'market') el.value = tgt;
        }
        try {
          if (form.action) form.action = form.action.replace(/([?&]market=)[A-Za-z-]+/, '$1' + tgt);
        } catch (e) {}
      }
      log('✅ buynow 表单已改写 market=' + (mk || '?'), arr);
      notify('✅ safety付款页已换内购', tt.productId + ' · sku ' + tt.skuId, 'market ' + (mk || '?'));
      return n;
    } catch (e) { log('patchBuynowForm err', e); return 0; }
  }

  // 兜底：所有 form 在 submit / requestSubmit 前统一检查
  const HForm = PAGE.HTMLFormElement;
  if (HForm && HForm.prototype) {
    const origSubmit = HForm.prototype.submit;
    HForm.prototype.submit = function () {
      try { patchBuynowForm(this); } catch (e) {}
      return origSubmit.apply(this, arguments);
    };
    if (HForm.prototype.requestSubmit) {
      const origRS = HForm.prototype.requestSubmit;
      HForm.prototype.requestSubmit = function () {
        try { patchBuynowForm(this); } catch (e) {}
        return origRS.apply(this, arguments);
      };
    }
  }

  // 兜底 2：监听 submit 事件（捕获阶段），覆盖 el.submit() 之外的所有路径
  try {
    PAGE.addEventListener('submit', function (ev) {
      try { patchBuynowForm(ev.target); } catch (e) {}
    }, true);
  } catch (e) {}

  // 兜底 3：定时巡检 —— 主页面可能直接 .submit() 而不触发 submit 事件
  // 同时处理「iframe 已存在但表单还没填好」的时序
  setInterval(function () {
    try {
      const forms = PAGE.document ? PAGE.document.querySelectorAll('form') : [];
      for (let i = 0; i < forms.length; i++) patchBuynowForm(forms[i]);
    } catch (e) {}
  }, 1500);

  // ============================================================
  // 菜单
  // ============================================================
  try {
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("查看已采集 ID", () => {
        const g = store.get(KEY_GAME), t = store.get(KEY_IAP);
        notify("已采集", "游戏: " + (g ? g.productId + " / " + g.availabilityId : "无"), "内购: " + (t ? t.productId + " / " + t.availabilityId : "无"));
      });
      GM_registerMenuCommand("清空已采集 ID", () => {
        store.del(KEY_GAME); store.del(KEY_IAP); store.del(KEY_LOCK);
        notify("已清空", "已重置", "请重新加购");
      });
      GM_registerMenuCommand("导出 ID", () => {
        const txt = JSON.stringify({ game: store.get(KEY_GAME), iap: store.get(KEY_IAP) });
        try { navigator.clipboard.writeText(txt); } catch (e) {}
        prompt("已尝试复制：", txt);
      });
      GM_registerMenuCommand("导入 ID", () => {
        const raw = prompt("粘贴 JSON："); if (!raw) return;
        try {
          const o = JSON.parse(raw);
          if (o.game) store.set(KEY_GAME, o.game);
          if (o.iap) store.set(KEY_IAP, o.iap);
          if (o.game && o.iap) store.set(KEY_LOCK, true);
          notify("已导入", "游戏: " + (o.game && o.game.productId), "内购: " + (o.iap && o.iap.productId));
        } catch (e) { notify("导入失败", "JSON 不对", ""); }
      });
      GM_registerMenuCommand("设置目标市场", () => {
        var raw = prompt("目标结算市场（AR/US/JP/TR/NG，留空=跟随订单）：", store.get(KEY_MARKET) || "");
        if (raw === null) return;
        raw = raw.trim().toUpperCase();
        if (!raw) { store.del(KEY_MARKET); notify("目标市场", "跟随订单", ""); }
        else { store.set(KEY_MARKET, raw); notify("目标市场", raw, "订单与付款页统一用此市场"); }
      });
      GM_registerMenuCommand("解除锁定", () => { store.del(KEY_LOCK); notify("已解除锁定", "可重新采集", ""); });
      GM_registerMenuCommand("测试采集(自检)", () => {
        handleCaptureItems([{ productId: "TESTPROD0001", availabilityId: "TESTAVAIL01", skuId: "0010" }]);
        notify("自检完成", "若看到①②弹窗说明采集正常", "记得清空");
      });
    }
  } catch (e) {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    setTimeout(buildPanel, 0);
  }

  log("v3.0 injected (page world)");
})();
