// ==UserScript==
// @name         Xbox 家庭组内购送礼（网页版）
// @namespace    https://github.com/theslugger/xbox-family-gift
// @version      2.1.0
// @description  子号加购游戏/内购 → 子号发起 → 主号 family safety 批准 → 付款时把游戏换成内购。纯网页，无需 Surge/Shadowrocket
// @author       theslugger
// @match        https://www.xbox.com/*
// @match        https://www.microsoft.com/*
// @match        https://account.microsoft.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const KEY_GAME = 'xfg_idsGame';
  const KEY_IAP  = 'xfg_idsIAP';
  const KEY_LOCK = 'xfg_locked';
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
  // 采集
  // ============================================================
  function collectItems(bodyStr) {
    let o; try { o = JSON.parse(bodyStr); } catch (e) { return []; }
    if (!o) return [];
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
      if (pid && sid) out.push({ productId: pid, availabilityId: aid, skuId: sid });
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

  function handleCaptureItems(items) {
    if (!items || !items.length) return;
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
  function swapOrdersJson(bodyStr, g, t) {
    let o; try { o = JSON.parse(bodyStr); } catch (e) { return null; }
    let n = 0;
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
    if (caller !== 'AMCFamilySafetyApp' && scen !== 'parentApproval') return null;
    if (d['products'] === undefined) return null;
    let arr; try { arr = JSON.parse(unq(d['products'])); } catch (e) { return null; }
    if (!Array.isArray(arr)) return null;
    let cn = 0; arr.forEach(it => { cn += swapOne(it, g, t); });
    if (!cn) return null;
    const parts = bodyStr.split('&').map(p => {
      const i = p.indexOf('='); if (i < 0) return p;
      const k = unq(p.slice(0, i));
      return k === 'products' ? p.slice(0, i) + '=' + qq(JSON.stringify(arr)) : p;
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
    log('响应采集 items=', items);
    handleCaptureItems(items);
  }

  // 把 handleCapture 拆出可复用的 items 版本
  // ============================================================
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
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
  const XHR = window.XMLHttpRequest;
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
      GM_registerMenuCommand("解除锁定", () => { store.del(KEY_LOCK); notify("已解除锁定", "可重新采集", ""); });
      GM_registerMenuCommand("测试采集(自检)", () => {
        handleCaptureItems([{ productId: "TESTPROD0001", availabilityId: "TESTAVAIL01", skuId: "0010" }]);
        notify("自检完成", "若看到①②弹窗说明采集正常", "记得清空");
      });
    }
  } catch (e) {}

  log("v2.1 injected");
})();
