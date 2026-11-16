// ==UserScript==
// @name         Xbox 家庭组内购送礼（网页版）
// @namespace    https://github.com/theslugger/xbox-family-gift
// @version      4.9.4
// @description  子号加购游戏/内购 → 子号发起 → 主号 family safety 批准 → 付款时换成内购。需授权码激活（4.9.4：市场完全取自②内购页 + iframe 不重复显示面板）
// @author       theslugger
// @updateURL    https://raw.githubusercontent.com/theslugger/xbox-family-gift/main/web/xbox-family-gift.user.js
// @downloadURL  https://raw.githubusercontent.com/theslugger/xbox-family-gift/main/web/xbox-family-gift.user.js
// @match        https://www.xbox.com/*
// @match        https://www.microsoft.com/*
// @match        https://account.microsoft.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      xbox.aappe.uk
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
  // 授权（服务端校验，核心逻辑不在本地）
  // ============================================================
  const KEY_LICENSE = 'xfg_license';
  const KEY_GIFT    = 'xfg_giftId';
  const SERVER_BASE = 'https://xbox.aappe.uk';

  let licenseState = { valid: false, remaining: 0, checkedAt: 0, reason: '' };

  function getLicense() {
    const v = store.get(KEY_LICENSE);
    return v && typeof v === 'object' && v.code ? v : null;
  }
  function setLicense(code) {
    store.set(KEY_LICENSE, { code: String(code || '').toUpperCase().trim(), at: Date.now() });
    store.del(KEY_PLAN); planState = null;
  }
  function clearLicense() { store.del(KEY_LICENSE); store.del(KEY_PLAN); planState = null; }

  /** 服务端校验（不扣次） */
  async function verifyLicense(code) {
    const c = code || (getLicense() || {}).code;
    if (!c) return { ok: false, error: '未设置授权码' };
    try {
      const r = await fetch(SERVER_BASE + '/api/license/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: c })
      });
      const j = await r.json();
      if (!j.ok) return { ok: false, error: j.error || '授权无效', reason: j.reason };
      licenseState = { valid: true, remaining: j.data.remaining, checkedAt: Date.now(), reason: '' };
      return { ok: true, remaining: j.data.remaining, total: j.data.total };
    } catch (e) {
      return { ok: false, error: '无法连接授权服务: ' + e.message };
    }
  }

  /** 一次完整赠礼扣 1 次；giftId 幂等 */
  async function consumeLicense(giftId, ctx) {
    const c = (getLicense() || {}).code;
    if (!c) return { ok: false, error: '未设置授权码' };
    try {
      const r = await fetch(SERVER_BASE + '/api/license/consume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: c,
          giftId: giftId || '',
          market: (ctx && ctx.market) || '',
          iap: (ctx && ctx.iap) || '',
          game: (ctx && ctx.game) || ''
        })
      });
      const j = await r.json();
      if (!j.ok) return { ok: false, error: j.error || '扣次失败', reason: j.reason };
      licenseState.valid = true;
      licenseState.remaining = j.data.remaining;
      return { ok: true, remaining: j.data.remaining, dedup: !!j.data.dedup };
    } catch (e) {
      return { ok: false, error: '无法连接授权服务: ' + e.message };
    }
  }

  /** 本次赠礼的幂等键：同一次流程用同一个 */
  function currentGiftId() {
    let g = store.get(KEY_GIFT);
    if (g && typeof g === 'string') return g;
    return '';
  }
  function newGiftId() {
    const g = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    store.set(KEY_GIFT, g);
    return g;
  }
  function clearGiftId() { store.del(KEY_GIFT); }

  /** 静默校验：有码就在后台验一次 */
  async function backgroundVerify() {
    const lic = getLicense();
    if (!lic) return;
    const r = await verifyLicense(lic.code);
    if (!r.ok) {
      licenseState = { valid: false, remaining: 0, checkedAt: Date.now(), reason: r.reason || 'invalid' };
      toast('⚠️ 授权异常', r.error || '请重新输入授权码');
    } else {
      licenseState = { valid: true, remaining: r.remaining, checkedAt: Date.now(), reason: '' };
    }
    refreshPanel();
  }

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

  /**
   * 面板只在主控页面显示。
   * 付款 iframe / 批准对话框里会重复注入脚本，但那里不需要面板
   * （HAR：buynow 是 sec-fetch-dest=iframe 的 document，
   *  批准请求跑在 account.microsoft.com 的父页面）。
   */
  function shouldShowPanel() {
    try {
      // 1) iframe 里一律不显示
      if (window.top !== window.self) return false;
      // 2) 付款页不显示
      if (/\/store\/purchase\/buynowui\/buynow/i.test(location.href)) return false;
      // 3) 批准对话框（family 页内的 modal iframe 会在上面被 1) 挡掉）
      return true;
    } catch (e) { return false; }
  }

  function buildPanel() {
    if (panelEl || !document.body) return;
    if (!shouldShowPanel()) { log('非主控页面，不显示面板'); return; }
    panelEl = document.createElement('div');
    panelEl.id = 'xfg-panel';
    panelEl.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;width:330px;' +
      'background:#0b0b0b;color:#eee;border:1px solid #107C10;border-radius:10px;' +
      'font:12px/1.45 -apple-system,Segoe UI,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden';

    panelEl.innerHTML =
      '<div id="xfg-hd" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#107C10;cursor:pointer">' +
        '<b>Xbox 送礼脚本 v4.9.4</b><span style="font-size:10px;opacity:.8">' + location.host + '</span><span id="xfg-tg" style="margin-left:8px">收起</span>' +
      '</div>' +
      '<div id="xfg-bd" style="padding:10px">' +
        '<div id="xfg-state" style="margin-bottom:8px"></div>' +
        '<div id="xfg-log" style="max-height:150px;overflow:auto;background:#000;border-radius:6px;padding:6px;' +
          'font:11px/1.4 ui-monospace,Menlo,monospace;color:#9c9;white-space:pre-wrap"></div>' +
        '<div style="margin-top:8px;display:flex;gap:6px">' +
          '<button id="xfg-grab1" style="flex:1;padding:6px;background:#0d2a0d;color:#7fd;border:1px solid #2a5;border-radius:6px;cursor:pointer">获取①游戏ID</button>' +
          '<button id="xfg-del1" style="flex:0 0 54px;padding:6px;background:#2a0d0d;color:#f99;border:1px solid #633;border-radius:6px;cursor:pointer">删除</button>' +
        '</div>' +
        '<div style="margin-top:6px;display:flex;gap:6px">' +
          '<button id="xfg-grab2" style="flex:1;padding:6px;background:#0d2a0d;color:#7fd;border:1px solid #2a5;border-radius:6px;cursor:pointer">获取②内购ID</button>' +
          '<button id="xfg-del2" style="flex:0 0 54px;padding:6px;background:#2a0d0d;color:#f99;border:1px solid #633;border-radius:6px;cursor:pointer">删除</button>' +
        '</div>' +
        '<div style="margin-top:6px;display:flex;gap:6px">' +
          '<button id="xfg-lic" style="flex:1;padding:5px;background:#2a1a3a;color:#c8f;border:1px solid #536;border-radius:6px;cursor:pointer">授权</button>' +
          '<button id="xfg-clear" style="flex:1;padding:5px;background:#3a1a1a;color:#f99;border:1px solid #633;border-radius:6px;cursor:pointer">全部清空</button>' +
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
    panelEl.querySelector('#xfg-clear').addEventListener('click', function () {
      store.del(KEY_GAME); store.del(KEY_IAP); store.del(KEY_LOCK);
      clearApproved(); store.del(KEY_ORDER_QUEUE); store.del(KEY_PLAN);
      logLines = []; refreshPanel(); panelAdd('已清空 idsGame/idsIAP/approved/orderQueue/plan');
    });
    panelEl.querySelector('#xfg-grab1').addEventListener('click', function () { grabTo('game'); });
    panelEl.querySelector('#xfg-grab2').addEventListener('click', function () { grabTo('iap'); });
    panelEl.querySelector('#xfg-del1').addEventListener('click', function () { clearSlot('game'); });
    panelEl.querySelector('#xfg-del2').addEventListener('click', function () { clearSlot('iap'); });
    panelEl.querySelector('#xfg-lic').addEventListener('click', async function () {
      var cur = getLicense();
      var raw = prompt(
        '输入授权码（格式 XXXX-XXXX-XXXX-XXXX）：\n' +
        (cur ? '\n当前：' + String(cur.code).slice(-4) + ' 结尾\n' : '') +
        '\n留空并确认 = 清除当前授权',
        ''
      );
      if (raw === null) return;
      raw = raw.trim();
      if (!raw) {
        clearLicense();
        licenseState = { valid: false, remaining: 0, checkedAt: 0, reason: '' };
        panelAdd('授权已清除');
        refreshPanel();
        return;
      }
      panelAdd('正在校验授权码…');
      setLicense(raw);
      var r = await verifyLicense();
      if (!r.ok) {
        clearLicense();
        panelAdd('❌ ' + r.error);
        toast('授权失败', r.error || '');
      } else {
        panelAdd('✅ 授权成功，剩余 ' + r.remaining + ' 次');
        toast('授权成功', '剩余 ' + r.remaining + ' 次');
      }
      refreshPanel();
    });

    refreshPanel();
    panelAdd('脚本已注入页面世界(@grant none)');
  }

  // ============================================================
  // 【手动抓取】直接读当前页面 URL 里的 productId
  //   /es-ar/games/store/<slug>/<12 位 productId>
  //   /es-ar/p/<slug>/<12 位 productId>
  //   /es-ar/p/<12 位 productId>
  // 用户点「获取①/获取②」时，把当前页的 ID 记到对应槽位。
  // ============================================================
  function pidFromUrl() {
    var u = location.href;
    var m = u.match(/\/store\/(?:apps|pdp|games)\/[^/]*\/([A-Z0-9]{12})\b/i);
    if (m) return m[1].toUpperCase();
    m = u.match(/\/p\/([A-Z0-9]{12})\b/i);
    if (m) return m[1].toUpperCase();
    m = u.match(/\/store\/apps\/([A-Z0-9]{12})\b/i);
    if (m) return m[1].toUpperCase();
    // 兜底：URL 里任意 12 位大写字母数字段
    m = u.match(/\b([A-Z0-9]{12})\b/);
    if (m && /[0-9]/.test(m[1]) && /[A-Z]/.test(m[1])) return m[1];
    return '';
  }

  /** 抓当前页 ID 并写入指定槽位（'game' | 'iap'） */
  function grabTo(slot) {
    var pid = pidFromUrl();
    if (!pid) {
      panelAdd('❌ 当前页面 URL 里没有商品 ID，请先打开商店页面');
      notify('获取失败', '当前 URL 无 productId', location.pathname);
      return false;
    }
    var key = slot === 'game' ? KEY_GAME : KEY_IAP;
    var old = store.get(key);
    if (old && old.productId === pid) {
      panelAdd('ℹ️ ' + (slot === 'game' ? '①' : '②') + ' 已经是 ' + pid);
      return true;
    }
    // 抓到 ID 时，把「当前页面所在市场」记进这个槽位。
    // ② 的市场就是最终结算市场，后续 plan 全部按它来。
    var pageMk = inferPageMarket() || manualMarket() || '';
    store.set(key, {
      productId: pid,
      availabilityId: (old && old.availabilityId) || '',
      skuId: (old && old.skuId) || '0010',
      market: pageMk,
      locale: ''
    });
    if (slot === 'iap' && pageMk) {
      store.set('xfg_iapMarket', pageMk);   // ② 专属市场记录
    }
    panelAdd('✅ 已获取' + (slot === 'game' ? '① 游戏' : '② 内购') + ': ' + pid);
    notify('✅ 已获取' + (slot === 'game' ? '① 游戏' : '② 内购'), pid, '来自当前页面 URL');
    // 两个都有就锁定并拉 plan
    var g = store.get(KEY_GAME), t = store.get(KEY_IAP);
    if (g && g.productId && t && t.productId) {
      store.set(KEY_LOCK, true);
      panelAdd('🔒 ①② 齐备，向服务端请求替换目标');
      try { fetchPlan(); } catch (e) {}
    }
    refreshPanel();
    return true;
  }

  /** 清掉某个槽位（可重来） */
  function clearSlot(slot) {
    store.del(slot === 'game' ? KEY_GAME : KEY_IAP);
    store.del(KEY_LOCK);
    store.del(KEY_PLAN);
    planState = null;
    panelAdd('已删除' + (slot === 'game' ? '① 游戏' : '② 内购') + '，可重新获取');
    refreshPanel();
  }

  /** 按钮获取到 ID 后直接显示 ID；未获取时显示「获取…」 */
  function updateButtons() {
    if (!panelEl) return;
    var g = store.get(KEY_GAME), t = store.get(KEY_IAP);

    var b1 = panelEl.querySelector('#xfg-grab1');
    if (b1) {
      if (g && g.productId) {
        b1.textContent = '① ' + g.productId;
        b1.title = '点击可覆盖为当前页面 ID（' + g.productId + '）';
        b1.style.background = '#12401a';
        b1.style.color = '#8fff9f';
        b1.style.fontFamily = 'ui-monospace,Menlo,monospace';
        b1.style.fontSize = '12.5px';
        b1.style.fontWeight = '700';
        b1.style.letterSpacing = '.5px';
        b1.style.borderColor = '#2f7a3a';
      } else {
        b1.textContent = '获取①游戏ID';
        b1.title = '打开游戏页面后点击';
        b1.style.cssText = b1.style.cssText.replace(/background:[^;]+;/, 'background:#0d2a0d;')
          .replace(/color:[^;]+;/, 'color:#7fd;');
        b1.style.background = '#0d2a0d';
        b1.style.color = '#7fd';
        b1.style.fontFamily = '';
        b1.style.fontSize = '';
        b1.style.fontWeight = '';
        b1.style.letterSpacing = '';
        b1.style.borderColor = '#2a5';
      }
    }

    var b2 = panelEl.querySelector('#xfg-grab2');
    if (b2) {
      if (t && t.productId) {
        b2.textContent = '② ' + t.productId;
        b2.title = '点击可覆盖为当前页面 ID（' + t.productId + '）';
        b2.style.background = '#12401a';
        b2.style.color = '#8fff9f';
        b2.style.fontFamily = 'ui-monospace,Menlo,monospace';
        b2.style.fontSize = '12.5px';
        b2.style.fontWeight = '700';
        b2.style.letterSpacing = '.5px';
        b2.style.borderColor = '#2f7a3a';
      } else {
        b2.textContent = '获取②内购ID';
        b2.title = '打开金币页面后点击';
        b2.style.background = '#0d2a0d';
        b2.style.color = '#7fd';
        b2.style.fontFamily = '';
        b2.style.fontSize = '';
        b2.style.fontWeight = '';
        b2.style.letterSpacing = '';
        b2.style.borderColor = '#2a5';
      }
    }
  }

  function refreshPanel() {
    if (!panelEl) return;
    var st = panelEl.querySelector('#xfg-state');
    if (!st) return;
    var g = store.get(KEY_GAME), t = store.get(KEY_IAP), lk = store.get(KEY_LOCK);
    var m = planMeta();
    var iapTitle = (m && m.iap && m.iap.title) ? m.iap.title : '';
    var iapPrice = (m && m.iap && m.iap.price) ? (m.iap.price + ' ' + (m.iap.currency || '')) : '';

    function slotLine(label, rec, title, price, hint) {
      var has = !!(rec && rec.productId);
      var bg = has ? '#0e2f12' : '#2f1212';
      var bd = has ? '#2f7a3a' : '#7a2f2f';
      return '<div style="padding:7px 9px;border-radius:7px;background:' + bg + ';border:1px solid ' + bd + ';margin-bottom:6px">' +
        '<div style="color:#9fe6a8;font-weight:700;font-size:11px;letter-spacing:.5px">' + label + '</div>' +
        (has
          ? '<div style="color:#fff;font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:700;letter-spacing:.6px;margin-top:2px;line-height:1.3">' + esc(rec.productId) + '</div>'
            + (title ? '<div style="color:#8fe;font-size:11.5px;font-weight:600;margin-top:1px">' + esc(title) + (price ? ' · ' + esc(price) : '') + '</div>' : '')
            + '<div style="color:#7a8;font-size:10.5px;margin-top:1px">sku ' + esc(rec.skuId || '-') + (rec.market ? ' · ' + esc(rec.market) : '') + '</div>'
          : '<div style="color:#f88;font-size:11.5px;margin-top:2px">' + hint + '</div>')
        + '</div>';
    }

    st.innerHTML =
      slotLine('① 游戏（会被替换掉）', g, '', '', '未获取 — 打开游戏页，点下方「获取①游戏ID」') +
      slotLine('② 内购（最终买这个）', t, iapTitle, iapPrice, '未获取 — 打开金币页，点下方「获取②内购ID」') +
      (function () {
        var pt = planTarget();
        if (!pt) return '<div style="color:#888;font-size:11px;margin-top:2px">替换目标：等待服务端计算</div>';
        return '<div style="color:#8fe;font-size:11.5px;font-weight:600;margin-top:2px">替换目标：'
             + esc(pt.productId) + ' / ' + esc(pt.availabilityId) + '</div>';
      })() +
      '<div style="margin-top:5px;font-size:11px;color:#aaa">状态：'
        + (lk ? '<b style="color:#ff0">🔒 已锁定</b>' : '待获取')
        + (isApproved() ? ' · <b style="color:#7fd">已批准</b>' : ' · 待批准')
      + '</div>' +
      (function () {
        var lic = getLicense();
        if (!lic) return '<div style="margin-top:2px;font-size:11px;color:#f88">授权：未激活</div>';
        if (!licenseState.valid) return '<div style="margin-top:2px;font-size:11px;color:#f88">授权：校验中/异常</div>';
        return '<div style="margin-top:2px;font-size:11px;color:#7fd">授权：剩余 <b>' + licenseState.remaining + '</b> 次</div>';
      })();
    updateButtons();
  }

  // ============================================================
  // 采集
  // ============================================================
  /**
   * 从请求/响应体里提取商品
   * exact=true 表示这是「本次加购」的精确集合（来自 itemsToAdd），可以放心记录
   * exact=false 表示是整个购物车快照，只能用来补齐缺失项
   */
  function collectItems(bodyStr, fromRequest) {
    let o; try { o = JSON.parse(bodyStr); } catch (e) { return { items: [], exact: false }; }
    if (!o) return { items: [], exact: false };
    var mk = o.market || '', lc = o.locale || '';
    let arr = null, exact = false;

    if (o.itemsToAdd && Array.isArray(o.itemsToAdd.items) && o.itemsToAdd.items.length) {
      arr = o.itemsToAdd.items; exact = true;          // 请求体：本次加购的精确商品
    } else if (fromRequest && Array.isArray(o.items) && o.items.length) {
      arr = o.items; exact = true;                      // 请求体里的 items
    } else if (o.cart && Array.isArray(o.cart.lineItems)) {
      arr = o.cart.lineItems;                           // loadCart 响应
    } else if (Array.isArray(o.items)) {
      arr = o.items;
    } else if (Array.isArray(o.lineItems)) {
      arr = o.lineItems;
    }
    if (!arr) return { items: [], exact: false };

    const out = [];
    for (const it of arr) {
      const pid = it && (it.productId || it.ProductId);
      const sid = it && (it.skuId || it.SkuId);
      const aid = it && (it.availabilityId || it.AvailabilityId || '');
      const kind = it && (it.productKind || it.ProductKind || it.productType || '');
      if (pid && sid) {
        var rec = { productId: pid, availabilityId: aid, skuId: sid, market: mk, locale: lc };
        if (kind) rec.productKind = kind;
        out.push(rec);
      }
    }
    return { items: out, exact };
  }
  function fullId(a) { return !!(a && a.productId && a.availabilityId && a.skuId); }
  function sameProduct(a, b) { return !!(a && b && a.productId === b.productId); }

  function handleCapture(bodyStr, fromRequest) {
    const r = collectItems(bodyStr, fromRequest);
    log('handleCapture exact=' + r.exact + ' items=' + r.items.length);
    handleCaptureItems(r.items, r.exact ? 'request' : 'response');
  }

  /**
   * 记录规则（不再靠"购物车里有几个"来猜）：
   *   exact=true（请求体 itemsToAdd）：这就是本次加购的商品，一定记录
   *   exact=false（购物车快照）：只用来补齐「还缺的那一个」，且跳过已记录的游戏
   *   已锁定后只做命中提示，不覆盖
   */
  function handleCaptureItems(items, source) {
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

    const exact = source === 'request';

    // 商品类型与市场规则由服务端 plan 处理。

    for (const ids of items) {
      if (game && sameProduct(game, ids)) {
        if (!fullId(game) || game.availabilityId !== ids.availabilityId || game.skuId !== ids.skuId) {
          store.set(KEY_GAME, ids); game = ids;
          notify('①【游戏】ID已更新', ids.productId, 'avail:' + ids.availabilityId);
        } else notify('①【游戏】命中', ids.productId, 'avail:' + ids.availabilityId);
        continue;
      }
      if (iap && sameProduct(iap, ids)) {
        if (!fullId(iap) || iap.availabilityId !== ids.availabilityId || iap.skuId !== ids.skuId) {
          store.set(KEY_IAP, ids); iap = ids;
          notify('②【内购】ID已更新', ids.productId, 'avail:' + ids.availabilityId);
        } else notify('②【内购】命中', ids.productId, 'avail:' + ids.availabilityId);
        continue;
      }

      if (!game) {
        store.set(KEY_GAME, ids); game = ids;
        notify('①【游戏】已记录', ids.productId, 'avail:' + ids.availabilityId);
        continue;
      }
      if (!iap) {
        if (!exact && game && sameProduct(game, ids)) continue;
        store.set(KEY_IAP, ids); iap = ids;
        notify('②【内购】已记录', ids.productId, 'avail:' + ids.availabilityId);
        continue;
      }

      if (exact) notify('⚠️ 采集已满', ids.productId, '如需重来请点「清空」');
    }

    if (game && iap && fullId(game) && fullId(iap)) {
      store.set(KEY_LOCK, true);
      notify('🔒 已锁定采集结果', '游戏+内购齐备', '付款时将自动替换为内购');
      try { autoAlignCaptured(); } catch (e) { log('autoAlign err', e); }
      // 4.7.0：①② 齐备 → 立刻向服务端要改写指令
      try { fetchPlan(); } catch (e) { log('fetchPlan err', e); }
    }
    refreshPanel();
  }

  // ============================================================
  // 4.7.0：所有 availabilityId / Gift 档 / 市场归属的表都移到服务端。
  // 本地不再持有任何产品 ID，下面这些函数只为兼容旧调用点保留空实现。
  // ============================================================
  function marketOfAvail(aid) { return ''; }

  // ============================================================
  // 【4.7.0 核心】改写指令（plan）—— 业务规则全在服务端
  // ------------------------------------------------------------
  // 脚本只做三件事：
  //   1. 把面板采集到的 ①② productId 发给 /api/plan
  //   2. 缓存服务端返回的 ops = [{scope, match, set, fallback}]
  //   3. 按 ops 覆盖字段（不理解语义，也不知道该换成什么）
  // ============================================================
  const KEY_PLAN = 'xfg_plan';
  let planState = null;      // { ops, meta, sig, at }
  let planPending = null;    // 进行中的请求

  /** 页面路径 / URL 参数里的市场，如 /es-ar/ → AR、?market=AR */
  function inferPageMarket() {
    try {
      // 1) 路径里的地区前缀 /es-ar/ /en-us/
      var m = (location.pathname || '').match(/\/([a-z]{2})-([a-z]{2})(\/|$)/i);
      if (m) {
        var mk = normMarket(m[1].toUpperCase() + m[2].toUpperCase());
        if (mk) return mk;
      }
      // 2) URL 参数 market=
      var q = (location.search || '').match(/[?&]market=([A-Za-z]{2,4})\b/);
      if (q) {
        var mk2 = normMarket(q[1]);
        if (mk2) return mk2;
      }
      // 3) 路径末尾的两字母地区 /es-ar 已在 1) 覆盖；再兜 hreflang 等 meta
      try {
        var alt = document.querySelector('link[hreflang]');
        if (alt) {
          var hl = normMarket(alt.getAttribute('hreflang') || '');
          if (hl) return hl;
        }
      } catch (e) {}
      // 4) html lang 属性 zh-CN / es-AR
      try {
        var lang = normMarket(document.documentElement.lang || '');
        if (lang) return lang;
      } catch (e) {}
    } catch (e) {}
    return '';
  }

  /**
   * 决定向服务端请求哪个市场：
   *   1. 内购记录自带 market（抓 ID 时记下的）
   *   2. 游戏记录自带 market
   *   3. 手动设定的市场
   *   4. 当前页面路径
   *   5. 上次成功用过的市场（KEY_MARKET 兜底）
   *   6. 'AR'
   * 只有拿到 plan 成功后才会把市场写回 KEY_MARKET。
   */
  function resolvePlanMarket(g, t) {
    // 市场只认 ② 内购：用户在哪添加这个内购，就用哪个市场
    return normMarket((t && t.market) || '')
        || normMarket(store.get('xfg_iapMarket') || '')
        || manualMarket()
        || inferPageMarket()
        || 'AR';
  }

  function planKeyOf() {
    var g = store.get(KEY_GAME), t = store.get(KEY_IAP);
    var lc = getLicense();
    if (!g || !t || !g.productId || !t.productId || !lc) return '';
    var mk = resolvePlanMarket(g, t);
    return [String(g.productId).toUpperCase(), String(t.productId).toUpperCase(), mk, lc.code].join('|');
  }

  function cachedPlan() {
    var e = store.get(KEY_PLAN);
    if (!e || !e.key || !Array.isArray(e.ops)) return null;
    if (e.key !== planKeyOf()) return null;
    if (Date.now() - (e.at || 0) > (e.ttl || 600) * 1000) return null;
    return e;
  }

  /** 向服务端要 ops（带 Promise 去重） */
  function fetchPlan() {
    var key = planKeyOf();
    if (!key) {
      log('[plan] 缺少 ①② 或授权码，跳过请求');
      return Promise.resolve(null);
    }
    var hit = cachedPlan();
    if (hit) return Promise.resolve(hit);
    if (planPending) return planPending;

    var g = store.get(KEY_GAME), t = store.get(KEY_IAP), lc = getLicense();
    // 市场兜底顺序：内购记录 → 游戏记录 → 手动设定 → 页面路径 → 'AR'
    var mk = resolvePlanMarket(g, t);
    log('[plan] 请求市场=' + mk + ' ①=' + g.productId + ' ②=' + t.productId);
    var payload = {
      code: lc.code,
      market: mk,
      game: { productId: String(g.productId).toUpperCase(), skuId: String(g.skuId || '0010') },
      iap:  { productId: String(t.productId).toUpperCase(),  skuId: String(t.skuId || '0010') }
    };

    planPending = fetch(SERVER_BASE + '/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (o) {
        planPending = null;
        if (!o.j || !o.j.ok) {
          var msg = (o.j && o.j.error) || ('HTTP ' + o.status);
          log('[plan] ❌ 获取失败: ' + msg);
          panelAdd('❌ plan 获取失败: ' + msg);
          notify('⚠️ 替换目标获取失败', msg, '付款页将无法替换');
          return null;
        }
        if (planKeyOf() !== key) {
          log('[plan] selection changed; discard stale response');
          return fetchPlan();
        }
        var e = { key: key, ops: o.j.ops || [], meta: o.j.meta || {}, sig: o.j.sig, ttl: o.j.ttl || 600, at: Date.now() };
        store.set(KEY_PLAN, e);
        try { if (e.meta && e.meta.market) store.set('xfg_lastMarket', String(e.meta.market)); } catch (err) {}
        planState = e;
        log('[plan] 已下发 ' + e.ops.length + ' 条指令 · 内购档=' +
            ((e.meta.iap || {}).availabilityId || '?') + ' gift=' + ((e.meta.iap || {}).gift ? 'Y' : 'N'));
        refreshPanel();
        return e;
      })
      .catch(function (e) { planPending = null; log('[plan] 请求异常: ' + e.message); return null; });

    return planPending;
  }

  /**
   * 4.6.2 原版 swapOne：整条替换 productId / availabilityId / skuId
   * 差异：matchPids 来自服务端 ops 的 match 列表（不再硬编码游戏 ID）
   */
  function swapOne(obj, matchPids, tt) {
    if (!obj || !tt || !tt.productId || !tt.availabilityId) return 0;
    var pid = String(obj.productId || '').toUpperCase();
    if (matchPids && matchPids.length && matchPids.indexOf(pid) < 0) return 0;
    var keepQty = obj.quantity;
    obj.productId = tt.productId;
    obj.availabilityId = tt.availabilityId;
    if (tt.skuId) obj.skuId = String(tt.skuId);
    if (keepQty !== undefined) obj.quantity = keepQty;
    return 1;
  }

  /** 服务端 ops 里出现的所有待替换 productId */
  function planMatches(scope) {
    var plan = cachedPlan();
    if (!plan || !Array.isArray(plan.ops)) return [];
    return plan.ops
      .filter(function (o) { return o.scope === scope && o.match !== '*'; })
      .map(function (o) { return String(o.match).toUpperCase(); });
  }

  /** 服务端回传的商品信息（标题/价格），用于面板核对 */
  function planMeta() {
    var plan = cachedPlan();
    if (!plan || !plan.meta) return null;
    return plan.meta;
  }

  /**
   * 服务端下发的最终替换目标 —— 完全对应 4.6.2 里的 tt
   *   { productId, availabilityId, skuId }
   * 本地没有任何产品 ID 表，全部来自 /api/plan。
   */
  function planTarget() {
    var plan = cachedPlan();
    if (!plan || !Array.isArray(plan.ops)) return null;
    // 优先 buynow 的精确档，其次通配档
    var hit = plan.ops.filter(function (o) { return o.scope === 'buynow'; });
    if (!hit.length) hit = plan.ops.filter(function (o) { return o.scope === 'orders'; });
    if (!hit.length) return null;
    var exact = hit.filter(function (o) { return o.match !== '*'; });
    var pick = exact[0] || hit[0];
    var set = pick && pick.set;
    if (!set || !set.productId || !set.availabilityId) return null;
    return {
      productId: String(set.productId).toUpperCase(),
      availabilityId: String(set.availabilityId).toUpperCase(),
      skuId: String(set.skuId || '0010')
    };
  }

  // ============================================================
  // 市场码归一化：DisplayCatalog / purchase 只认两字母（AR/US/JP）
  // 页面路径 es-ar / zh-jp 给的是「语言-地区」，必须剥掉语言部分
  //   ES-AR -> AR,  ZH-JP -> JP,  EN-US -> US,  AR -> AR,  es_AR -> AR
  // ============================================================
  var KNOWN_MARKETS = {
    AR:'AR', US:'US', JP:'JP', TR:'TR', NG:'NG', BR:'BR', MX:'MX', CO:'CO',
    CL:'CL', PE:'PE', RU:'RU', UA:'UA', KZ:'KZ', IN:'IN', ID:'ID', MY:'MY',
    TH:'TH', VN:'VN', PH:'PH', EG:'EG', ZA:'ZA', SA:'SA', AE:'AE', PL:'PL',
    HU:'HU', CZ:'CZ', SK:'SK', RO:'RO', BG:'BG', GR:'GR', PT:'PT', ES:'ES',
    IT:'IT', DE:'DE', FR:'FR', NL:'NL', BE:'BE', AT:'AT', CH:'CH', SE:'SE',
    NO:'NO', DK:'DK', FI:'FI', IE:'IE', GB:'GB', CA:'CA', AU:'AU', NZ:'NZ',
    SG:'SG', HK:'HK', TW:'TW', KR:'KR', CN:'CN', IL:'IL', QA:'QA', KW:'KW'
  };
  function normMarket(v) {
    if (!v) return '';
    var s = String(v).toUpperCase().replace(/[^A-Z]/g, '');
    if (s.length === 2) return KNOWN_MARKETS[s] ? s : '';
    // 4 字母形如 ESAR / ZHJP：取后两位
    if (s.length === 4) {
      var tail = s.slice(2);
      if (KNOWN_MARKETS[tail]) return tail;
      var head = s.slice(0, 2);
      if (KNOWN_MARKETS[head]) return head;
    }
    return '';
  }
  // 市场 -> 页面语言前缀，用于引导用户去正确地区的页面加购
  var MARKET_LOCALE = {
    AR:'es-ar', US:'en-us', JP:'ja-jp', TR:'tr-tr', NG:'en-ng', BR:'pt-br',
    MX:'es-mx', CO:'es-co', CL:'es-cl', RU:'ru-ru', IN:'en-in', GB:'en-gb',
    CA:'en-ca', AU:'en-au', DE:'de-de', FR:'fr-fr', ES:'es-es', IT:'it-it'
  };
  /**
   * 目标市场优先级：
   *   1. 内购 availabilityId 所属地区（用户从哪加的购物，就是哪）
   *   2. 内购记录里的 market 字段
   *   3. 手动设定的 KEY_MARKET（覆盖用，一般不需要）
   *   4. 页面路径地区
   */
  function targetMarket() {
    // 1) 内购 availabilityId 反查
    var t = store.get(KEY_IAP);
    if (t && t.availabilityId) {
      var byAvail = marketOfAvail(t.availabilityId);
      if (byAvail) return byAvail;
    }
    // 2) 内购记录自带的 market
    if (t && t.market) {
      var mk = normMarket(t.market);
      if (mk) return mk;
    }
    // 3) 手动覆盖
    var manual = normMarket(store.get(KEY_MARKET));
    if (manual) return manual;
    // 4) 页面
    return pageMarket();
  }

  /** 手动设定的市场（仅用于提示，不再强制） */
  function manualMarket() { return normMarket(store.get(KEY_MARKET)); }
  function pageMarket() { var im = inferMarket(); return im ? im.market : ''; }

  // 把 availabilityId 归一到目标市场，避免跨市场 404
  // 4.7.0：市场对齐由服务端补齐，本地原样返回
  function alignAvail(t, orderMarket) { return t; }
  function _alignAvailLegacy(t, orderMarket) {
    if (!t || !t.productId) return t;
    var mk = normMarket(orderMarket);
    if (!mk) return t;
    var m = AVAIL_BY_MARKET[String(t.productId).toUpperCase()];
    if (!m) return t;
    var want = giftAvailFor(t.productId, mk) || m[mk];
    if (!want || want === t.availabilityId) return t;
    var out = { productId: t.productId, availabilityId: want, skuId: t.skuId, market: mk };
    log('availabilityId 按市场归一: ' + t.availabilityId + ' -> ' + want + ' (' + mk + ')');
    return out;
  }

  // 校验一组 ID 是否属于目标市场；返回 {ok, bad:[{which, aid, real}]}
  function checkMarket(ids, tgt) {
    var mk = normMarket(tgt);
    if (!mk) return { ok: true, bad: [] };
    var bad = [];
    ids.forEach(function (p) {
      if (!p || !p.id || !p.id.availabilityId) return;
      // 优先查静态表；查不到就看该 ID 的 market 字段
      var real = marketOfAvail(p.id.availabilityId) || normMarket(p.id.market);
      if (real && real !== mk) bad.push({ which: p.which, aid: p.id.availabilityId, real: real });
    });
    return { ok: bad.length === 0, bad: bad };
  }

  function swapOrdersJson(bodyStr, g, t) {
    let o; try { o = JSON.parse(bodyStr); } catch (e) { return null; }
    var tt = planTarget();
    if (!tt) return null;
    var matches = planMatches('orders');
    var n = 0;
    (function walk(x) {
      if (x === null || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      n += swapOne(x, matches, tt);
      for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k)) walk(x[k]);
    })(o);
    if (!n) return null;
    return { body: JSON.stringify(o), n: n };
  }
  // ============================================================
  // 4.7.0：商品类别识别（Game / Consumable）已移到服务端。
  // 本地不再请求 DisplayCatalog，也不再判断 ①② 是否放反，
  // 服务端 /api/plan 会直接给出最终字段，脚本只执行。
  // ============================================================
  function kindOf(ids) { return ''; }
  function checkKindOrder(g, t) { return { ok: true, pending: true }; }

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

    // ---- 4.6.2 的替换：tt 来自服务端 plan，本地不持有任何 ID 表 ----
    const tt = planTarget();
    if (!tt) { log('[buynow] 服务端未下发替换目标，保持原样'); return null; }

    const matches = planMatches('buynow');
    let n = 0;
    arr.forEach(it => { n += swapOne(it, matches, tt); });
    if (!n) {
      // 首项已经不是游戏（例如页面已用内购）→ 整条强制覆盖成内购
      arr = [{ productId: tt.productId, skuId: tt.skuId, availabilityId: tt.availabilityId }];
      n = 1;
      log('[buynow] 首项非游戏 → 整条覆盖为内购');
    }

    const tgt = targetMarket();
    const parts = bodyStr.split('&').map(p => {
      const i = p.indexOf('='); if (i < 0) return p;
      const k = unq(p.slice(0, i));
      if (k === 'products') return p.slice(0, i) + '=' + qq(JSON.stringify(arr));
      if (k === 'market' && tgt) return p.slice(0, i) + '=' + qq(tgt);
      return p;
    });
    return { body: parts.join('&'), n: n };
  }
  // ============================================================
  // 4.7.0：市场和 availability 解析全部由服务端 /api/plan 完成。
  // 这些兼容函数不再请求 DisplayCatalog，也不再改变已采集 ID。
  function resolveCached() { return null; }
  function resolveItem() { return Promise.resolve(null); }
  function autoAlignCaptured() { return Promise.resolve(null); }
  function checkMarket() { return { ok: true, bad: [] }; }
  function guardMarket() { return true; }

  // ============================================================
  // 批准标记（对照手机端稳定的 approve_flag.js）：
  //   手机端之所以稳，是因为它把「主号已批准」当成一个明确状态：
  //     钩 account.microsoft.com/family/api/buy/requests/approve → 写 approvedTime
  //     swap_payment 只在 approvedTime 存在时才换 orders
  //   网页端原来用「buynow 表单里有 purchaseOrderId」当判据，
  //   但 HAR 里 4.5.4 起 orders 一律不换，等于把手机端的关键动作丢了。
  //   这里恢复同样语义：approve 一落地就打标记，orders/buynow 都看它。
  // ============================================================
  // ------------------------------------------------------------
  // 网页端跨域问题的正解：本脚本 @grant GM_* → 有 Tampermonkey 跨域存储；
  // @grant none 的旧构建会退回 localStorage，那一份是不跨域的。
  // 所以批准标记必须走「多通道」：
  //   1) GM 跨域存储（主通道，account 域写、www 域读得到）
  //   2) 同域 localStorage + cookie（兜底，account 域内 orders 用）
  //   3) window.name 不跨标签，跳过
  // ------------------------------------------------------------
  const KEY_APPROVED = 'xfg_approvedTime';
  const KEY_APPROVED_TS = 'approvedTime';

  function hasGM() { return typeof GM_setValue === 'function' && typeof GM_getValue === 'function'; }
  function setCookie(k, v) {
    try {
      var host = location.hostname.split('.').slice(-2).join('.');
      document.cookie = k + '=' + encodeURIComponent(String(v)) + '; path=/; domain=.' + host + '; max-age=86400; Secure; SameSite=None';
    } catch (e) {}
  }
  function getCookie(k) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  function markApproved() {
    var now = Date.now();
    try { store.set(KEY_APPROVED, now); } catch (e) {}
    try { store.set(KEY_APPROVED_TS, now); } catch (e) {}
    setCookie('xfg_appr', now);
    log('[approve] 打标 now=' + now + ' GM=' + (hasGM() ? 'YES' : 'NO') + ' host=' + location.host);
  }
  function approvedAt() {
    var a = Number(store.get(KEY_APPROVED)) || 0;
    var b = Number(store.get(KEY_APPROVED_TS)) || 0;
    var c = Number(getCookie('xfg_appr')) || 0;
    return Math.max(a, b, c);
  }
  // 只看「是否发生过批准」，不再按 30 分钟裁剪：
  // 网页端 approve 在 account 标签、buynow 在 www 标签，
  // 时间窗一旦跨标签读不到就会误判成「未批准」，这正是这次的故障点。
  function isApproved() { return approvedAt() > 0; }
  function clearApproved() {
    store.del(KEY_APPROVED); store.del(KEY_APPROVED_TS);
    try {
      var host = location.hostname.split('.').slice(-2).join('.');
      document.cookie = 'xfg_appr=; path=/; domain=.' + host + '; max-age=0';
    } catch (e) {}
  }

  // ------------------------------------------------------------
  // 兜底推断：网页端点「批准」不一定走 /family/api/buy/requests/approve
  // （HAR 里那个接口是有的，但有的账号走的是另一条「允许一次购买」的路径）。
  // 只要出现下面任一信号，就认为已进入最终付款阶段：
  //   a) approve 接口命中（主通道，精确）
  //   b) 出现带 purchaseOrderId 的 buynow 表单（说明订单已被批准并建好）
  //   c) 主号页面出现批准成功提示（DOM 兜底）
  // ------------------------------------------------------------
  function isFinalPayStage(poid) {
    return isApproved() || !!(poid && String(poid).trim());
  }
  function inferApprovedFromDom() {
    if (isApproved()) return;
    try {
      var txt = (document.body && document.body.innerText) || '';
      if (/已批准|批准成功|Approved|购买已批准|批准此购买|allow this purchase/i.test(txt)) {
        // 只在 family 页面才采信，避免商品页文案误触
        if (/account\.microsoft\.com\/family/i.test(location.href) || location.hostname === 'account.microsoft.com') {
          markApproved();
          log('[approve] DOM 推断：主号页面出现批准成功提示 → 打标');
        }
      }
    } catch (e) {}
  }

  // 一次赠礼只扣一次：同一 giftId 内只在首次成功替换时扣
  let giftConsumed = false;

  // ---- 从订单/表单 body 里抠字段（诊断 + 队列用） ----
  function readOrderId(bodyStr) {
    try { var o = JSON.parse(bodyStr); return (o && o.orderId) ? String(o.orderId) : ''; } catch (e) {}
    var m = String(bodyStr).match(/["']?orderId["']?\s*[:=]\s*["']?([0-9a-fA-F-]{20,})/);
    return m ? m[1] : '';
  }
  function readFirstProductId(bodyStr) {
    try {
      var o = JSON.parse(bodyStr);
      var it = o && o.items && o.items[0];
      return (it && it.productId) ? String(it.productId) : '';
    } catch (e) {}
    var m = String(bodyStr).match(/"productId"\s*:\s*"([^"]+)"/);
    return m ? m[1] : '';
  }
  function readFirstSkuId(bodyStr) {
    try {
      var o = JSON.parse(bodyStr);
      var it = o && o.items && o.items[0];
      return (it && it.skuId) ? String(it.skuId) : '';
    } catch (e) {}
    var m = String(bodyStr).match(/"skuId"\s*:\s*"([^"]+)"/);
    return m ? m[1] : '';
  }
  function readPoidFromForm(bodyStr) {
    var m = String(bodyStr).match(/purchaseOrderId=([^&]+)/i);
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }
  function readMarket(bodyStr) {
    try {
      var o = JSON.parse(bodyStr);
      if (o && o.market) return normMarket(o.market);
    } catch (e) {}
    var m = String(bodyStr).match(/"market"\s*:\s*"([^"]+)"/);
    return m ? normMarket(m[1]) : '';
  }

  function maybeSwap(url, bodyStr) {
    if (typeof bodyStr !== 'string' || !bodyStr) return null;

    // ---- 0) 主号批准 → 打标记（对照 approve_flag.js）----
    // 这一步不换任何字段，只把「已进入最终付款阶段」这个状态记下来，
    // 供 orders / buynow 判断。没有它，网页端就无法区分
    // 「子号发起申请」和「主号已批准」两个完全不同的阶段。
    if (RE_APPROVE.test(url)) {
      var apid = readOrderId(bodyStr);
      var appid = readFirstProductId(bodyStr);
      markApproved();
      if (apid) pushOrder(apid, appid, readFirstSkuId(bodyStr), readMarket(bodyStr));
      log('[approve] 已批准 orderId=' + (apid || '?') + ' productId=' + (appid || '?') + ' → approvedTime 已写入');
      notify('✅ 已批准', '进入最终付款阶段', 'orders / buynow 将一致换成内购');
      return null;
    }

    const g = store.get(KEY_GAME), t = store.get(KEY_IAP);
    if (!g || !t) return null;
    if (!t.availabilityId) { log('内购缺 availabilityId，跳过替换防404'); return null; }
    if (!guardMarket(g, t)) return null;

    // ---- 授权闸门：没授权就不替换 ----
    if (!getLicense()) {
      warnOnce('no-license', '未激活授权', '请在面板点「授权」输入授权码');
      return null;
    }
    if (!licenseState.valid) {
      warnOnce('lic-invalid', '授权无效', licenseState.reason || '请重新输入授权码');
      return null;
    }
    if (licenseState.remaining <= 0 && !giftConsumed) {
      warnOnce('lic-empty', '授权次数已用完', '请续费后再试');
      return null;
    }

    // 本次赠礼的幂等键
    if (!currentGiftId()) newGiftId();

    // ============================================================
    // 时机：只在「主号付款页」替换
    //   orders 分支只有在明确是家庭组批准场景时才替换，
    //   否则（子号发起的普通购买）保持原样，避免变成充值型购买
    // ============================================================
    if (/purchase\.md\.mp\.microsoft\.com\/v\d+\.\d+\/users\/me\/orders/.test(url)) {
      // ============================================================
      // 对照手机端稳定版 swap_payment.js 的 orders 分支：
      //   「主号已批准（approved=1）就换订单商品」，并不是一律不换。
      //
      // 之前 4.5.4 起把这里改成硬 no-op，理由是 HAR 里订单是内购、
      // buynow 是游戏、两边不一致 → ProductNotFound。但真正不一致的是
      // availabilityId（原档无 Gift），不是「该不该换」。
      // 现在 availabilityId 已收敛到可 Gift 档，就按手机端语义恢复：
      //   已批准 → 换；未批准（子号发起申请阶段）→ 不换。
      // ============================================================
      log('[orders] 建单阶段 orderId=' + readOrderId(bodyStr) +
          ' approved=' + (isApproved() ? 'YES' : 'NO'));
      var qid = readOrderId(bodyStr);
      var qpid = readFirstProductId(bodyStr);
      var qsku = readFirstSkuId(bodyStr);
      var qmk = readMarket(bodyStr);
      if (qid) pushOrder(qid, qpid, qsku, qmk);
      if (!isFinalPayStage(qid)) {
        log('[orders] 未批准（子号发起申请 / 审批页展示）→ 保持原样');
        return null;
      }
      var ro = swapOrdersJson(bodyStr, g, t);
      if (ro) {
        notify('✅ 订单商品已换内购', t.productId + ' · sku ' + t.skuId, '字段:' + ro.n);
        log('[orders] 已换内购', ro.n);
      } else {
        log('[orders] 已批准但替换未命中（商品不匹配），保持原样');
      }
      return ro ? ro.body : null;
    }
    if (/www\.microsoft\.com\/store\/purchase\/buynowui\/buynow/.test(url)) {
      // ---- 诊断：HAR 里这条链路的真实参数 ----
      try {
        var dd = {};
        bodyStr.split('&').forEach(function (p) {
          var i = p.indexOf('=');
          if (i < 0) return;
          dd[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1));
        });
        var p0 = [];
        try { p0 = JSON.parse(dd['products'] || '[]'); } catch (e) {}
        log('[buynow] scenario=' + (dd['scenario'] || '-') +
            ' cssOverride=' + (dd['cssOverride'] || '-') +
            ' caller=' + (dd['callerApplicationId'] || '-') +
            ' parentHost=' + (dd['parentHostName'] || '-') +
            ' poid=' + (dd['purchaseOrderId'] || '-') +
            ' market=' + (dd['market'] || '-') +
            ' 首项=' + ((p0[0] && p0[0].productId) || '?') + '/' + ((p0[0] && p0[0].availabilityId) || '?') +
            ' 内购=' + ((store.get(KEY_IAP) || {}).productId || '?') + '/' + ((store.get(KEY_IAP) || {}).availabilityId || '?'));
      } catch (e) {}

      // 必须是家庭组批准链路
      var isFam = /AMCFamilySafety/i.test(bodyStr) || /parentApproval/i.test(bodyStr);
      if (!isFam) {
        log('buynow：非家庭组链路，不替换');
        return null;
      }
      // buynow 必须有 purchaseOrderId 才是「已建单 → 付款页」
      var hasPoid = /purchaseOrderId=[^&]+/i.test(bodyStr);
      var lastOrder = latestOrder();
      if (!hasPoid) {
        // 网页端 orderId 通常已经在 account 标签的 orders 响应里拿到了，
        // 但 buynow 表单自带的那份这里读不到 → 直接补进表单
        if (lastOrder && lastOrder.id) {
          var patchedIn = bodyStr + '&purchaseOrderId=' + encodeURIComponent(lastOrder.id);
          log('[buynow] 表单缺 purchaseOrderId，用队列 orderId=' + lastOrder.id + ' 补上');
          bodyStr = patchedIn;
          hasPoid = true;
        } else {
          log('buynow：无 purchaseOrderId 且队列为空 → 发起申请阶段，不替换');
          return null;
        }
      }
      if (!isFinalPayStage(readPoidFromForm(bodyStr))) {
        log('[buynow] 既无 approve 标记也无 purchaseOrderId → 保守不替换');
        return null;
      }
      const r = swapBuynowForm(bodyStr, g, t);
      if (r) {
        notify('✅ safety购买页已换内购', t.productId + ' · sku ' + t.skuId, '字段:' + r.n);
        chargeOnce(t, g);
        return r.body;
      }
      return null;
    }
    return null;
  }

  /** 同一次赠礼只扣一次 */
  async function chargeOnce(t, g) {
    if (giftConsumed) return;
    giftConsumed = true;
    const gid = currentGiftId();
    const r = await consumeLicense(gid, {
      market: targetMarket() || '',
      iap: t ? t.productId : '',
      game: g ? g.productId : ''
    });
    if (r.ok) {
      panelAdd('已扣 1 次，剩余 ' + r.remaining + ' 次');
      refreshPanel();
    } else {
      panelAdd('⚠️ 扣次失败: ' + r.error);
    }
  }

  // 提示去重
  var warnedKeys = {};
  function warnOnce(key, title, msg) {
    if (warnedKeys[key]) return;
    warnedKeys[key] = true;
    setTimeout(function () { delete warnedKeys[key]; }, 15000);
    toast('⚠️ ' + title, msg);
  }

  // ============================================================
  // 统一请求处理：支持 fetch(Request) / 字符串 body / 非字符串
  // ============================================================
  const RE_CAPTURE = /cart\.production\.store-web\.dynamics\.com\/.*\/cart\/(loadCart|addItems|add)/;
  const RE_APPROVE = /account\.microsoft\.com\/family\/api\/buy\/requests\/approve/;
  const RE_SWAP = /(purchase\.md\.mp\.microsoft\.com\/v\d+\.\d+\/users\/me\/orders|www\.microsoft\.com\/store\/purchase\/buynowui\/buynow|account\.microsoft\.com\/family\/api\/buy\/requests\/approve)/;

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
      const kind = it && (it.productKind || it.ProductKind || it.productType || "");
      if (pid && sid && aid) {
        var rec = { productId: pid, availabilityId: aid, skuId: sid };
        if (kind) rec.productKind = kind;
        items.push(rec);
      }
    }
    if (!items.length) return;
    var im = inferMarket();
    if (im) {
      for (var q = 0; q < items.length; q++) {
        if (!items[q].market) items[q].market = im.market;
        if (!items[q].locale) items[q].locale = im.locale;
      }
    }
    log('响应采集 items=', items.length);
    // 购物车快照：先按已有的记录过滤掉重复项，剩下的才可能是"新加的那个"
    var g0 = store.get(KEY_GAME), t0 = store.get(KEY_IAP);
    var fresh = items.filter(function (it) {
      if (g0 && sameProduct(g0, it)) return false;
      if (t0 && sameProduct(t0, it)) return false;
      return true;
    });
    if (!fresh.length) {
      log('响应采集：购物车里的商品都已记录过');
      return;
    }
    // 只剩一个 -> 就是本次加购的
    if (fresh.length === 1) {
      handleCaptureItems(fresh, 'request');
      return;
    }
    // 多个新商品：用商品类型分流（内购往②，游戏往①）
    var g1 = store.get(KEY_GAME), t1 = store.get(KEY_IAP);
    for (var k = 0; k < fresh.length; k++) {
      var it = fresh[k];
      var kind = store.get('xfg_kind_' + it.productId) || '';
      if (kind === 'iap' && !t1) { handleCaptureItems([it], 'request'); t1 = it; continue; }
      if (kind === 'game' && !g1) { handleCaptureItems([it], 'request'); g1 = it; continue; }
    }
    // 还有剩的，按顺序补空位
    var g2 = store.get(KEY_GAME), t2 = store.get(KEY_IAP);
    for (var j = 0; j < fresh.length; j++) {
      if (g2 && t2) break;
      var it2 = fresh[j];
      if ((g2 && sameProduct(g2, it2)) || (t2 && sameProduct(t2, it2))) continue;
      handleCaptureItems([it2], 'request');
      g2 = store.get(KEY_GAME); t2 = store.get(KEY_IAP);
    }
  }

  // ============================================================
  // 【强制改写层】HAR 实证：4.5.x 的 products 和 orders 一个字节都没变，
  // 说明 maybeSwap 里的层层闸门（approved / kind / market / license）把替换全吃掉了。
  // 这里做成「不可跳过」的兜底：只要 URL 命中且本地有完整三件套，无条件替换。
  //   闸门只影响日志和提示，不再影响是否替换。
  // ============================================================
  function hardSwapOrders(bodyStr) {
    var o; try { o = JSON.parse(bodyStr); } catch (e) { return null; }
    var tt = planTarget();
    if (!tt) return null;
    var matches = planMatches('orders');
    var n = 0;
    (function walk(x) {
      if (x === null || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      n += swapOne(x, matches, tt);
      for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k)) walk(x[k]);
    })(o);
    if (!n && Array.isArray(o.items) && o.items.length && o.items[0].productId) {
      var it = o.items[0];
      it.productId = tt.productId;
      it.availabilityId = tt.availabilityId;
      if (tt.skuId) it.skuId = tt.skuId;
      n = 1;
      log('[hard] orders 首项未命中 → 改写 items[0]');
    }
    if (!n) return null;
    log('[hard] orders 强制替换 → ' + tt.productId + '/' + tt.availabilityId + ' 字段:' + n);
    return JSON.stringify(o);
  }

  function hardSwapBuynow(bodyStr) {
    var d = {};
    bodyStr.split('&').forEach(function (p) {
      var i = p.indexOf('='); if (i < 0) return;
      d[unq(p.slice(0, i))] = p.slice(i + 1);
    });
    if (d['products'] === undefined) return null;
    var arr; try { arr = JSON.parse(unq(d['products'])); } catch (e) { return null; }
    if (!Array.isArray(arr) || !arr.length) return null;

    // 4.6.2 强制层：tt 来自服务端，没命中就整条覆盖
    var tt = planTarget();
    if (!tt) return null;
    var matches = planMatches('buynow');
    var n = 0;
    arr.forEach(function (it) { n += swapOne(it, matches, tt); });
    if (!n) {
      arr = [{ productId: tt.productId, skuId: tt.skuId, availabilityId: tt.availabilityId }];
      n = 1;
      log('[hard] buynow 首项非游戏，整条覆盖');
    }

    var out = bodyStr.split('&').map(function (p) {
      var i = p.indexOf('='); if (i < 0) return p;
      var k = unq(p.slice(0, i));
      if (k === 'products') return p.slice(0, i) + '=' + qq(JSON.stringify(arr));
      return p;
    }).join('&');
    log('[hard] buynow 强制替换 → ' + tt.productId + '/' + tt.availabilityId + ' 字段:' + n);
    return out;
  }

  // 统一入口：先走精细逻辑，没命中就走强制层
  function forceSwap(url, bodyStr) {
    if (typeof bodyStr !== 'string' || !bodyStr) return null;
    var isOrders = /purchase\.md\.mp\.microsoft\.com\/v\d+\.\d+\/users\/me\/orders/.test(url);
    var isBuynow = /www\.microsoft\.com\/store\/purchase\/buynowui\/buynow/.test(url);
    if (!isOrders && !isBuynow) return null;
    // 授权仍要检查，但只提示不拦截（本地测试）
    try { if (!getLicense()) log('[hard] 未授权，仅提示'); } catch (e) {}
    var r = null;
    try { r = maybeSwap(url, bodyStr); } catch (e) { log('maybeSwap err', e); }
    if (r) return r;
    log('[hard] 精细闸门未命中 → 启用强制替换 ' + (isOrders ? 'orders' : 'buynow'));
    if (isOrders) return hardSwapOrders(bodyStr);
    return hardSwapBuynow(bodyStr);
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
            const nb = forceSwap(url, bodyStr);
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
          const nb = forceSwap(url, body);
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

      // ---- 授权只做提示，不再拦替换（HAR 实证：HAR 里 license/check 在 www 域，
      //      account 域这边读不到 valid，导致替换全被吃掉）----
      if (!getLicense() || !licenseState.valid) log('[form] 授权状态未知，继续替换');

      // ---- 读字段 ----
      const F = {};
      for (let i = 0; i < form.elements.length; i++) {
        const el = form.elements[i];
        if (el && el.name) F[el.name] = String(el.value || '');
      }
      const caller = F['callerApplicationId'] || '';
      const scen = F['scenario'] || '';
      const poid = (F['purchaseOrderId'] || '').trim();
      const famSig = /AMCFamilySafety|parentApproval/i.test(caller + '|' + scen + '|' + (F['cssOverride'] || '') + '|' + (F['parentHostName'] || ''));

      // ---- 只认「主号批准后的付款页」，缺一个都别动 ----
      if (!famSig) {
        log('[form] 非家庭组链路 → 不替换 (caller=' + caller + ' scenario=' + scen + ')');
        return 0;
      }
      if (!poid) {
        var lo = latestOrder();
        if (lo && lo.id) {
          for (let i = 0; i < form.elements.length; i++) {
            const el = form.elements[i];
            if (el && el.name === 'purchaseOrderId') { el.value = lo.id; break; }
          }
          log('[form] 补 purchaseOrderId=' + lo.id + '（来自 orders 队列）');
        } else {
          log('[form] 无 purchaseOrderId 且队列为空 → 发起申请阶段，不替换');
          warnOnce('form-no-poid', '这是「发起申请」阶段', '等主号批准后到付款页才会换成内购');
          return 0;
        }
      }
      // 强制阶段：有 purchaseOrderId 或 approve 标记任一即可，不再卡双重条件
      if (!isFinalPayStage(poid)) log('[form] 无 poid 也无 approve，仍强制替换');

      // 找 products 输入框
      let inp = null;
      for (let i = 0; i < form.elements.length; i++) {
        const el = form.elements[i];
        if (el && el.name === 'products') { inp = el; break; }
      }
      if (!inp) { log('[form] 表单里没有 products 字段 → 跳过'); return 0; }

      let arr;
      try { arr = JSON.parse(inp.value); } catch (e) { return 0; }
      if (!Array.isArray(arr)) return 0;

      // ============================================================
      // 4.6.2 的替换本体：tt 由服务端下发，本地零 ID 表
      //   arr.forEach(swapOne) 命中则逐条换
      //   一条都没命中 → 整条覆盖（4.6.2 的关键兜底）
      // ============================================================
      const tt = planTarget();
      if (!tt) {
        log('[form] ❌ 服务端未下发替换目标（plan 未就绪）');
        panelAdd('❌ 付款页未替换：plan 未就绪');
        return 0;
      }
      const matches = planMatches('buynow');
      log('[form] 准备替换 · 页面 products=' + JSON.stringify(arr) +
          ' · 目标=' + tt.productId + '/' + tt.availabilityId +
          ' · matches=' + JSON.stringify(matches));
      let n = 0;
      arr.forEach(it => { n += swapOne(it, matches, tt); });
      if (!n) {
        arr = [{ productId: tt.productId, skuId: tt.skuId, availabilityId: tt.availabilityId }];
        n = 1;
        log('[form] 首项未命中 → 整条覆盖为内购');
      }

      const tgt = targetMarket();
      let mk = tgt || '';

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
      log('✅ buynow 表单已改写 · products=' + JSON.stringify(arr) + ' · market=' + (mk || '?'));
      panelAdd('✅ 付款页替换 ' + n + ' 项 → ' + tt.productId + '/' + tt.availabilityId);
      notify('✅ safety付款页已换内购', tt.productId + ' · sku ' + tt.skuId, 'market ' + (mk || '?'));
      return n;
    } catch (e) { log('patchBuynowForm err', e); return 0; }
  }

  // ============================================================
  // 【关键加固】buynow 是 <form target=iframe> 的 document 级 POST。
  // HAR 里 products 原封不动，说明 submit/submit 事件/巡检三个点全部没赶上。
  // 这里直接劫持「能让请求发出去的最后一环」：
  //   a) iframe.src 赋值（主页面常见做法：拼好 URL 塞 iframe）
  //   b) form.action 赋值（拼好 action 再 submit）
  // 只要这一个 URL 被改写，products 就必然是对的内购。
  // ============================================================
  function rewriteBuynowUrl(u) {
    try {
      var s2 = String(u || '');
      if (!/\/store\/purchase\/buynowui\/buynow/i.test(s2)) return u;
      var m = s2.match(/[?&]products=([^&]*)/);
      if (!m) return u;
      var arr; try { arr = JSON.parse(decodeURIComponent(m[1])); } catch (e) { return u; }
      if (!Array.isArray(arr) || !arr.length) return u;

      var tt = planTarget();
      if (!tt) return u;
      var matches = planMatches('buynow');
      var n = 0;
      arr.forEach(function (it) { n += swapOne(it, matches, tt); });
      if (!n) {
        arr = [{ productId: tt.productId, skuId: tt.skuId, availabilityId: tt.availabilityId }];
        n = 1;
      }

      var out = s2.replace(/([?&]products=)[^&]*/, '$1' + encodeURIComponent(JSON.stringify(arr)));
      log('[hard] URL 改写 products → ' + tt.productId + '/' + tt.availabilityId + ' (' + n + ')');
      notify('✅ 付款 URL 已换内购', tt.productId, tt.availabilityId);
      return out;
    } catch (e) { log('rewriteBuynowUrl err', e); return u; }
  }

  // a) iframe.src / srcdoc / setAttribute
  try {
    var IFrame = PAGE.HTMLIFrameElement;
    if (IFrame && IFrame.prototype) {
      var dSrc = Object.getOwnPropertyDescriptor(IFrame.prototype, 'src');
      if (dSrc && dSrc.set && dSrc.get) {
        Object.defineProperty(IFrame.prototype, 'src', {
          configurable: true,
          enumerable: dSrc.enumerable,
          get: dSrc.get,
          set: function (v) { return dSrc.set.call(this, rewriteBuynowUrl(v)); }
        });
      }
      var dAttr = PAGE.Element && PAGE.Element.prototype && PAGE.Element.prototype.setAttribute;
      if (dAttr) {
        PAGE.Element.prototype.setAttribute = function (name, value) {
          try { if (String(name).toLowerCase() === 'src') value = rewriteBuynowUrl(value); } catch (e) {}
          return dAttr.call(this, name, value);
        };
      }
    }
  } catch (e) { log('iframe hook err', e); }

  // b) form.action 赋值
  try {
    var HForm0 = PAGE.HTMLFormElement;
    if (HForm0 && HForm0.prototype) {
      var dAct = Object.getOwnPropertyDescriptor(HForm0.prototype, 'action');
      if (dAct && dAct.set && dAct.get) {
        Object.defineProperty(HForm0.prototype, 'action', {
          configurable: true,
          enumerable: dAct.enumerable,
          get: dAct.get,
          set: function (v) { return dAct.set.call(this, rewriteBuynowUrl(v)); }
        });
      }
    }
  } catch (e) { log('form action hook err', e); }

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
    try { inferApprovedFromDom(); } catch (e) {}
    try {
      const forms = PAGE.document ? PAGE.document.querySelectorAll('form') : [];
      for (let i = 0; i < forms.length; i++) patchBuynowForm(forms[i]);
    } catch (e) {}
  }, 1500);
  log('v4.9.4 injected (市场取自② + 面板单实例)');

  // ============================================================
  // 菜单
  // ============================================================
  try {
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("输入授权码", async () => {
        var raw = prompt("输入授权码（XXXX-XXXX-XXXX-XXXX）：", "");
        if (raw === null) return;
        raw = raw.trim();
        if (!raw) { clearLicense(); notify("授权", "已清除", ""); refreshPanel(); return; }
        setLicense(raw);
        var r = await verifyLicense();
        if (!r.ok) { clearLicense(); notify("授权失败", r.error || "", ""); }
        else notify("授权成功", "剩余 " + r.remaining + " 次", "");
        refreshPanel();
      });
      GM_registerMenuCommand("查看授权状态", async () => {
        var lic = getLicense();
        if (!lic) return notify("授权", "未激活", "请先输入授权码");
        var r = await verifyLicense();
        if (!r.ok) notify("授权", r.error || "无效", "");
        else notify("授权", "剩余 " + r.remaining + " 次", "");
      });
      GM_registerMenuCommand("查看已采集 ID", () => {
        const g = store.get(KEY_GAME), t = store.get(KEY_IAP);
        notify("已采集", "游戏: " + (g ? g.productId + " / " + g.availabilityId : "无"), "内购: " + (t ? t.productId + " / " + t.availabilityId : "无"));
      });
      GM_registerMenuCommand("清空已采集 ID", () => {
        store.del(KEY_GAME); store.del(KEY_IAP); store.del(KEY_LOCK);
        clearApproved(); store.del(KEY_ORDER_QUEUE);
        notify("已清空", "已重置", "请重新加购");
      });
      GM_registerMenuCommand("手动标记已批准(兜底)", () => {
        markApproved();
        notify("已手动标记批准", "approvedTime=" + approvedAt(), "orders/buynow 将按已批准处理");
        refreshPanel();
      });
      GM_registerMenuCommand("查看 orderId 队列", () => {
        var q = store.get(KEY_ORDER_QUEUE);
        var lo = latestOrder();
        notify("队列", lo ? ("最新 " + lo.id) : "空",
          (Array.isArray(q) ? q.length : 0) + " 条 · approved=" + (isApproved() ? "YES" : "NO"));
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
        if (!raw.trim()) { store.del(KEY_MARKET); notify("目标市场", "跟随订单", ""); return; }
        var mk = normMarket(raw);
        if (!mk) { notify("目标市场", "无法识别「" + raw + "」", "请输入 AR / US / JP"); return; }
        store.set(KEY_MARKET, mk);
        var loc2 = MARKET_LOCALE[mk] || mk.toLowerCase();
        notify("目标市场", mk, "请到 xbox.com/" + loc2 + "/ 重新加购");
      });
      GM_registerMenuCommand("按目标市场自动对齐 ID", () => {
        var mk = targetMarket();
        if (!mk) { notify("自动对齐", "未设目标市场", "先设置市场"); return; }
        var g = store.get(KEY_GAME), t = store.get(KEY_IAP);
        Promise.all([g ? resolveItem(g, mk, "游戏") : null, t ? resolveItem(t, mk, "内购") : null])
          .then(function (rs) {
            var n = rs.filter(Boolean).length;
            notify("自动对齐", mk + " · " + n + " 项", n ? "已完成" : "未找到对应条目");
          });
      });
      GM_registerMenuCommand("解除锁定", () => { store.del(KEY_LOCK); notify("已解除锁定", "可重新采集", ""); });
      GM_registerMenuCommand("测试采集(自检)", () => {
        handleCaptureItems([{ productId: "TESTPROD0001", availabilityId: "TESTAVAIL01", skuId: "0010" }]);
        notify("自检完成", "若看到①②弹窗说明采集正常", "记得清空");
      });
    }
  } catch (e) {}

  // 版本自检：控制台 + 面板都能确认当前跑的是哪一版
  try {
    console.log('%c[XFG] running v4.9.4', 'color:#107C10;font-weight:700',
      '| approved 判据 | orders+buynow 一致换内购');
  } catch (e) {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    setTimeout(buildPanel, 0);
  }

  // 启动：后台校验授权 + 有新赠礼流程时重置扣次标志
  setTimeout(function () {
    backgroundVerify();
  }, 800);

  // 采集被清空 = 新一轮赠礼，重置幂等与扣次标志
  var _origDel = store.del.bind(store);
  store.del = function (k) {
    if (k === KEY_LOCK) { giftConsumed = false; clearGiftId(); }
    return _origDel(k);
  };

  log("v4.9.4 injected (licensed build)");
})();
