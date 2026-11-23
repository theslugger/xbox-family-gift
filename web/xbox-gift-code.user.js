// ==UserScript==
// @name         Xbox 家庭组代付 → 送礼取码
// @namespace    https://github.com/theslugger/xbox-family-gift
// @version      1.1.0
// @description  对当前游戏发起送礼，主号批准付款，产物为可兑换的数字码
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

  const SERVER = 'https://xbox.aappe.uk';
  const K_CODE = 'xg_code';
  const K_GIFT = 'xg_giftCfg';
  const K_LOG = 'xg_log';
  const K_CART = 'xg_cart';
  const DEBUG = true;

  // ============================================================
  // 存储
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
  // 日志 / 提示
  // ============================================================
  var logs = [];
  function log() { if (DEBUG) console.log('%c[XGC]', 'color:#107C10;font-weight:700', ...arguments); }
  function addLog(m) {
    var line = new Date().toLocaleTimeString() + ' ' + m;
    logs.push(line);
    if (logs.length > 60) logs.shift();
    var el = document.querySelector('#xgc-log');
    if (el) el.textContent = logs.join('\n');
    store.set(K_LOG, logs);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
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

  // ============================================================
  // 角色
  // ============================================================
  function role() {
    var h = location.hostname;
    if (h === 'account.microsoft.com') return 'parent';
    if (h === 'www.xbox.com' || h === 'xbox.com') return 'child';
    if (h === 'www.microsoft.com') return 'pay';
    return 'other';
  }
  function isPayUrl() { return /\/store\/purchase\/buynowui\/buynow/i.test(location.href); }

  // ============================================================
  // 授权
  // ============================================================
  var licState = { valid: false, remaining: 0 };

  function lic() {
    var v = store.get(K_CODE);
    return v && typeof v === 'object' && v.code ? v : null;
  }
  function setLic(code) {
    store.set(K_CODE, { code: String(code || '').toUpperCase().trim(), at: Date.now() });
  }

  async function checkLic() {
    var l = lic();
    if (!l) return { ok: false, error: '未设置授权码' };
    try {
      var r = await fetch(SERVER + '/api/license/check', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit',
        body: JSON.stringify({ code: l.code })
      });
      var j = await r.json();
      if (!j.ok) return { ok: false, error: j.error || '无效' };
      licState = { valid: true, remaining: j.data.remaining };
      return { ok: true, remaining: j.data.remaining };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function consume() {
    var l = lic();
    if (!l) { addLog('❌ 未设置授权码'); return; }
    try {
      var r = await fetch(SERVER + '/api/license/consume', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit',
        body: JSON.stringify({ code: l.code, market: market(), iap: '' })
      });
      var j = await r.json();
      if (!j.ok) { addLog('❌ 扣次失败: ' + (j.error || '?')); return; }
      licState.remaining = j.data.remaining;
      addLog('💰 扣 1 次，剩余 ' + j.data.remaining + ' 次');
      refresh();
    } catch (e) { addLog('❌ 扣次异常: ' + e.message); }
  }

  // ============================================================
  // 市场
  // ============================================================
  function market() {
    var m = (location.pathname || '').match(/\/([a-z]{2})-([a-z]{2})(\/|$)/i);
    if (m) return (m[1] + m[2]).toUpperCase().slice(0, 2);
    var q = (location.search || '').match(/[?&]market=([A-Za-z]{2})/);
    if (q) return q[1].toUpperCase();
    return 'US';
  }
  function localeOf() {
    var map = { AR:'es-ar', US:'en-us', TR:'tr-tr', BR:'pt-br', MX:'es-mx', JP:'ja-jp', GB:'en-gb', DE:'de-de' };
    var m = (location.pathname || '').match(/\/([a-z]{2})-([a-z]{2})(\/|$)/i);
    if (m) return m[1].toLowerCase() + '-' + m[2].toUpperCase();
    return map[market()] || 'en-us';
  }

  // ============================================================
  // 送礼配置
  // ============================================================
  function giftCfg() {
    var c = store.get(K_GIFT) || {};
    return {
      email: c.email || '',
      sender: c.sender || 'Gift',
      qty: Math.max(1, Math.min(10, parseInt(c.qty, 10) || 1)),
      enabled: !!c.email
    };
  }

  // ============================================================
  // 当前商品（不再需要 ①② 替换）
  // ------------------------------------------------------------
  // 直接读页面 __STORE_CART_STATE__.appContext.products
  // 或从 URL / 商品页 DOM 兜底
  // ============================================================
  function currentProduct() {
    var P = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    var st = null;
    try { st = P.__STORE_CART_STATE__; } catch (e) {}
    var ac = (st && st.appContext) || {};

    function pick(p0, src) {
      if (!p0 || !p0.productId) return null;
      return {
        productId: String(p0.productId).toUpperCase(),
        skuId: String(p0.skuId || '0010'),
        availabilityId: String(p0.availabilityId || ''),
        source: src
      };
    }

    // 1) productsToAdd（对象，最可靠）
    try {
      var it = ac.productsToAdd && ac.productsToAdd.items;
      if (Array.isArray(it) && it.length) {
        var r1 = pick(it[0], 'productsToAdd');
        if (r1) return r1;
      }
    } catch (e) {}

    // 2) products（可能是 JSON 字符串，也可能是数组）
    try {
      var pr = ac.products;
      if (typeof pr === 'string') {
        try { pr = JSON.parse(pr); } catch (e) { pr = null; }
      }
      if (Array.isArray(pr) && pr.length) {
        var r2 = pick(pr[0], 'products');
        if (r2) return r2;
      }
    } catch (e) {}

    // 3) entities.products.byId（key 形如 pid/sku/avail）
    try {
      var byId = st.entities && st.entities.products && st.entities.products.byId;
      if (byId) {
        var keys = Object.keys(byId);
        if (keys.length) {
          var parts = keys[0].split('/');
          if (parts.length >= 3) {
            return {
              productId: parts[0].toUpperCase(),
              skuId: parts[1],
              availabilityId: parts[2],
              source: 'entities'
            };
          }
        }
      }
    } catch (e) {}

    // 2) URL 里的 12 位 ID
    var u = location.href;
    var m = u.match(/\/store\/(?:apps|pdp|games)\/[^/]*\/([A-Z0-9]{12})\b/i) ||
            u.match(/\/p\/([A-Z0-9]{12})\b/i) ||
            u.match(/\/([A-Z0-9]{12})(?:[?#/]|$)/);
    if (m) {
      return { productId: m[1].toUpperCase(), skuId: '0010', availabilityId: '', source: 'url' };
    }
    return null;
  }

  // ============================================================
  // 页面 context（PrepareCheckout 必需参数）
  // ============================================================
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
        raw: st
      };
    } catch (e) { log('pageCtx err', e); return null; }
  }

  // ============================================================
  // 【核心】建 gift cart
  // ============================================================
  var giftCart = { id: '', recipientId: '', at: 0 };

  function loadCart() {
    var v = store.get(K_CART);
    if (v && v.id) giftCart = v;
  }
  function saveCart(c) {
    giftCart = { id: c.id || '', recipientId: c.recipientId || '', at: Date.now() };
    store.set(K_CART, giftCart);
  }

  async function prepareGiftCart() {
    var cfg = giftCfg();
    if (!cfg.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cfg.email)) {
      addLog('❌ 收码邮箱无效');
      return null;
    }

    var prod = currentProduct();
    if (!prod || !prod.productId) {
      addLog('❌ 拿不到当前商品 ID');
      return null;
    }
    if (!prod.availabilityId) {
      addLog('⚠️ 商品缺 availabilityId，将让服务端补');
      // 用服务端补 availabilityId
      var fixed = await fillAvail(prod.productId, prod.skuId);
      if (fixed) prod.availabilityId = fixed;
      if (!prod.availabilityId) { addLog('❌ 补 availabilityId 失败'); return null; }
    }

    var ctx = pageCtx();
    if (!ctx || !ctx.riskId || !ctx.xToken) {
      addLog('❌ 缺页面 context（riskId/xToken）');
      return null;
    }

    var item = {
      productId: prod.productId,
      skuId: prod.skuId || '0010',
      availabilityId: prod.availabilityId,
      quantity: cfg.qty || 1
    };
    if (ctx.campaignId) item.campaignId = ctx.campaignId;

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
        gifteeSenderName: cfg.sender,
        gifteeType: 'email',
        gifteeGamertag: ''
      },
      itemsToAdd: { items: [item] }
    };

    addLog('[gift] PrepareCheckout ' + prod.productId + '/' + prod.availabilityId + ' x' + item.quantity + ' → ' + cfg.email);

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
        method: 'POST', headers: headers, credentials: 'include', body: JSON.stringify(body)
      });
      var txt = await r.text();
      var j = null;
      try { j = JSON.parse(txt); } catch (e) {}

      if (!r.ok || !j) {
        addLog('❌ PrepareCheckout HTTP ' + r.status);
        addLog('   ' + txt.slice(0, 220));
        return null;
      }

      var cart = j.cart || j;
      var cid = cart.id || '';
      var lines = cart.lineItems || [];
      var rid = (lines[0] && lines[0].giftee && lines[0].giftee.recipientId) || '';

      if (!cid) {
        addLog('❌ 响应无 cart.id');
        addLog('   ' + txt.slice(0, 220));
        return null;
      }

      saveCart({ id: cid, recipientId: rid });
      addLog('✅ gift cart ' + cid.slice(0, 8) + ' · 收件人 ' + (rid ? rid.slice(0, 8) : '-'));
      addLog('   金额 ' + (cart.totalAmount || '?') + ' ' + (cart.currencyCode || ''));
      toast('✅ Gift cart 已建', cfg.email + ' x' + item.quantity, cid.slice(0, 8));
      refresh();
      return { cartId: cid, recipientId: rid, cart: cart };
    } catch (e) {
      addLog('❌ PrepareCheckout 异常: ' + e.message);
      return null;
    }
  }

  /** 服务端补 availabilityId */
  async function fillAvail(productId, skuId) {
    try {
      var r = await fetch(SERVER + '/api/resolve', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit',
        body: JSON.stringify({ productId: productId, skuId: skuId || '0010', market: market() })
      });
      var j = await r.json();
      if (j.ok && j.data && j.data.availabilityId) {
        addLog('[avail] 服务端补: ' + j.data.availabilityId);
        return j.data.availabilityId;
      }
      if (j.ok && j.availabilityId) return j.availabilityId;
      addLog('[avail] 服务端未返回: ' + JSON.stringify(j).slice(0, 120));
    } catch (e) { addLog('[avail] 异常: ' + e.message); }
    return '';
  }

  // ============================================================
  // buynow 表单改写 → gift
  // ============================================================
  function isBuynowAction(a) { return /\/store\/purchase\/buynowui\/buynow/i.test(String(a || '')); }
  var patched = new WeakSet();

  function patchBuynow(form) {
    try {
      if (!form || !isBuynowAction(form.action)) return 0;
      if (patched.has(form)) return 0;
      patched.add(form);

      var F = {};
      for (var i = 0; i < form.elements.length; i++) {
        var el = form.elements[i];
        if (el && el.name) F[el.name] = String(el.value || '');
      }

      var caller = F['callerApplicationId'] || '';
      var scen = F['scenario'] || '';
      var isFam = /AMCFamilySafety|parentApproval/i.test(caller + '|' + scen + '|' + (F['cssOverride'] || ''));
      if (!isFam) { addLog('[form] 非家庭组链路，跳过'); return 0; }

      var cfg = giftCfg();
      if (!cfg.enabled) { addLog('[form] 未开启送礼，保持原样'); return 0; }

      var prod = currentProduct();
      if (!prod) { addLog('[form] 拿不到当前商品'); return 0; }

      // products：当前商品 + 数量
      var inp = null;
      for (var k = 0; k < form.elements.length; k++) {
        if (form.elements[k] && form.elements[k].name === 'products') { inp = form.elements[k]; break; }
      }
      if (!inp) { addLog('[form] 无 products 字段'); return 0; }

      var item = {
        productId: prod.productId,
        skuId: prod.skuId || '0010',
        availabilityId: prod.availabilityId || ''
      };
      if (!item.availabilityId) {
        // 从表单原有 products 里取
        try {
          var old = JSON.parse(inp.value);
          if (Array.isArray(old) && old[0] && old[0].availabilityId) item.availabilityId = old[0].availabilityId;
        } catch (e) {}
      }
      if (!item.availabilityId) { addLog('[form] 商品缺 availabilityId'); return 0; }
      if (cfg.qty > 1) item.quantity = cfg.qty;

      inp.value = JSON.stringify([item]);
      addLog('[form] products → ' + item.productId + '/' + item.availabilityId + ' x' + (cfg.qty || 1));

      setField(form, 'market', market());
      setField(form, 'locale', localeOf());
      setField(form, 'scenario', 'gift');
      setField(form, 'callerApplicationId', 'XboxCom');
      setField(form, 'cssOverride', 'XboxCom2NewUI');
      setField(form, 'parentHostName', 'www.xbox.com');
      setField(form, 'suppressGiftThankYouPage', 'true');
      if (giftCart.id) setField(form, 'cartId', giftCart.id);

      addLog('[form] ✅ → gift · ' + cfg.email);
      toast('✅ 已转送礼', item.productId + ' x' + (cfg.qty || 1), cfg.email);
      try { consume(); } catch (e) {}
      return 1;
    } catch (e) { addLog('❌ patch 异常: ' + e.message); return 0; }
  }

  function setField(form, name, val) {
    for (var i = 0; i < form.elements.length; i++) {
      var el = form.elements[i];
      if (el && el.name === name) { el.value = String(val == null ? '' : val); return true; }
    }
    try {
      var inp = document.createElement('input');
      inp.type = 'hidden'; inp.name = name; inp.value = String(val == null ? '' : val);
      form.appendChild(inp);
      return true;
    } catch (e) { return false; }
  }

  // ============================================================
  // URL / iframe / form hook
  // ============================================================
  const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  function rewriteUrl(u) {
    try {
      var s = String(u || '');
      if (!/\/store\/purchase\/buynowui\/buynow/i.test(s)) return u;
      var cfg = giftCfg();
      if (!cfg.enabled) return u;
      var prod = currentProduct();
      if (!prod) return u;

      var m = s.match(/[?&]products=([^&]*)/);
      if (m) {
        var item = { productId: prod.productId, skuId: prod.skuId || '0010', availabilityId: prod.availabilityId || '' };
        if (!item.availabilityId) {
          try { item.availabilityId = JSON.parse(decodeURIComponent(m[1]))[0].availabilityId; } catch (e) {}
        }
        if (cfg.qty > 1) item.quantity = cfg.qty;
        s = s.replace(/([?&]products=)[^&]*/, '$1' + encodeURIComponent(JSON.stringify([item])));
      }
      if (!/[?&]scenario=/.test(s)) s += '&scenario=gift';
      else s = s.replace(/([?&]scenario=)[^&]*/, '$1gift');
      log('[url] → gift');
      return s;
    } catch (e) { return u; }
  }

  try {
    var IF = PAGE.HTMLIFrameElement;
    if (IF && IF.prototype) {
      var dS = Object.getOwnPropertyDescriptor(IF.prototype, 'src');
      if (dS && dS.set) Object.defineProperty(IF.prototype, 'src', {
        configurable: true, enumerable: dS.enumerable, get: dS.get,
        set: function (v) { return dS.set.call(this, rewriteUrl(v)); }
      });
    }
    var HF = PAGE.HTMLFormElement;
    if (HF && HF.prototype) {
      var dA = Object.getOwnPropertyDescriptor(HF.prototype, 'action');
      if (dA && dA.set) Object.defineProperty(HF.prototype, 'action', {
        configurable: true, enumerable: dA.enumerable, get: dA.get,
        set: function (v) { return dA.set.call(this, rewriteUrl(v)); }
      });
      var oS = HF.prototype.submit;
      HF.prototype.submit = function () { try { patchBuynow(this); } catch (e) {} return oS.apply(this, arguments); };
      if (HF.prototype.requestSubmit) {
        var oR = HF.prototype.requestSubmit;
        HF.prototype.requestSubmit = function () { try { patchBuynow(this); } catch (e) {} return oR.apply(this, arguments); };
      }
    }
  } catch (e) { log('hook err', e); }

  try {
    PAGE.addEventListener('submit', function (ev) { try { patchBuynow(ev.target); } catch (e) {} }, true);
  } catch (e) {}

  // ============================================================
  // 巡检
  // ============================================================
  setInterval(function () {
    try {
      var forms = PAGE.document ? PAGE.document.querySelectorAll('form') : [];
      for (var i = 0; i < forms.length; i++) {
        if (isBuynowAction(forms[i].action)) patchBuynow(forms[i]);
      }
    } catch (e) {}
  }, 1500);

  // ============================================================
  // 面板
  // ============================================================
  var panel = null;

  function shouldShow() {
    try {
      if (window.top !== window.self) return false;
      if (isPayUrl()) return false;
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
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;width:330px;' +
      'background:#0b0b0b;color:#eee;border:1px solid #107C10;border-radius:10px;' +
      'font:12px/1.45 -apple-system,Segoe UI,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.55);overflow:hidden';

    panel.innerHTML =
      '<div id="xgc-hd" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#107C10;cursor:pointer">' +
        '<span><b>Xbox 送礼 v1.1.0</b>' + tag + '</span>' +
        '<span style="font-size:10px;opacity:.8">' + location.host + '</span>' +
        '<span id="xgc-tg" style="margin-left:8px">收起</span>' +
      '</div>' +
      '<div id="xgc-bd" style="padding:10px">' +
        '<div id="xgc-state"></div>' +
        '<div id="xgc-log" style="max-height:140px;overflow:auto;background:#000;border-radius:6px;' +
          'padding:6px;font:11px/1.4 ui-monospace,Menlo,monospace;color:#9c9;white-space:pre-wrap;margin-top:8px"></div>' +
        '<div style="margin-top:8px">' +
          '<input id="xgc-email" placeholder="收码邮箱（必填）" style="width:100%;background:#0b0b0b;border:1px solid #30363d;border-radius:6px;padding:7px 9px;color:#eee;font:inherit;outline:none">' +
          '<div style="display:flex;gap:6px;margin-top:6px">' +
            '<input id="xgc-sender" placeholder="寄件人名字" style="flex:1;background:#0b0b0b;border:1px solid #30363d;border-radius:6px;padding:7px 9px;color:#eee;font:inherit;outline:none">' +
            '<input id="xgc-qty" placeholder="数量" value="1" style="flex:0 0 62px;background:#0b0b0b;border:1px solid #30363d;border-radius:6px;padding:7px 9px;color:#eee;font:inherit;text-align:center;outline:none">' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:6px;display:flex;gap:6px">' +
          '<button id="xgc-save" style="flex:1;padding:6px;background:#238636;color:#fff;border:1px solid #2ea043;border-radius:6px;cursor:pointer;font-weight:600">保存并建 Gift Cart</button>' +
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

    panel.querySelector('#xgc-save').addEventListener('click', function () {
      var email = panel.querySelector('#xgc-email').value.trim();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        addLog('❌ 邮箱格式不正确');
        return;
      }
      store.set(K_GIFT, {
        email: email,
        sender: panel.querySelector('#xgc-sender').value.trim() || 'Gift',
        qty: Math.max(1, Math.min(10, parseInt(panel.querySelector('#xgc-qty').value, 10) || 1))
      });
      addLog('✅ 设置已保存');
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
      refresh();
    });

    panel.querySelector('#xgc-clr').addEventListener('click', function () {
      [K_GIFT, K_CART, K_LOG].forEach(function (k) { store.del(k); });
      giftCart = { id: '', recipientId: '', at: 0 };
      logs = [];
      addLog('✅ 已清空');
      refresh();
    });

    var c = giftCfg();
    if (c.email) panel.querySelector('#xgc-email').value = c.email;
    if (c.sender) panel.querySelector('#xgc-sender').value = c.sender;
    panel.querySelector('#xgc-qty').value = c.qty || 1;

    refresh();
    addLog('v1.1.0 注入 · ' + location.host + ' · 角色=' + role());
  }

  function refresh() {
    if (!panel) return;
    var st = panel.querySelector('#xgc-state');
    if (!st) return;

    var cfg = giftCfg();
    var l = lic();
    var prod = currentProduct();
    var pctx = pageCtx();

    st.innerHTML =
      '<div style="padding:6px 8px;border-radius:6px;background:' + (prod ? '#0e2f12' : '#2f1212') +
        ';border:1px solid ' + (prod ? '#2f7a3a' : '#7a2f2f') + ';margin-bottom:5px">' +
        '<div style="color:#9fe6a8;font-size:10.5px;font-weight:700">当前商品</div>' +
        (prod ? '<div style="color:#fff;font-family:ui-monospace,monospace;font-size:13px;font-weight:700">' + esc(prod.productId) + '</div>' +
                '<div style="color:#7a8;font-size:10.5px">' + esc(prod.availabilityId || '(缺 avail)') + ' · ' + esc(prod.source) + '</div>'
              : '<div style="color:#f88;font-size:11px">未识别（打开商品页或付款页）</div>') +
      '</div>' +
      '<div style="font-size:11px;color:' + (cfg.email ? '#7ee787' : '#888') + '">' +
        (cfg.email ? '送礼 → ' + esc(cfg.email) + ' x' + cfg.qty : '送礼：未设置邮箱') +
      '</div>' +
      (giftCart.id ? '<div style="font-size:11px;color:#7ee787">Gift cart：' + esc(giftCart.id.slice(0, 8)) + '</div>' : '') +
      '<div style="font-size:11px;color:' + (pctx ? '#7fd' : '#888') + '">' +
        (pctx ? 'Context：risk ' + esc(pctx.riskId.slice(0, 8)) + ' · ' + pctx.flights.length + ' flights'
              : 'Context：仅付款页可用') +
      '</div>' +
      '<div style="font-size:11px;color:' + (l ? '#7fd' : '#f88') + '">' +
        (l ? '授权：剩余 ' + licState.remaining + ' 次' : '授权：未激活') +
      '</div>';

    var el = panel.querySelector('#xgc-log');
    if (el) el.textContent = logs.join('\n');
  }

  // ============================================================
  // 启动
  // ============================================================
  loadCart();
  var oldLogs = store.get(K_LOG);
  if (Array.isArray(oldLogs)) logs = oldLogs.slice(-60);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else setTimeout(build, 0);

  setTimeout(function () { if (lic()) checkLic(); }, 900);

  // 付款页：context 就绪后自动建 gift cart
  if (isPayUrl()) {
    setTimeout(function () {
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        var ctx = pageCtx();
        if (ctx && ctx.riskId) {
          clearInterval(t);
          var cfg = giftCfg();
          if (cfg.email && !giftCart.id) {
            addLog('[pay] context 就绪，开始建 gift cart');
            prepareGiftCart();
          } else if (giftCart.id) {
            addLog('[pay] 已有 gift cart: ' + giftCart.id.slice(0, 8));
          }
        } else if (tries > 25) {
          clearInterval(t);
        }
      }, 800);
    }, 1000);
  }
})();