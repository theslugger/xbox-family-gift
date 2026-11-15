// ==UserScript==
// @name         Xbox 家庭组内购送礼（网页版）
// @namespace    https://github.com/theslugger/xbox-family-gift
// @version      1.0.0
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

  // ============================================================
  // 配置
  // ============================================================
  const KEY_GAME = 'xfg_idsGame';
  const KEY_IAP  = 'xfg_idsIAP';
  const KEY_LOCK = 'xfg_locked';   // 采集齐后锁定，避免主号操作时被覆盖
  const DEBUG = true;

  // ============================================================
  // 存储（GM_* 优先，退化到 localStorage）
  // ============================================================
  const store = {
    get(k) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(k, '');
          return v ? JSON.parse(v) : null;
        }
      } catch (e) {}
      try {
        const v = localStorage.getItem(k);
        return v ? JSON.parse(v) : null;
      } catch (e) { return null; }
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
  // 通知（右下角 toast + GM_notification）
  // ============================================================
  function notify(title, sub, body) {
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title: title, text: [sub, body].filter(Boolean).join('\n'), timeout: 6000 });
      }
    } catch (e) {}
    toast(title, sub, body);
    log('NOTIFY', title, sub, body);
  }

  function toast(title, sub, body) {
    try {
      if (!document.body) {
        setTimeout(() => toast(title, sub, body), 300);
        return;
      }
      const id = 'xfg-toast-' + Date.now();
      const el = document.createElement('div');
      el.id = id;
      el.style.cssText = [
        'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
        'max-width:340px', 'padding:12px 14px', 'border-radius:10px',
        'background:#107C10', 'color:#fff', 'font:13px/1.5 -apple-system,Segoe UI,sans-serif',
        'box-shadow:0 6px 24px rgba(0,0,0,.35)', 'opacity:0', 'transition:opacity .2s'
      ].join(';');
      el.innerHTML =
        '<div style="font-weight:700;margin-bottom:4px">' + esc(title) + '</div>' +
        (sub ? '<div style="font-weight:600;word-break:break-all">' + esc(sub) + '</div>' : '') +
        (body ? '<div style="opacity:.85;margin-top:2px;word-break:break-all">' + esc(body) + '</div>' : '');
      document.documentElement.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = '1'; });
      setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 6000);
    } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function log(...a) { if (DEBUG) console.log('%c[XFG]', 'color:#107C10;font-weight:700', ...a); }

  // ============================================================
  // 采集：从 loadCart 请求体读 itemsToAdd.items
  // ============================================================
  function collectItems(bodyStr) {
    let o;
    try { o = JSON.parse(bodyStr); } catch (e) { return []; }
    if (!o) return [];
    let arr = null;
    if (o.itemsToAdd && Array.isArray(o.itemsToAdd.items)) arr = o.itemsToAdd.items;
    else if (Array.isArray(o.items)) arr = o.items;
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
    if (!items.length) return;
    let game = store.get(KEY_GAME);
    let iap  = store.get(KEY_IAP);

    // 已锁定(游戏+内购都采齐) -> 只做"命中"提示，绝不覆盖（防止主号操作时串号）
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
        } else {
          notify('①【游戏】命中', ids.productId, 'avail:' + ids.availabilityId);
        }
        continue;
      }
      if (iap && sameProduct(iap, ids)) {
        if (!fullId(iap) || iap.availabilityId !== ids.availabilityId || iap.skuId !== ids.skuId) {
          store.set(KEY_IAP, ids); iap = ids;
          notify('②【内购】ID已更新', ids.productId, 'avail:' + ids.availabilityId + ' sku:' + ids.skuId);
        } else {
          notify('②【内购】命中', ids.productId, 'avail:' + ids.availabilityId);
        }
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
    log('capture', { game, iap, locked: store.get(KEY_LOCK) });
  }

  // ============================================================
  // 替换：只在"付款"阶段把游戏三件套换成内购
  //   1) purchase.md.mp.microsoft.com/v*/users/me/orders  (JSON items[])
  //   2) www.microsoft.com/store/purchase/buynowui/buynow (form products=, 仅 safety)
  // ============================================================
  function swapOne(obj, g, t) {
    if (!(t.productId && t.availabilityId)) return 0; // 内购不完整 -> 不换，防 404
    if (obj.productId !== g.productId) return 0;
    obj.productId = t.productId;
    if (obj.availabilityId !== undefined) obj.availabilityId = t.availabilityId;
    if (obj.skuId !== undefined && t.skuId) obj.skuId = t.skuId;
    return 1;
  }

  function swapOrdersJson(bodyStr, g, t) {
    let o;
    try { o = JSON.parse(bodyStr); } catch (e) { return null; }
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
    // 必须主号 safety 场景
    const d = {};
    bodyStr.split('&').forEach(p => {
      const i = p.indexOf('='); if (i < 0) return;
      d[unq(p.slice(0, i))] = p.slice(i + 1);
    });
    const caller = d['callerApplicationId'] ? unq(d['callerApplicationId']) : '';
    const scen = d['scenario'] ? unq(d['scenario']) : '';
    if (caller !== 'AMCFamilySafetyApp' && scen !== 'parentApproval') return null;
    if (d['products'] === undefined) return null;

    let arr;
    try { arr = JSON.parse(unq(d['products'])); } catch (e) { return null; }
    if (!Array.isArray(arr)) return null;

    let cn = 0;
    arr.forEach(it => { cn += swapOne(it, g, t); });
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
    if (!t.availabilityId) {
      log('内购缺 availabilityId，跳过替换（防404）');
      return null;
    }

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
    // family/api/product 是审批页展示，绝不替换
    return null;
  }

  // ============================================================
  // Hook fetch
  // ============================================================
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        let body = init && init.body;

        // 采集
        if (/cart\.production\.store-web\.dynamics\.com\/.*\/cart\/(loadCart|addItems|add)/.test(url) && typeof body === 'string') {
          handleCapture(body);
        }

        // 替换
        if (typeof body === 'string' && /(users\/me\/orders|buynowui\/buynow)/.test(url)) {
          const nb = maybeSwap(url, body);
          if (nb) init = Object.assign({}, init, { body: nb });
        }
      } catch (e) { log('fetch hook error', e); }
      return origFetch.apply(this, arguments.length > 1 ? [input, init] : [input]);
    };
  }

  // ============================================================
  // Hook XMLHttpRequest
  // ============================================================
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__xfgUrl = String(url); } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__xfgUrl || '';
      if (/cart\.production\.store-web\.dynamics\.com\/.*\/cart\/(loadCart|addItems|add)/.test(url) && typeof body === 'string') {
        handleCapture(body);
      }
      if (typeof body === 'string' && /(users\/me\/orders|buynowui\/buynow)/.test(url)) {
        const nb = maybeSwap(url, body);
        if (nb) body = nb;
      }
    } catch (e) { log('xhr hook error', e); }
    return origSend.call(this, body);
  };

  // ============================================================
  // 菜单命令
  // ============================================================
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('查看已采集 ID', () => {
        const g = store.get(KEY_GAME), t = store.get(KEY_IAP);
        notify('已采集', '游戏: ' + (g ? g.productId : '无'), '内购: ' + (t ? t.productId + ' / ' + t.availabilityId : '无'));
      });
      GM_registerMenuCommand('清空已采集 ID', () => {
        store.del(KEY_GAME); store.del(KEY_IAP); store.del(KEY_LOCK);
        notify('已清空', 'idsGame / idsIAP / 锁定 已重置', '请重新加购游戏与内购');
      });
      GM_registerMenuCommand('导出 ID（复制到剪贴板）', () => {
        const g = store.get(KEY_GAME), t = store.get(KEY_IAP);
        const txt = JSON.stringify({ game: g, iap: t });
        try { navigator.clipboard.writeText(txt); } catch (e) {}
        prompt('已复制，可粘贴到另一台浏览器：', txt);
      });
      GM_registerMenuCommand('导入 ID（粘贴字符串）', () => {
        const raw = prompt('粘贴导出的 JSON：');
        if (!raw) return;
        try {
          const o = JSON.parse(raw);
          if (o.game) store.set(KEY_GAME, o.game);
          if (o.iap) store.set(KEY_IAP, o.iap);
          if (o.game && o.iap) store.set(KEY_LOCK, true);
          notify('已导入', '游戏: ' + (o.game && o.game.productId), '内购: ' + (o.iap && o.iap.productId));
        } catch (e) { notify('导入失败', 'JSON 格式不对', ''); }
      });
      GM_registerMenuCommand('解除锁定（允许重新采集）', () => {
        store.del(KEY_LOCK);
        notify('已解除锁定', '可重新加购覆盖', '');
      });
    }
  } catch (e) {}

  log('injected, ready. game=', store.get(KEY_GAME), 'iap=', store.get(KEY_IAP));
})();
