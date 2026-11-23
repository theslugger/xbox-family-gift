// ==UserScript==
// @name         Xbox 家庭组代付 → 送礼取码
// @namespace    https://github.com/theslugger/xbox-family-gift
// @version      1.0.0
// @description  子号发起购买，主号批准后自动转为 GIFt 订单，产物为可兑换的数字码
// @author       theslugger
// @updateURL    https://raw.githubusercontent.com/theslugger/xbox-family-gift/main/web/xbox-gift-code.user.js
// @downloadURL  https://raw.githubusercontent.com/theslugger/xbox-family-gift/main/web/xbox-gift-code.user.js
// @match        https://www.xbox.com/*
// @match        https://www.microsoft.com/*
// @match        https://account.microsoft.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      xbox.aappe.uk
// @connect      buynow.production.store-web.dynamics.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 常量
  // ============================================================
  const SERVER = 'https://xbox.aappe.uk';
  const K_GAME = 'xg_game';
  const K_IAP = 'xg_iap';
  const K_CODE = 'xg_code';
  const K_PLAN = 'xg_plan';
  const K_GIFT = 'xg_giftCfg';
  const K_DONE = 'xg_done';
  const K_LOG = 'xg_log';
  const DEBUG = true;

  // ============================================================
  // 存储（GM 优先，双写双删）
  // ============================================================
  const store = {
    _gm() { return typeof GM_setValue === 'function' && typeof GM_getValue === 'function'; },
    get(k) {
      if (this._gm()) {
        try { const v = GM_getValue(k, ''); if (v) return JSON.parse(v); } catch (e) {}
      }
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; }
    },
    set(k, v) {
      const s = JSON.stringify(v);
      if (this._gm()) { try { GM_setValue(k, s); } catch (e) {} }
      try { localStorage.setItem(k, s); } catch (e) {}
    },
    del(k) {
      if (this._gm() && typeof GM_deleteValue === 'function') { try { GM_deleteValue(k); } catch (e) {} }
      try { localStorage.removeItem(k); } catch (e) {}
      try { sessionStorage.removeItem(k); } catch (e) {}
    }
  };

  // ============================================================
  // 日志与面板
  // ============================================================
  var logs = [];
  function log() {
    if (!DEBUG) return;
    console.log('%c[XGC]', 'color:#107C10;font-weight:700', ...arguments);
  }
  function addLog(m) {
    var line = new Date().toLocaleTimeString() + ' ' + m;
    logs.push(line);
    if (logs.length > 60) logs.shift();
    var el = document.querySelector('#xgc-log');
    if (el) el.textContent = logs.join('\n');
    store.set(K_LOG, logs);
  }
  function restoreLogs() {
    var v = store.get(K_LOG);
    if (Array.isArray(v)) logs = v.slice(-60);
  }

  function toast(title, sub, body) {
    try {
      if (!document.body) { setTimeout(function () { toast(title, sub, body); }, 300); return; }
      var el = document.createElement('div');
      el.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:360px;' +
        'padding:12px 14px;border-radius:10px;background:#107C10;color:#fff;' +
        'font:13px/1.5 -apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);' +
        'opacity:0;transition:opacity .2s';
      el.innerHTML = '<div style="font-weight:700;margin-bottom:3px">' + esc(title) + '</div>' +
        (sub ? '<div style="font-weight:600;word-break:break-all">' + esc(sub) + '</div>' : '') +
        (body ? '<div style="opacity:.85;margin-top:2px;word-break:break-all">' + esc(body) + '</div>' : '');
      document.documentElement.appendChild(el);
      requestAnimationFrame(function () { el.style.opacity = '1'; });
      setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 300); }, 6000);
    } catch (e) {}
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // ============================================================
  // 角色识别
  //   子号：www.xbox.com       （加购、发起）
  //   主号：account.microsoft.com（批准）
  //   付款：www.microsoft.com   （gift 改造在这里）
  // ============================================================
  function role() {
    var h = location.hostname;
    if (h === 'account.microsoft.com') return 'parent';
    if (h === 'www.xbox.com' || h === 'xbox.com') return 'child';
    if (h === 'www.microsoft.com') return 'pay';
    return 'other';
  }
  function isPayUrl() {
    return /\/store\/purchase\/buynowui\/buynow/i.test(location.href);
  }

  // ============================================================
  // 授权
  // ============================================================
  var licState = { valid: false, remaining: 0, reason: '' };

  function lic() {
    var v = store.get(K_CODE);
    return v && typeof v === 'object' && v.code ? v : null;
  }
  function setLic(code) {
    store.set(K_CODE, { code: String(code || '').toUpperCase().trim(), at: Date.now() });
    store.del(K_PLAN);
  }

  async function checkLic() {
    var l = lic();
    if (!l) return { ok: false, error: '未设置授权码' };
    try {
      var r = await fetch(SERVER + '/api/license/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ code: l.code })
      });
      var j = await r.json();
      if (!j.ok) return { ok: false, error: j.error || '无效', reason: j.reason };
      licState = { valid: true, remaining: j.data.remaining, reason: '' };
      return { ok: true, remaining: j.data.remaining, total: j.data.total };
    } catch (e) {
      return { ok: false, error: '无法连接服务端: ' + e.message };
    }
  }

  async function consumeOnce() {
    var l = lic();
    if (!l) { addLog('❌ 未设置授权码，跳过扣次'); return; }
    try {
      var r = await fetch(SERVER + '/api/license/consume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ code: l.code, market: market(), iap: (store.get(K_IAP) || {}).productId || '' })
      });
      var j = await r.json();
      if (!j.ok) { addLog('❌ 扣次失败: ' + (j.error || '?')); return; }
      licState.valid = true;
      licState.remaining = j.data.remaining;
      addLog('💰 已扣 1 次，剩余 ' + j.data.remaining + ' 次');
      refresh();
    } catch (e) { addLog('❌ 扣次异常: ' + e.message); }
  }

  // ============================================================
  // 市场与会话参数（从 buynow 页面抓）
  // ============================================================
  function market() {
    var t = store.get(K_IAP);
    if (t && t.market) return String(t.market).toUpperCase().slice(0, 2);
    var m = (location.pathname || '').match(/\/([a-z]{2})-([a-z]{2})(\/|$)/i);
    if (m) return (m[1] + m[2]).toUpperCase().slice(0, 2);
    return 'US';
  }
  function localeOf() {
    var mk = market();
    var map = { AR: 'es-ar', US: 'en-us', TR: 'tr-tr', BR: 'pt-br', MX: 'es-mx', JP: 'ja-jp' };
    var m = (location.pathname || '').match(/\/([a-z]{2})-([a-z]{2})(\/|$)/i);
    if (m) return m[1].toLowerCase() + '-' + m[2].toUpperCase();
    return map[mk] || 'en-us';
  }

  /**
   * 从 buynow 页面的 __STORE_CART_STATE__.appContext 提取全部参数
   * 这是 gift 改造的基础：riskId / cV / xToken / flights 都在这里
   */
  function pageCtx() {
    try {
      var P = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
      var st = P.__STORE_CART_STATE__;
      if (!st) return null;
      var ac = st.appContext || {};
      return {
        riskId: ac.riskId || '',
        cV: ac.cV || ac.cv || '',
        xToken: ac.xToken || '',
        flights: Array.isArray(ac.flights) ? ac.flights : [],
        market: ac.market || market(),
        locale: ac.locale || localeOf(),
        callerApplicationId: ac.callerApplicationId || 'XboxCom',
        cssOverride: ac.cssOverride || 'XboxCom2NewUI',
        parentHostName: ac.parentHostName || 'www.xbox.com',
        sdkVersion: ac.sdkVersion || '5.10.6',
        campaignId: ac.campaignId || '',
        MSCC: ac.MSCC || null,
        GPC: ac.GPC_DataSharingOptIn,
        clientType: ac.clientType || 'XboxCom',
        urlRef: ac.urlRef || '',
        theme: ac.theme || 'light',
        layout: ac.layout || 'Modal',
        pageFormat: ac.pageFormat || 'full',
        raw: st
      };
    } catch (e) {
      log('pageCtx err', e);
      return null;
    }
  }

  // ============================================================
  // 服务端 plan（替换目标 + 数量）
  // ============================================================
  var planPending = null;

  function fetchPlan(force) {
    var g = store.get(K_GAME), t = store.get(K_IAP), l = lic();
    if (!g || !t || !g.productId || !t.productId || !l) {
      addLog('⚠️ plan 未请求：缺少 ①② 或授权码');
      return Promise.resolve(null);
    }
    if (!force) {
      var hit = store.get(K_PLAN);
      if (hit && hit.ops && Date.now() - (hit.at || 0) < (hit.ttl || 600) * 1000) return Promise.resolve(hit);
    }
    if (planPending) return planPending;

    var mk = market();
    var cfg = store.get(K_GIFT) || {};
    addLog('[plan] 请求 市场=' + mk + ' ①=' + g.productId + ' ②=' + t.productId);
    if (cfg.qty) addLog('[plan] 数量=' + cfg.qty);

    planPending = fetch(SERVER + '/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({
        code: l.code,
        market: mk,
        game: { productId: String(g.productId).toUpperCase(), skuId: String(g.skuId || '0010') },
        iap: { productId: String(t.productId).toUpperCase(), skuId: String(t.skuId || '0010') }
      })
    })
      .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (o) {
        planPending = null;
        if (!o.j || !o.j.ok) {
          var msg = (o.j && o.j.error) || ('HTTP ' + o.s);
          addLog('❌ plan 获取失败: ' + msg);
          return null;
        }
        var e = { ops: o.j.ops || [], meta: o.j.meta || {}, ttl: o.j.ttl || 600, at: Date.now() };
        store.set(K_PLAN, e);
        var iap = (e.meta && e.meta.iap) || {};
        addLog('✅ 目标 ' + iap.productId + '/' + iap.availabilityId +
               (iap.title ? ' · ' + iap.title : '') +
               (iap.price ? ' · ' + iap.price + ' ' + (iap.currency || '') : ''));
        refresh();
        return e;
      })
      .catch(function (e) { planPending = null; addLog('❌ plan 异常: ' + e.message); return null; });

    return planPending;
  }

  function planTarget() {
    var p = store.get(K_PLAN);
    if (!p || !Array.isArray(p.ops)) return null;
    var hit = p.ops.filter(function (o) { return o.scope === 'buynow'; });
    if (!hit.length) hit = p.ops.filter(function (o) { return o.scope === 'orders'; });
    if (!hit.length) return null;
    var exact = hit.filter(function (o) { return o.match !== '*'; });
    var set = (exact[0] || hit[0]).set;
    if (!set || !set.productId || !set.availabilityId) return null;
    return {
      productId: String(set.productId).toUpperCase(),
      availabilityId: String(set.availabilityId).toUpperCase(),
      skuId: String(set.skuId || '0010')
    };
  }

  // ============================================================
  // 【核心】gift 改造
  // ------------------------------------------------------------
  // 主号批准后，付款页是 parentApproval 链路，cart 里没有 giftee。
  // 需要：
  //   1. 用页面 appContext 自己发一次 PrepareCheckout
  //      带上 isGift / giftee / itemsToAdd（目标商品 + 数量）
  //   2. 拿到新 cart.id
  //   3. 让 buynow 用新 cart（通过 turn 请求）
  // ============================================================
  var giftState = { cartId: '', recipientId: '', at: 0, ok: false };

  function giftCfg() {
    var c = store.get(K_GIFT) || {};
    return {
      email: c.email || '',
      sender: c.sender || '',
      qty: Math.max(1, Math.min(10, parseInt(c.qty, 10) || 1)),
      enabled: !!c.enabled
    };
  }

  /** 构造 PrepareCheckout 的请求体 */
  function buildPrepareBody(ctx, target, cfg) {
    var items = [];
    items.push({
      productId: target.productId,
      skuId: target.skuId || '0010',
      availabilityId: target.availabilityId,
      quantity: cfg.qty || 1
    });

    var body = {
      friendlyName: null,
      market: ctx.market,
      locale: ctx.locale,
      catalogClientType: '',
      riskSessionId: ctx.riskId,
      testScenarios: 'None',
      callerApplicationId: '_CONVERGED_XboxCom',
      clientContext: { client: 'XboxCom', deviceFamily: 'Web' },
      refreshPrimaryPaymentOption: false,
      flights: ctx.flights,
      isBuyNow: true,
      isGift: true,
      buyNowScenario: 'gift',
      giftee: {
        gifteeEmail: cfg.email,
        gifteeSenderName: cfg.sender || 'Gift',
        gifteeType: 'email',
        gifteeGamertag: ''
      },
      itemsToAdd: { items: items }
    };

    // 有 campaignId 就带上
    if (ctx.campaignId) items[0].campaignId = ctx.campaignId;

    return body;
  }

  /** 发 PrepareCheckout，拿到新 cart */
  async function prepareGiftCart() {
    var ctx = pageCtx();
    if (!ctx) {
      addLog('❌ 无法读取页面 context（__STORE_CART_STATE__ 不存在）');
      return null;
    }
    if (!ctx.riskId || !ctx.xToken) {
      addLog('❌ 缺少 riskId 或 xToken，无法构造请求');
      return null;
    }

    var target = planTarget();
    if (!target) { addLog('❌ 没有替换目标，先获取 plan'); return null; }

    var cfg = giftCfg();
    if (!cfg.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cfg.email)) {
      addLog('❌ 收码邮箱无效: ' + (cfg.email || '(空)'));
      return null;
    }

    var body = buildPrepareBody(ctx, target, cfg);
    addLog('[gift] PrepareCheckout → ' + target.productId + ' x' + (cfg.qty || 1) + ' → ' + cfg.email);

    var headers = {
      'content-type': 'application/json',
      'accept': 'application/json, text/plain, */*',
      'origin': 'https://www.microsoft.com',
      'referer': location.href
    };
    if (ctx.cV) headers['ms-cv'] = ctx.cV;
    if (ctx.xToken) headers['authorization'] = ctx.xToken;

    try {
      var r = await fetch('https://buynow.production.store-web.dynamics.com/v1.0/Cart/PrepareCheckout?appId=BuyNow&context=CreateOrderAndCheckout', {
        method: 'POST',
        headers: headers,
        credentials: 'include',
        body: JSON.stringify(body)
      });
      var j = await r.json().catch(function () { return null; });
      if (!r.ok || !j) {
        addLog('❌ PrepareCheckout HTTP ' + r.status);
        if (j) addLog('    ' + JSON.stringify(j).slice(0, 200));
        return null;
      }

      var cart = j.cart || j;
      var cid = cart.id || '';
      var lines = cart.lineItems || [];
      var rid = (lines[0] && lines[0].giftee && lines[0].giftee.recipientId) || '';

      if (!cid) { addLog('❌ 响应里没有 cart.id'); return null; }

      giftState.cartId = cid;
      giftState.recipientId = rid;
      giftState.at = Date.now();
      giftState.ok = true;

      addLog('✅ 新 gift cart: ' + cid.slice(0, 8));
      addLog('   收件人档案: ' + (rid ? rid.slice(0, 8) : '(无)'));
      addLog('   金额: ' + (cart.totalAmount || '?') + ' ' + (cart.currencyCode || ''));
      toast('✅ Gift cart 已创建', '数量 ' + (cfg.qty || 1), '收件人 ' + cfg.email);
      refresh();
      return { cartId: cid, recipientId: rid, cart: cart };
    } catch (e) {
      addLog('❌ PrepareCheckout 异常: ' + e.message);
      return null;
    }
  }

  // ============================================================
  // buynow 表单改写（gift 模式）
  // ============================================================
  function isBuynowAction(a) {
    return /\/store\/purchase\/buynowui\/buynow/i.test(String(a || ''));
  }

  var patchedForms = new WeakSet();

  /**
   * 改写 buynow 表单：
   *   · products 换成目标商品（带 quantity）
   *   · scenario 换成 gift
   *   · 补 campaignId 等 gift 必需字段
   */
  function patchBuynow(form) {
    try {
      if (!form || !isBuynowAction(form.action)) return 0;
      if (patchedForms.has(form)) { log('[form] 已处理过'); return 0; }
      patchedForms.add(form);

      var F = {};
      for (var i = 0; i < form.elements.length; i++) {
        var el = form.elements[i];
        if (el && el.name) F[el.name] = String(el.value || '');
      }

      var caller = F['callerApplicationId'] || '';
      var scen = F['scenario'] || '';
      var isFam = /AMCFamilySafety|parentApproval/i.test(caller + '|' + scen + '|' + (F['cssOverride'] || '') + '|' + (F['parentHostName'] || ''));
      if (!isFam) { addLog('[form] 非家庭组链路，跳过'); return 0; }

      var target = planTarget();
      if (!target) { addLog('❌ 付款页未替换：plan 未就绪'); return 0; }

      var cfg = giftCfg();
      var useGift = cfg.enabled && cfg.email;
      var qty = cfg.qty || 1;

      // ---- products：目标商品 + 数量 ----
      var inp = null;
      for (var k = 0; k < form.elements.length; k++) {
        if (form.elements[k] && form.elements[k].name === 'products') { inp = form.elements[k]; break; }
      }
      if (!inp) { addLog('[form] 没有 products 字段'); return 0; }

      var arr;
      try { arr = JSON.parse(inp.value); } catch (e) { return 0; }
      if (!Array.isArray(arr) || !arr.length) return 0;

      var newItem = {
        productId: target.productId,
        skuId: target.skuId,
        availabilityId: target.availabilityId
      };
      if (qty > 1) newItem.quantity = qty;

      arr = [newItem];
      inp.value = JSON.stringify(arr);
      addLog('[form] products → ' + target.productId + '/' + target.availabilityId + ' x' + qty);

      // ---- market / locale ----
      setField(form, 'market', market());
      setField(form, 'locale', localeOf());

      // ---- gift 改造 ----
      if (useGift) {
        setField(form, 'scenario', 'gift');
        setField(form, 'buyNowScenario', 'gift');
        setField(form, 'callerApplicationId', 'XboxCom');
        setField(form, 'cssOverride', 'XboxCom2NewUI');
        setField(form, 'parentHostName', 'www.xbox.com');
        setField(form, 'suppressGiftThankYouPage', 'true');
        if (giftState.cartId) setField(form, 'cartId', giftState.cartId);
        addLog('[form] ✅ scenario → gift · 收件人 ' + cfg.email);
      } else {
        addLog('[form] 保持 parentApproval（未开启 gift）');
      }

      toast('✅ 付款页已改写',
        target.productId + ' x' + qty,
        useGift ? ('送礼 → ' + cfg.email) : '家庭组代付');

      try { consumeOnce(); } catch (e) {}
      return 1;
    } catch (e) {
      addLog('❌ patchBuynow 异常: ' + e.message);
      return 0;
    }
  }

  function setField(form, name, val) {
    for (var i = 0; i < form.elements.length; i++) {
      var el = form.elements[i];
      if (el && el.name === name) { el.value = String(val || ''); return true; }
    }
    // 没有就新增隐藏域
    try {
      var inp = document.createElement('input');
      inp.type = 'hidden';
      inp.name = name;
      inp.value = String(val || '');
      form.appendChild(inp);
      return true;
    } catch (e) { return false; }
  }

  // ============================================================
  // Hook：fetch / XHR / form / iframe
  // ============================================================
  const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  // ---- iframe.src / form.action 改写 ----
  function rewriteUrl(u) {
    try {
      var s = String(u || '');
      if (!/\/store\/purchase\/buynowui\/buynow/i.test(s)) return u;
      var target = planTarget();
      if (!target) return u;
      var m = s.match(/[?&]products=([^&]*)/);
      if (!m) return u;
      var arr;
      try { arr = JSON.parse(decodeURIComponent(m[1])); } catch (e) { return u; }
      if (!Array.isArray(arr)) return u;

      var cfg = giftCfg();
      var qty = cfg.qty || 1;
      var item = { productId: target.productId, skuId: target.skuId, availabilityId: target.availabilityId };
      if (qty > 1) item.quantity = qty;

      var out = s.replace(/([?&]products=)[^&]*/, '$1' + encodeURIComponent(JSON.stringify([item])));
      if (cfg.enabled && cfg.email) {
        out = out.replace(/([?&]scenario=)[^&]*/, '$1gift');
        if (!/[?&]scenario=/.test(out)) out += '&scenario=gift';
      }
      log('[url] 改写', out.slice(0, 120));
      return out;
    } catch (e) { return u; }
  }

  try {
    var IF = PAGE.HTMLIFrameElement;
    if (IF && IF.prototype) {
      var dSrc = Object.getOwnPropertyDescriptor(IF.prototype, 'src');
      if (dSrc && dSrc.set) {
        Object.defineProperty(IF.prototype, 'src', {
          configurable: true, enumerable: dSrc.enumerable, get: dSrc.get,
          set: function (v) { return dSrc.set.call(this, rewriteUrl(v)); }
        });
      }
    }
    var HF = PAGE.HTMLFormElement;
    if (HF && HF.prototype) {
      var dAct = Object.getOwnPropertyDescriptor(HF.prototype, 'action');
      if (dAct && dAct.set) {
        Object.defineProperty(HF.prototype, 'action', {
          configurable: true, enumerable: dAct.enumerable, get: dAct.get,
          set: function (v) { return dAct.set.call(this, rewriteUrl(v)); }
        });
      }
      var oSub = HF.prototype.submit;
      HF.prototype.submit = function () { try { patchBuynow(this); } catch (e) {} return oSub.apply(this, arguments); };
      if (HF.prototype.requestSubmit) {
        var oRS = HF.prototype.requestSubmit;
        HF.prototype.requestSubmit = function () { try { patchBuynow(this); } catch (e) {} return oRS.apply(this, arguments); };
      }
    }
  } catch (e) { log('hook err', e); }

  try {
    PAGE.addEventListener('submit', function (ev) { try { patchBuynow(ev.target); } catch (e) {} }, true);
  } catch (e) {}

  // ---- 捕获 orders / approve，记录 orderId ----
  const RE_ORDERS = /purchase\.md\.mp\.microsoft\.com\/v\d+\.\d+\/users\/me\/orders/;
  const RE_APPROVE = /account\.microsoft\.com\/family\/api\/buy\/requests\/approve/;

  var origFetch = PAGE.fetch;
  if (origFetch) {
    PAGE.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (RE_APPROVE.test(url)) {
          addLog('✅ 主号已批准');
        }
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  }

  // ============================================================
  // 巡检：buynow 表单改写 + 页面状态同步
  // ============================================================
  var lastSig = '';
  setInterval(function () {
    try {
      var forms = PAGE.document ? PAGE.document.querySelectorAll('form') : [];
      for (var i = 0; i < forms.length; i++) {
        if (isBuynowAction(forms[i].action)) patchBuynow(forms[i]);
      }
    } catch (e) {}

    // 面板跟随存储变化
    try {
      var sig = JSON.stringify([store.get(K_GAME), store.get(K_IAP), store.get(K_CODE), giftCfg()]);
      if (sig !== lastSig) { lastSig = sig; refresh(); }
    } catch (e) {}
  }, 1500);

  // ============================================================
  // 面板
  // ============================================================
  var panel = null;

  function shouldShow() {
    try {
      if (window.top !== window.self) return false;
      if (isPayUrl()) return false;      // 付款页不显示
      return true;
    } catch (e) { return false; }
  }

  function build() {
    if (panel || !document.body) return;
    if (!shouldShow()) return;

    var r = role();
    var tag = r === 'child' ? '<span style="background:#1f6feb33;color:#79c0ff;border:1px solid #1f6feb66;border-radius:99px;padding:1px 7px;font-size:10px;font-weight:700;margin-left:6px">子号</span>'
      : r === 'parent' ? '<span style="background:#23863633;color:#7ee787;border:1px solid #23863666;border-radius:99px;padding:1px 7px;font-size:10px;font-weight:700;margin-left:6px">主号</span>'
      : '';

    panel = document.createElement('div');
    panel.id = 'xgc';
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;width:340px;' +
      'background:#0b0b0b;color:#eee;border:1px solid #107C10;border-radius:10px;' +
      'font:12px/1.45 -apple-system,Segoe UI,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.55);overflow:hidden';

    panel.innerHTML =
      '<div id="xgc-hd" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#107C10;cursor:pointer">' +
        '<span><b>Xbox 送礼 v1.0.0</b>' + tag + '</span>' +
        '<span style="font-size:10px;opacity:.8">' + location.host + '</span>' +
        '<span id="xgc-tg" style="margin-left:8px">收起</span>' +
      '</div>' +
      '<div id="xgc-bd" style="padding:10px">' +
        '<div id="xgc-state"></div>' +
        '<div id="xgc-log" style="max-height:130px;overflow:auto;background:#000;border-radius:6px;' +
          'padding:6px;font:11px/1.4 ui-monospace,Menlo,monospace;color:#9c9;white-space:pre-wrap;margin-top:8px"></div>' +
        '<div style="margin-top:8px;display:flex;gap:6px">' +
          '<button id="xgc-g1" style="flex:1;padding:6px;background:#0d2a0d;color:#7fd;border:1px solid #2a5;border-radius:6px;cursor:pointer">获取①游戏ID</button>' +
          '<button id="xgc-d1" style="flex:0 0 46px;padding:6px;background:#2a0d0d;color:#f99;border:1px solid #633;border-radius:6px;cursor:pointer">删</button>' +
        '</div>' +
        '<div style="margin-top:5px;display:flex;gap:6px">' +
          '<button id="xgc-g2" style="flex:1;padding:6px;background:#0d2a0d;color:#7fd;border:1px solid #2a5;border-radius:6px;cursor:pointer">获取②内购ID</button>' +
          '<button id="xgc-d2" style="flex:0 0 46px;padding:6px;background:#2a0d0d;color:#f99;border:1px solid #633;border-radius:6px;cursor:pointer">删</button>' +
        '</div>' +
        '<div style="margin-top:6px;padding:8px;border-radius:7px;background:#12261a;border:1px solid #23863655">' +
          '<div style="color:#7ee787;font-weight:700;font-size:11px;margin-bottom:5px">送礼（取兑换码）</div>' +
          '<input id="xgc-email" placeholder="收码邮箱" style="width:100%;background:#0b0b0b;border:1px solid #30363d;border-radius:5px;padding:6px 8px;color:#eee;font:inherit;outline:none">' +
          '<div style="display:flex;gap:6px;margin-top:5px">' +
            '<input id="xgc-sender" placeholder="寄件人名字" style="flex:1;background:#0b0b0b;border:1px solid #30363d;border-radius:5px;padding:6px 8px;color:#eee;font:inherit;outline:none">' +
            '<input id="xgc-qty" placeholder="数量" value="1" style="flex:0 0 58px;background:#0b0b0b;border:1px solid #30363d;border-radius:5px;padding:6px 8px;color:#eee;font:inherit;text-align:center;outline:none">' +
          '</div>' +
          '<div style="display:flex;gap:6px;margin-top:6px">' +
            '<button id="xgc-save" style="flex:1;padding:5px;background:#1a2f3a;color:#9cf;border:1px solid #265;border-radius:6px;cursor:pointer">保存设置</button>' +
            '<button id="xgc-prep" style="flex:1;padding:5px;background:#2a2a1a;color:#ff9;border:1px solid #553;border-radius:6px;cursor:pointer">建 Gift Cart</button>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:6px;display:flex;gap:6px">' +
          '<button id="xgc-lic" style="flex:1;padding:5px;background:#2a1a3a;color:#c8f;border:1px solid #536;border-radius:6px;cursor:pointer">授权</button>' +
          '<button id="xgc-ref" style="flex:0 0 50px;padding:5px;background:#1a2f3a;color:#9cf;border:1px solid #265;border-radius:6px;cursor:pointer">刷新</button>' +
          '<button id="xgc-clr" style="flex:1;padding:5px;background:#3a1a1a;color:#f99;border:1px solid #633;border-radius:6px;cursor:pointer">清空</button>' +
        '</div>' +
      '</div>';
    document.documentElement.appendChild(panel);

    var bd = panel.querySelector('#xgc-bd');
    panel.querySelector('#xgc-hd').addEventListener('click', function () {
      var open = bd.style.display !== 'none';
      bd.style.display = open ? 'none' : '';
      panel.querySelector('#xgc-tg').textContent = open ? '展开' : '收起';
    });

    panel.querySelector('#xgc-g1').addEventListener('click', function () { grab(K_GAME, '① 游戏'); });
    panel.querySelector('#xgc-g2').addEventListener('click', function () { grab(K_IAP, '② 内购'); });
    panel.querySelector('#xgc-d1').addEventListener('click', function () { drop(K_GAME, '①'); });
    panel.querySelector('#xgc-d2').addEventListener('click', function () { drop(K_IAP, '②'); });

    panel.querySelector('#xgc-save').addEventListener('click', function () {
      var c = {
        email: panel.querySelector('#xgc-email').value.trim(),
        sender: panel.querySelector('#xgc-sender').value.trim() || 'Gift',
        qty: Math.max(1, Math.min(10, parseInt(panel.querySelector('#xgc-qty').value, 10) || 1)),
        enabled: !!panel.querySelector('#xgc-email').value.trim()
      };
      store.set(K_GIFT, c);
      addLog('✅ 送礼设置已保存: ' + c.email + ' x' + c.qty);
      refresh();
    });

    panel.querySelector('#xgc-prep').addEventListener('click', function () {
      prepareGiftCart();
    });

    panel.querySelector('#xgc-lic').addEventListener('click', async function () {
      var cur = lic();
      var raw = prompt('输入授权码（留空=清除）：', cur ? cur.code : '');
      if (raw === null) return;
      raw = raw.trim().toUpperCase();
      if (!raw) { store.del(K_CODE); addLog('已清除授权码'); refresh(); return; }
      setLic(raw);
      var r = await checkLic();
      if (r.ok) { addLog('✅ 授权成功，剩余 ' + r.remaining + ' 次'); toast('授权成功', '剩余 ' + r.remaining + ' 次'); }
      else { store.del(K_CODE); addLog('❌ ' + r.error); }
      refresh();
    });

    panel.querySelector('#xgc-ref').addEventListener('click', function () {
      addLog('已刷新');
      checkLic();
      if (store.get(K_GAME) && store.get(K_IAP)) fetchPlan(true);
      refresh();
    });

    panel.querySelector('#xgc-clr').addEventListener('click', function () {
      [K_GAME, K_IAP, K_PLAN, K_GIFT, K_DONE, K_LOG].forEach(function (k) { store.del(k); });
      giftState = { cartId: '', recipientId: '', at: 0, ok: false };
      logs = [];
      addLog('✅ 已清空');
      refresh();
    });

    // 回填设置
    var cfg = giftCfg();
    if (cfg.email) panel.querySelector('#xgc-email').value = cfg.email;
    if (cfg.sender) panel.querySelector('#xgc-sender').value = cfg.sender;
    panel.querySelector('#xgc-qty').value = cfg.qty || 1;

    refresh();
    addLog('v1.0.0 注入 · ' + location.host + ' · 角色=' + role());
  }

  function grab(key, label) {
    var pid = '';
    var u = location.href;
    var m = u.match(/\/store\/(?:apps|pdp|games)\/[^/]*\/([A-Z0-9]{12})\b/i) ||
            u.match(/\/p\/([A-Z0-9]{12})\b/i) ||
            u.match(/\b([A-Z0-9]{12})\b/);
    if (m) pid = m[1].toUpperCase();
    if (!pid) { addLog('❌ 当前页面没有商品 ID'); return; }

    var old = store.get(key) || {};
    store.set(key, {
      productId: pid,
      skuId: old.skuId || '0010',
      availabilityId: old.availabilityId || '',
      market: market()
    });
    addLog('✅ ' + label + ' = ' + pid);
    toast('已获取' + label, pid, '');
    refresh();
    if (store.get(K_GAME) && store.get(K_IAP)) fetchPlan(true);
  }

  function drop(key, label) {
    store.del(key);
    store.del(K_PLAN);
    addLog('已删除 ' + label);
    refresh();
  }

  function refresh() {
    if (!panel) return;
    var st = panel.querySelector('#xgc-state');
    if (!st) return;

    var g = store.get(K_GAME), t = store.get(K_IAP);
    var p = planTarget();
    var cfg = giftCfg();
    var l = lic();

    function row(label, has, main, sub) {
      return '<div style="padding:6px 8px;border-radius:6px;margin-bottom:5px;background:' +
        (has ? '#0e2f12' : '#2f1212') + ';border:1px solid ' + (has ? '#2f7a3a' : '#7a2f2f') + '">' +
        '<div style="color:#9fe6a8;font-size:10.5px;font-weight:700">' + label + '</div>' +
        (has ? '<div style="color:#fff;font-family:ui-monospace,monospace;font-size:13px;font-weight:700">' + esc(main) + '</div>' +
               (sub ? '<div style="color:#7a8;font-size:10.5px">' + esc(sub) + '</div>' : '')
             : '<div style="color:#f88;font-size:11px">未获取</div>') +
        '</div>';
    }

    st.innerHTML =
      row('① 游戏（会被替换）', g && g.productId, g && g.productId, g && g.market) +
      row('② 内购（目标）', t && t.productId, t && t.productId,
          (t && t.market) || '') +
      (p ? '<div style="font-size:11px;color:#8fe;margin-top:3px">目标：' + esc(p.productId) + ' / ' + esc(p.availabilityId) + '</div>'
         : '<div style="font-size:11px;color:#888;margin-top:3px">目标：等待 plan</div>') +
      '<div style="font-size:11px;color:' + (cfg.email ? '#7ee787' : '#888') + ';margin-top:2px">' +
        (cfg.email ? '送礼：' + esc(cfg.email) + ' x' + cfg.qty : '送礼：未设置（走家庭组代付）') +
      '</div>' +
      (giftState.cartId ? '<div style="font-size:11px;color:#7ee787;margin-top:2px">Gift cart：' + esc(giftState.cartId.slice(0, 8)) + '</div>' : '') +
      '<div style="font-size:11px;color:' + (l ? '#7fd' : '#f88') + ';margin-top:2px">' +
        (l ? '授权：剩余 ' + licState.remaining + ' 次' : '授权：未激活') +
      '</div>';
  }

  // ============================================================
  // 启动
  // ============================================================
  restoreLogs();
  log('v1.0.0 loaded', location.host);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else setTimeout(build, 0);

  setTimeout(function () {
    if (lic()) checkLic();
  }, 900);

  // 付款页：自动接管
  if (isPayUrl()) {
    setTimeout(function () {
      log('[pay] 付款页启动，等待 context');
      var wait = setInterval(function () {
        var ctx = pageCtx();
        if (ctx && ctx.riskId) {
          clearInterval(wait);
          log('[pay] context 就绪，risk=' + ctx.riskId.slice(0, 8));
          var cfg = giftCfg();
          if (cfg.enabled && cfg.email && !giftState.cartId) {
            prepareGiftCart();
          }
        }
      }, 800);
      setTimeout(function () { clearInterval(wait); }, 20000);
    }, 1200);
  }
})();