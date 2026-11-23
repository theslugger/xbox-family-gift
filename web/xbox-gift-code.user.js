// ==UserScript==
// @name         Xbox 家庭组内购送礼（网页版）
// @namespace    https://github.com/theslugger/xbox-family-gift
// @version      2.2.1
// @description  子号对当前游戏发起送礼 → 主号批准付款 → 产物为可兑换数字码（支持收件邮箱与数量）
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

  // ---- 扣次会话锁（提前声明，避免 TDZ）----


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
          game: (ctx && ctx.game) || '',
          orderId: (ctx && ctx.orderId) || ''   // 服务端按订单号去重
        })
      });
      const j = await r.json();
      if (!j.ok) return { ok: false, error: j.error || '扣次失败', reason: j.reason };
      licenseState.valid = true;
      licenseState.remaining = j.data.remaining;
      return { ok: true, remaining: j.data.remaining };
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
  /**
   * 双写双删存储
   * ------------------------------------------------------------
   * 旧实现有个致命 bug：del() 在 GM_deleteValue 存在时直接 return，
   * 永远不会清 localStorage。只要历史上某一刻 GM 不可用、数据写进了
   * localStorage（例如早期 @grant none 的版本），之后怎么删都删不掉，
   * get() 又会回读到它 —— 表现就是「清空后 ① 还在」。
   * 现在 get/set/del 三个动作对 GM 和 localStorage 同时生效。
   */
  const store = {
    _hasGM() { return typeof GM_setValue === 'function' && typeof GM_getValue === 'function'; },

    get(k) {
      // GM 优先
      if (this._hasGM()) {
        try {
          const v = GM_getValue(k, '');
          if (v) {
            try { return JSON.parse(v); } catch (e) { return v; }
          }
        } catch (e) {}
      }
      // 再读 localStorage（兼容历史遗留）
      try {
        const v = localStorage.getItem(k);
        if (v) { try { return JSON.parse(v); } catch (e) { return v; } }
      } catch (e) {}
      return null;
    },

    set(k, obj) {
      const s = JSON.stringify(obj);
      if (this._hasGM()) { try { GM_setValue(k, s); } catch (e) {} }
      try { localStorage.setItem(k, s); } catch (e) {}
    },

    del(k) {
      // 两边都删，不再提前 return
      if (this._hasGM() && typeof GM_deleteValue === 'function') {
        try { GM_deleteValue(k); } catch (e) {}
      }
      try { localStorage.removeItem(k); } catch (e) {}
      // sessionStorage 也扫一遍，避免老版本残留在那
      try { sessionStorage.removeItem(k); } catch (e) {}
    }
  };

  // ============================================================
  // 扣次：一次付款页会话只扣 1 次
  // ------------------------------------------------------------
  // 付款页每 1.5 秒巡检一次，同一次付款会反复替换 4~8 次。
  // 这些都属于「同一次购买」，只能算 1 次。
  //
  // 判据（任一变化才算新一轮）：
  //   · orderId 变了
  //   · 目标商品变了
  //   · 页面重新加载（sessionStorage 被清）
  //   · 用户点了「全部清空」或「刷新」的强制重置
  //
  // 服务端不做去重，来一次扣一次；防重复完全靠这里的会话锁。
  // ============================================================
  /**
   * 替换成功就扣次 —— 不做任何拦截。
   * 每次调用都会真的请求 /api/license/consume。
   */
  // ============================================================
  // 扣次：一次付款页会话只扣 1 次
  // ------------------------------------------------------------
  // 付款页每 1.5 秒巡检一次，同一次付款会反复替换 4~8 次。
  // 这些都属于「同一次购买」，只能算 1 次。
  //
  // 判据（任一变化才算新一轮）：
  //   · orderId 变了
  //   · 目标商品变了
  //   · 页面重新加载（sessionStorage 被清）
  //   · 用户点了「全部清空」或「刷新」的强制重置
  //
  // 服务端不做去重，来一次扣一次；防重复完全靠这里的会话锁。
  // ============================================================
  /**
   * 替换成功就扣次 —— 不做任何拦截。
   * 每次调用都会真的请求 /api/license/consume。
   */
  // ============================================================
  // 扣次：一次付款页会话只扣 1 次
  // ------------------------------------------------------------
  // 付款页每 1.5 秒巡检一次，同一次付款会反复替换 4~8 次。
  // 这些都属于「同一次购买」，只能算 1 次。
  //
  // 判据（任一变化才算新一轮）：
  //   · orderId 变了
  //   · 目标商品变了
  //   · 页面重新加载（sessionStorage 被清）
  //   · 用户点了「全部清空」或「刷新」的强制重置
  //
  // 服务端不做去重，来一次扣一次；防重复完全靠这里的会话锁。
  // ============================================================
  /**
   * 替换成功就扣次 —— 不做任何拦截。
   * 每次调用都会真的请求 /api/license/consume。
   */
  // ============================================================
  // 扣次：一次付款页会话只扣 1 次
  // ------------------------------------------------------------
  // 付款页每 1.5 秒巡检一次，同一次付款会反复替换 4~8 次。
  // 这些都属于「同一次购买」，只能算 1 次。
  //
  // 判据（任一变化才算新一轮）：
  //   · orderId 变了
  //   · 目标商品变了
  //   · 页面重新加载（sessionStorage 被清）
  //   · 用户点了「全部清空」或「刷新」的强制重置
  //
  // 服务端不做去重，来一次扣一次；防重复完全靠这里的会话锁。
  // ============================================================
  // ---- 订单队列（4.6.2 移植时丢失，补回）----
  const KEY_ORDER_QUEUE = 'xfg_orderQueue';

  /** 压入一条订单记录（去重，最多保留 20 条） */
  function pushOrder(id, productId, skuId, market) {
    if (!id) return;
    var q = store.get(KEY_ORDER_QUEUE);
    if (!Array.isArray(q)) q = [];
    for (var i = 0; i < q.length; i++) {
      if (q[i] && q[i].id === id) {
        q[i].at = Date.now();
        store.set(KEY_ORDER_QUEUE, q);
        return;
      }
    }
    q.push({ id: String(id), productId: productId || '', skuId: skuId || '', market: market || '', at: Date.now() });
    if (q.length > 20) q = q.slice(-20);
    store.set(KEY_ORDER_QUEUE, q);
  }

  /** 最近一条订单 */
  function latestOrder() {
    var q = store.get(KEY_ORDER_QUEUE);
    if (!Array.isArray(q) || !q.length) return null;
    return q[q.length - 1] || null;
  }

  var KEY_CHARGED_SESSION = 'xfg_chargedSession';

  /** 本次付款会话的唯一键 */
  function paySessionKey(t) {
    var oid = '';
    try { var lo = latestOrder(); if (lo && lo.id) oid = String(lo.id); } catch (e) {}
    var pid = (t && t.productId) ? String(t.productId).toUpperCase() : '';
    return oid + '|' + pid;
  }

  /** 本会话是否已扣过 */
  function chargedThisSession(key) {
    try { return sessionStorage.getItem(KEY_CHARGED_SESSION) === key; } catch (e) { return false; }
  }
  function markChargedSession(key) {
    try { sessionStorage.setItem(KEY_CHARGED_SESSION, key); } catch (e) {}
  }
  function clearChargedSession() {
    try { sessionStorage.removeItem(KEY_CHARGED_SESSION); } catch (e) {}
  }

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
      // 只排除真正的 iframe（buynow 的 document POST 落在子 frame 里）
      if (window.top !== window.self) return false;
      return true;
    } catch (e) { return false; }
  }

  /**
   * 角色识别：主号/子号分两个浏览器窗口操作
   *   子号 → 无痕窗口，打开 www.xbox.com，负责加购与发起申请
   *   主号 → 普通窗口，打开 account.microsoft.com，负责批准与付款
   * 面板按角色只显示该做的操作，避免点错。
   */
  function currentRole() {
    var h = location.hostname;
    if (h === 'account.microsoft.com') return 'parent';
    if (h === 'www.xbox.com' || h === 'xbox.com') return 'child';
    return 'both';
  }

  function buildPanel() {
    if (panelEl || !document.body) return;
    if (!shouldShowPanel()) { log('非主控页面，不显示面板'); return; }
    panelEl = document.createElement('div');
    panelEl.id = 'xfg-panel';
    panelEl.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;width:330px;' +
      'background:#0b0b0b;color:#eee;border:1px solid #107C10;border-radius:10px;' +
      'font:12px/1.45 -apple-system,Segoe UI,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden';

    var role = currentRole();
    var roleTag = role === 'child'
      ? '<span style="background:#1f6feb33;color:#79c0ff;border:1px solid #1f6feb66;border-radius:99px;padding:1px 7px;font-size:10px;font-weight:700;margin-left:6px">子号</span>'
      : role === 'parent'
      ? '<span style="background:#23863633;color:#7ee787;border:1px solid #23863666;border-radius:99px;padding:1px 7px;font-size:10px;font-weight:700;margin-left:6px">主号</span>'
      : '';

    // 送礼配置
    var giftRows =
        '<div style="margin-top:8px;padding:8px;border-radius:7px;background:#12261a;border:1px solid #23863655">' +
          '<div style="color:#7ee787;font-weight:700;font-size:11px;margin-bottom:5px">送礼（产物 = 兑换码）</div>' +
          '<input id="xfg-email" placeholder="收码邮箱（必填）" style="width:100%;box-sizing:border-box;background:#0b0b0b;border:1px solid #30363d;border-radius:6px;padding:6px 8px;color:#eee;font:inherit;outline:none">' +
          '<div style="display:flex;gap:6px;margin-top:5px">' +
            '<input id="xfg-sender" placeholder="寄件人名字" style="flex:1;background:#0b0b0b;border:1px solid #30363d;border-radius:6px;padding:6px 8px;color:#eee;font:inherit;outline:none">' +
            '<input id="xfg-qty" placeholder="数量" value="1" style="flex:0 0 62px;background:#0b0b0b;border:1px solid #30363d;border-radius:6px;padding:6px 8px;color:#eee;font:inherit;text-align:center;outline:none">' +
          '</div>' +
          '<div style="display:flex;gap:6px;margin-top:6px">' +
            '<button id="xfg-gsave" style="flex:1;padding:6px;background:#238636;color:#fff;border:1px solid #2ea043;border-radius:6px;cursor:pointer;font-weight:600">保存</button>' +
            '<button id="xfg-gbuild" style="flex:1;padding:6px;background:#1a2a3a;color:#9cf;border:1px solid #265;border-radius:6px;cursor:pointer">建 Gift Cart</button>' +
          '</div>' +
        '</div>';

    var tip = role === 'parent'
      ? '<div style="margin-top:8px;padding:7px 9px;border-radius:7px;background:#12261a;border:1px solid #23863655;color:#7ee787;font-size:11px;line-height:1.5">' +
        '主号窗口：等子号发起申请后，在微软页面点「批准」，付款页会自动转成送礼订单。' +
        '</div>'
      : role === 'child'
      ? '<div style="margin-top:8px;padding:7px 9px;border-radius:7px;background:#0d1f33;border:1px solid #1f6feb55;color:#79c0ff;font-size:11px;line-height:1.5">' +
        '子号窗口：打开要送的游戏页 → 填收码邮箱 → 保存 → 发起购买申请。' +
        '</div>'
      : '';

    panelEl.innerHTML =
      '<div id="xfg-hd" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#107C10;cursor:pointer">' +
        '<span><b>Xbox 送礼码 v2.2.1</b>' + roleTag + '</span>' +
        '<span style="font-size:10px;opacity:.8">' + location.host + '</span><span id="xfg-tg" style="margin-left:8px">收起</span>' +
      '</div>' +
      '<div id="xfg-bd" style="padding:10px">' +
        '<div id="xfg-state" style="margin-bottom:8px"></div>' +
        '<div id="xfg-log" style="max-height:150px;overflow:auto;background:#000;border-radius:6px;padding:6px;' +
          'font:11px/1.4 ui-monospace,Menlo,monospace;color:#9c9;white-space:pre-wrap"></div>' +
        giftRows +
        tip +
        (role === 'child'
          ? '<div style="margin-top:6px;display:flex;gap:6px">' +
              '<button id="xfg-pairNew" style="flex:1;padding:6px;background:#1a2a3a;color:#9cf;border:1px solid #265;border-radius:6px;cursor:pointer">生成配对码</button>' +
            '</div>'
          : role === 'parent'
          ? '<div style="margin-top:6px;display:flex;gap:6px">' +
              '<button id="xfg-pairJoin" style="flex:1;padding:6px;background:#2a2a1a;color:#ff9;border:1px solid #553;border-radius:6px;cursor:pointer">输入子号的配对码</button>' +
            '</div>'
          : '<div style="margin-top:6px;display:flex;gap:6px">' +
              '<button id="xfg-pairNew" style="flex:1;padding:5px;background:#1a2a3a;color:#9cf;border:1px solid #265;border-radius:6px;cursor:pointer">生成配对码</button>' +
              '<button id="xfg-pairJoin" style="flex:1;padding:5px;background:#2a2a1a;color:#ff9;border:1px solid #553;border-radius:6px;cursor:pointer">输入配对码</button>' +
            '</div>') +
        '<div style="margin-top:6px;display:flex;gap:6px">' +
          '<button id="xfg-lic" style="flex:1;padding:5px;background:#2a1a3a;color:#c8f;border:1px solid #536;border-radius:6px;cursor:pointer">授权</button>' +
          '<button id="xfg-refresh" style="flex:0 0 60px;padding:5px;background:#1a2f3a;color:#9cf;border:1px solid #265;border-radius:6px;cursor:pointer">刷新</button>' +
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
      hardReset();
    });

    panelEl.querySelector('#xfg-refresh').addEventListener('click', function () {
      // 从存储重新读一遍，再拉一次 plan，日志留痕
      logLines = [];
      planState = null;
      clearChargedSession();
      panelAdd('已刷新 · 重新读取本地面板数据');
      try { verifyLicense(); } catch (e) {}
      try { if (isPayUrl()) prepareGiftCart(); } catch (e) {}
      refreshPanel();
    });
    var bSave = panelEl.querySelector('#xfg-gsave');
    var bBuild = panelEl.querySelector('#xfg-gbuild');
    if (bSave) bSave.addEventListener('click', saveGiftCfg);
    if (bBuild) bBuild.addEventListener('click', function () { prepareGiftCart(); });

    // 配对码按钮
    var bPN = panelEl.querySelector('#xfg-pairNew');
    var bPJ = panelEl.querySelector('#xfg-pairJoin');
    if (bPN) bPN.addEventListener('click', createPair);
    if (bPJ) bPJ.addEventListener('click', joinPair);

    var gc0 = giftCfg();
    if (gc0.email) { var e0 = panelEl.querySelector('#xfg-email'); if (e0) e0.value = gc0.email; }
    if (gc0.sender) { var s0 = panelEl.querySelector('#xfg-sender'); if (s0) s0.value = gc0.sender; }
    var q0 = panelEl.querySelector('#xfg-qty'); if (q0) q0.value = gc0.qty || 1;
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
    var gmOk = (typeof GM_setValue === 'function' && typeof GM_getValue === 'function');
    panelAdd('脚本已注入 · 存储=' + (gmOk ? 'GM 跨域 ✅' : 'localStorage ⚠️ 不跨域'));

    // 启动即尝试从另一窗口同步（有授权码时）
    setTimeout(function () { try { pullShare(true); } catch (e) {} }, 600);
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

  // ============================================================
  // 【跨窗口共享】配对码隔离
  // ------------------------------------------------------------
  // 普通 Chrome 与无痕窗口存储完全隔离，①② 经服务端中转。
  // 为避免同一张授权码被多人共用时串台，引入 6 位配对码：
  //   子号窗口「生成配对码」→ 主号窗口「输入配对码」→ 同组共享
  // ============================================================
  var KEY_PAIR = 'xfg_pairId';
  var _lastPullAt = 0;

  function shareCode() {
    var lc = getLicense();
    return lc && lc.code ? lc.code : '';
  }
  function pairId() {
    var v = store.get(KEY_PAIR);
    return v && typeof v === 'string' ? v : '';
  }
  function setPairId(id) { store.set(KEY_PAIR, String(id || '')); }

  /** 子号窗口：生成配对码 */
  function createPair() {
    var role = currentRole();
    if (role === 'parent') { panelAdd('❌ 配对码由子号生成，主号只需输入'); return; }
    var code = shareCode();
    if (!code) { panelAdd('❌ 先填入授权码'); return; }
    panelAdd('正在生成配对码…');
    fetch(SERVER_BASE + '/api/pair/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ code: code })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) {
          // 429 自动重试一次
          if (j && j.retryAfter) {
            panelAdd('⏳ 限流中，' + j.retryAfter + ' 秒后自动重试…');
            setTimeout(function () { createPair(); }, Math.min(j.retryAfter * 1000 + 500, 15000));
            return;
          }
          panelAdd('❌ 生成失败: ' + ((j && j.error) || '?'));
          return;
        }
        setPairId(j.data.pairId);
        panelAdd('🔑 配对码 ' + j.data.pairId + ' · ' + Math.round(j.data.expiresIn / 60) + ' 分钟内有效');
        notify('配对码已生成', j.data.pairId, '把这个数字告诉主号，让它在主号窗口输入');
        refreshPanel();
      })
      .catch(function (e) { panelAdd('❌ 网络错误: ' + e.message); });
  }

  /** 主号窗口：输入子号生成的配对码 */
  function joinPair() {
    var role = currentRole();
    if (role === 'child') { panelAdd('❌ 子号窗口负责生成配对码，不需要输入'); return; }
    var code = shareCode();
    if (!code) { panelAdd('❌ 先填入授权码'); return; }
    var cur = pairId();
    var raw = prompt('输入子号窗口生成的配对码（6 位数字）：', cur);
    if (raw === null) return;
    var id = String(raw).trim();
    if (!/^\d{6}$/.test(id)) { panelAdd('❌ 配对码必须是 6 位数字'); return; }
    panelAdd('正在加入配对 ' + id + '…');
    fetch(SERVER_BASE + '/api/pair/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ code: code, pairId: id })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) {
          if (j && j.retryAfter) {
            panelAdd('⏳ 限流中，' + j.retryAfter + ' 秒后自动重试…');
            setTimeout(function () {
              fetch(SERVER_BASE + '/api/pair/join', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                credentials: 'omit',
                body: JSON.stringify({ code: shareCode(), pairId: id })
              }).then(function (r) { return r.json(); }).then(function (j2) {
                if (j2 && j2.ok) {
                  setPairId(j2.data.pairId);
                  panelAdd('✅ 已加入配对 ' + j2.data.pairId);
                  try { pullShare(true); } catch (e) {}
                  refreshPanel();
                } else panelAdd('❌ 重试仍失败');
              });
            }, Math.min(j.retryAfter * 1000 + 500, 15000));
            return;
          }
          panelAdd('❌ 加入失败: ' + ((j && j.error) || '?'));
          return;
        }
        setPairId(j.data.pairId);
        panelAdd('✅ 已加入子号配对 ' + j.data.pairId + '（组内 ' + j.data.members + ' 个窗口）');
        notify('配对成功', '配对码 ' + j.data.pairId, '正在拉取子号抓的 ①②');
        // 加入后立刻拉一次，主号马上就能看到子号抓的 ①②
        try { pullShare(true); } catch (e) {}
        refreshPanel();
      })
      .catch(function (e) { panelAdd('❌ 网络错误: ' + e.message); });
  }

  /** 上传 ①② */
  function pushShare() {
    var code = shareCode(), pid = pairId();
    if (!code || !pid) return;
    var g = store.get(KEY_GAME), t = store.get(KEY_IAP);
    if (!g && !t) return;

    var body = { code: code, pairId: pid };

    // 当前商品（不再需要 ①②，直接同步页面商品）
    var prod = currentProduct();
    if (prod && prod.productId) {
      body.game = {
        productId: prod.productId,
        skuId: prod.skuId || '0010',
        availabilityId: prod.availabilityId || '',
        market: market() || ''
      };
    }

    // 送礼配置（主号要拿到才能建 cart）
    var gc = giftCfg();
    if (gc.email) {
      body.giftCfg = { email: gc.email, sender: gc.sender, qty: gc.qty };
    }

    fetch(SERVER_BASE + '/api/share', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) log('[share] 已上传到配对 ' + pid);
        else log('[share] 上传失败: ' + ((j && j.error) || '?'));
      })
      .catch(function (e) { log('[share] 上传异常: ' + e.message); });
  }

  /** 从配对组拉取 ①② */
  function pullShare(force) {
    var code = shareCode(), pid = pairId();
    if (!code || !pid) return Promise.resolve(null);
    var now = Date.now();
    if (!force && now - _lastPullAt < 5000) return Promise.resolve(null);
    _lastPullAt = now;

    return fetch(SERVER_BASE + '/api/share?code=' + encodeURIComponent(code) + '&pairId=' + encodeURIComponent(pid), {
      credentials: 'omit'
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { log('[share] 拉取失败: ' + ((j && j.error) || '?')); return null; }
        if (!j.data) { log('[share] 配对组内暂无 ①②'); return null; }

        var g = store.get(KEY_GAME), t = store.get(KEY_IAP);
        var changed = false;

        if (j.data.game && j.data.game.productId && (!g || g.productId !== j.data.game.productId)) {
          store.set(KEY_GAME, j.data.game); changed = true;
          log('[share] ← 同步 ① 游戏 ' + j.data.game.productId);
        }
        if (j.data.iap && j.data.iap.productId && (!t || t.productId !== j.data.iap.productId)) {
          store.set(KEY_IAP, j.data.iap); changed = true;
          log('[share] ← 同步 ② 内购 ' + j.data.iap.productId);
        }

        // 送礼配置
        if (j.data.giftCfg && j.data.giftCfg.email) {
          var curGc = giftCfg();
          if (curGc.email !== j.data.giftCfg.email || curGc.qty !== j.data.giftCfg.qty) {
            store.set(KEY_GC, {
              email: j.data.giftCfg.email,
              sender: j.data.giftCfg.sender || 'Gift',
              qty: j.data.giftCfg.qty || 1
            });
            changed = true;
            log('[share] ← 同步送礼: ' + j.data.giftCfg.email + ' x' + j.data.giftCfg.qty);
            panelAdd('✅ 已同步送礼配置 → ' + j.data.giftCfg.email);

            // 回填输入框
            if (panelEl) {
              var ee = panelEl.querySelector('#xfg-email');
              var ss = panelEl.querySelector('#xfg-sender');
              var qq = panelEl.querySelector('#xfg-qty');
              if (ee) ee.value = j.data.giftCfg.email;
              if (ss) ss.value = j.data.giftCfg.sender || 'Gift';
              if (qq) qq.value = j.data.giftCfg.qty || 1;
            }
          }
        }
        if (changed) {
          var g2 = store.get(KEY_GAME), t2 = store.get(KEY_IAP);
          panelAdd('✅ 已从配对组同步商品配置');
          refreshPanel();
          // 同步到商品和邮箱后，若 context 已就绪就自动建 cart
          setTimeout(function () { try { tryAutoBuild(); } catch (e) {} }, 400);
        } else {
          log('[share] 本地已是最新');
        }
        return j.data;
      })
      .catch(function (e) { log('[share] 拉取异常: ' + e.message); return null; });
  }

  // ============================================================
  // 【2.0.0 核心】送礼链路
  // ------------------------------------------------------------
  // 商品就是当前页面这个，不需要 ①② 替换。
  // 1) currentProduct  读页面状态拿商品
  // 2) pageCtx         读 riskId / xToken / flights
  // 3) prepareGiftCart 发 PrepareCheckout 建 gift cart
  // 4) patchBuynow     把表单转成 scenario=gift
  // ============================================================
  var KEY_GC = 'xfg_giftCfg';
  var autoBuildTried = false;   // 防止重复建 cart（提到顶部避免 TDZ）
  var KEY_GCART = 'xfg_giftCart';

  function giftCfg() {
    var c = store.get(KEY_GC) || {};
    return {
      email: c.email || '',
      sender: c.sender || 'Gift',
      qty: Math.max(1, Math.min(10, parseInt(c.qty, 10) || 1))
    };
  }

  function saveGiftCfg() {
    var email = (panelEl.querySelector('#xfg-email').value || '').trim();
    var sender = (panelEl.querySelector('#xfg-sender').value || '').trim() || 'Gift';
    var qty = Math.max(1, Math.min(10, parseInt(panelEl.querySelector('#xfg-qty').value, 10) || 1));
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      panelAdd('❌ 邮箱格式不正确');
      return false;
    }
    store.set(KEY_GC, { email: email, sender: sender, qty: qty });
    panelAdd('✅ 送礼设置已保存 · ' + email + ' x' + qty);
    try { pushShare(); } catch (e) {}
    refreshPanel();

    // 如果 context 已经可用（付款页），保存后立刻建 cart
    setTimeout(function () { try { tryAutoBuild(); } catch (e) {} }, 300);
    return true;
  }

  var giftCart = { id: '', recipientId: '', at: 0 };
  (function () {
    var v = store.get(KEY_GCART);
    if (v && v.id) giftCart = v;
  })();

  /**
   * 当前商品
   * 优先级：
   *   0) store 里配对同步过来的商品（主号窗口唯一来源）
   *   1) 页面状态 productsToAdd
   *   2) 页面状态 products
   *   3) entities.byId
   *   4) URL
   */
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
        market: String(p0.market || ''),
        source: src
      };
    }

    // ---- 0) store 里配对同步过来的商品（主号窗口靠这个）----
    try {
      var sg = store.get(KEY_GAME);
      if (sg && sg.productId) {
        var r0 = pick(sg, 'sync');
        if (r0) return r0;
      }
    } catch (e) {}

    try {
      var it = ac.productsToAdd && ac.productsToAdd.items;
      if (Array.isArray(it) && it.length) {
        var r1 = pick(it[0], 'productsToAdd');
        if (r1) { try { store.set(KEY_GAME, r1); } catch (e) {} return r1; }
      }
    } catch (e) {}

    try {
      var pr = ac.products;
      if (typeof pr === 'string') { try { pr = JSON.parse(pr); } catch (e) { pr = null; } }
      if (Array.isArray(pr) && pr.length) {
        var r2 = pick(pr[0], 'products');
        if (r2) { try { store.set(KEY_GAME, r2); } catch (e) {} return r2; }
      }
    } catch (e) {}

    try {
      var byId = st.entities && st.entities.products && st.entities.products.byId;
      if (byId) {
        var keys = Object.keys(byId);
        if (keys.length) {
          var parts = keys[0].split('/');
          if (parts.length >= 3) {
            return { productId: parts[0].toUpperCase(), skuId: parts[1], availabilityId: parts[2], source: 'entities' };
          }
        }
      }
    } catch (e) {}

    // ---- URL 兜底（ID 可能是小写，必须 /i）----
    var u = location.href;
    var cands = [
      /\/(?:games\/)?store\/[^/]*\/([a-z0-9]{12})(?:[?#/]|$)/i,   // /games/store/slug/ID
      /\/store\/(?:apps|pdp|games)\/[^/]*\/([a-z0-9]{12})(?:[?#/]|$)/i,
      /\/p\/([a-z0-9]{12})(?:[?#/]|$)/i,                          // /p/ID
      /\/([a-z0-9]{12})(?:[?#/]|$)/i,                              // /ID 结尾
      /\b([a-z0-9]{12})\b/i                                      // 任意 12 位
    ];
    for (var ci = 0; ci < cands.length; ci++) {
      var mm = u.match(cands[ci]);
      if (!mm) continue;
      var pid = mm[1].toUpperCase();
      // 排除纯数字（时间戳等）和纯字母（单词）
      if (!/[0-9]/.test(pid) || !/[A-Z]/.test(pid)) continue;
      return { productId: pid, skuId: '0010', availabilityId: '', source: 'url' };
    }
    return null;
  }

  /** 页面 context（只在付款页有） */
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
        market: ac.market || targetMarket() || 'US',
        locale: ac.locale || 'en-us',
        campaignId: ac.campaignId || ''
      };
    } catch (e) { return null; }
  }

  /** 发 PrepareCheckout 建 gift cart */
  function prepareGiftCart() {
    var cfg = giftCfg();
    if (!cfg.email) { panelAdd('❌ 先填收码邮箱并保存'); return Promise.resolve(null); }

    var prod = currentProduct();
    if (!prod || !prod.productId) { panelAdd('❌ 拿不到当前商品 ID'); return Promise.resolve(null); }

    var ctx = pageCtx();
    if (!ctx || !ctx.riskId || !ctx.xToken) {
      panelAdd('❌ 缺页面 context（仅付款页可用）');
      return Promise.resolve(null);
    }

    var item = {
      productId: prod.productId,
      skuId: prod.skuId || '0010',
      availabilityId: prod.availabilityId || '',
      quantity: cfg.qty
    };
    if (!item.availabilityId) { panelAdd('❌ 商品缺 availabilityId'); return Promise.resolve(null); }
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

    panelAdd('[gift] PrepareCheckout ' + item.productId + ' x' + cfg.qty + ' → ' + cfg.email);

    var headers = {
      'content-type': 'application/json',
      'accept': 'application/json, text/plain, */*',
      'origin': 'https://www.microsoft.com',
      'referer': location.href
    };
    if (ctx.cV) headers['ms-cv'] = ctx.cV;
    if (ctx.xToken) headers['authorization'] = ctx.xToken;

    return fetch('https://buynow.production.store-web.dynamics.com/v1.0/Cart/PrepareCheckout?appId=BuyNow&context=CreateOrderAndCheckout', {
      method: 'POST', headers: headers, credentials: 'include', body: JSON.stringify(body)
    })
      .then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); })
      .then(function (o) {
        var j = null;
        try { j = JSON.parse(o.text); } catch (e) {}
        if (o.status < 200 || o.status >= 300 || !j) {
          panelAdd('❌ PrepareCheckout HTTP ' + o.status);
          panelAdd('   ' + o.text.slice(0, 200));
          return null;
        }
        var cart = j.cart || j;
        var cid = cart.id || '';
        var lines = cart.lineItems || [];
        var rid = (lines[0] && lines[0].giftee && lines[0].giftee.recipientId) || '';
        if (!cid) {
          panelAdd('❌ 响应无 cart.id');
          panelAdd('   ' + o.text.slice(0, 200));
          return null;
        }
        giftCart = { id: cid, recipientId: rid, at: Date.now() };
        store.set(KEY_GCART, giftCart);
        panelAdd('✅ gift cart ' + cid.slice(0, 8) + ' · 收件人 ' + (rid ? rid.slice(0, 8) : '-'));
        panelAdd('   金额 ' + (cart.totalAmount || '?') + ' ' + (cart.currencyCode || ''));
        notify('✅ Gift cart 已建', cfg.email + ' x' + cfg.qty, cid.slice(0, 8));
        refreshPanel();
        return giftCart;
      })
      .catch(function (e) { panelAdd('❌ PrepareCheckout 异常: ' + e.message); return null; });
  }

  /** 抓当前页 ID 并写入指定槽位（'game' | 'iap'） */  /** 抓当前页 ID 并写入指定槽位（'game' | 'iap'） */
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
    try { pushShare(); } catch (e) { log('[share] push err', e); }
    // 两个都有就锁定并拉 plan
    try { pushShare(); } catch (e) {}
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
    try { pushShare(); } catch (e) {}
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

  /** 当前是否 ①② 都有 */
  function grabState() {
    var g = store.get(KEY_GAME), t = store.get(KEY_IAP);
    return !!(g && g.productId && t && t.productId);
  }

  /**
   * 全部清空：把面板上能看到的东西全部归零
   *   KEY_GAME / KEY_IAP / KEY_LOCK / KEY_PLAN / KEY_GIFT
   *   KEY_ORDER_QUEUE / KEY_APPROVED / KEY_APPROVED_TS
   *   xfg_iapMarket / xfg_lastMarket / xfg_type_* / xfg_kind_*
   *   cookie xfg_appr
   * 授权码（KEY_LICENSE）保留，那是用户订阅的凭证。
   */
  function hardReset() {
    store.del(KEY_GAME);
    store.del(KEY_IAP);
    store.del(KEY_LOCK);
    store.del(KEY_PLAN);
    try { clearGiftId(); } catch (e) {}
    store.del(KEY_ORDER_QUEUE);
    try { clearApproved(); } catch (e) {}
    store.del('xfg_iapMarket');
    store.del(KEY_PAIR);
    store.del('xfg_lastMarket');
    store.del(KEY_MARKET);

    // 清掉按商品 ID 缓存的类型/类别键
    try {
      Object.keys(localStorage || {}).forEach(function (k) {
        if (/^xfg_(type|kind)_/.test(k)) store.del(k);
      });
    } catch (e) {}
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k2 = localStorage.key(i);
        if (k2 && /^xfg_(type|kind)_/.test(k2)) localStorage.removeItem(k2);
      }
    } catch (e) {}

    planState = null;
    planPending = null;
    clearChargedSession();
    logLines = [];

    // 额外扫一遍：任何 xfg_ 前缀的遗留键全部清掉
    // （只保留授权码，用户订阅凭证不能丢）
    try {
      var keep = { 'xfg_license': 1 };
      var prefixes = ['xfg_'];
      var scan = function (storage) {
        if (!storage) return;
        var ks = [];
        for (var i = 0; i < storage.length; i++) {
          var k = storage.key(i);
          if (!k || keep[k]) continue;
          for (var p = 0; p < prefixes.length; p++) {
            if (k.indexOf(prefixes[p]) === 0) { ks.push(k); break; }
          }
        }
        ks.forEach(function (k) { try { storage.removeItem(k); } catch (e) {} });
      };
      scan(window.localStorage);
      scan(window.sessionStorage);
      // GM 里也逐个删
      if (store._hasGM && store._hasGM()) {
        ['xfg_idsGame','xfg_idsIAP','xfg_locked','xfg_plan','xfg_giftId',
         'xfg_orderQueue','xfg_approvedTime','approvedTime','xfg_targetMarket',
         'xfg_iapMarket','xfg_lastMarket'].forEach(function (k) {
          try { GM_deleteValue(k); } catch (e) {}
        });
      }
    } catch (e) { log('[reset] 扫描清理异常', e); }

    // 回读验证：清空后必须真的读不到
    var g2 = store.get(KEY_GAME), t2 = store.get(KEY_IAP);
    var still = [];
    if (g2 && g2.productId) still.push('①=' + g2.productId);
    if (t2 && t2.productId) still.push('②=' + t2.productId);

    refreshPanel();
    if (still.length) {
      panelAdd('⚠️ 清空后仍有残留: ' + still.join(' ') + '（存储未打通）');
      log('[reset] 残留', still);
    } else {
      panelAdd('✅ 已全部清空 · 请重新获取①②');
      log('[reset] 清空完成');
    }
    updateButtons();
  }

  // 面板跟随存储：别的标签页清空/获取后，这里 1.5 秒内同步
  var _lastSig = '';
  function panelSignature() {
    var g = store.get(KEY_GAME), t = store.get(KEY_IAP), lk = store.get(KEY_LOCK);
    // 过滤历史自检写入的假 ID
    if (g && /^TEST/i.test(String(g.productId || ''))) { store.del(KEY_GAME); g = null; }
    if (t && /^TEST/i.test(String(t.productId || ''))) { store.del(KEY_IAP); t = null; }
    var pt = cachedPlan();
    return [
      (g && g.productId) || '', (t && t.productId) || '',
      lk ? '1' : '0',
      pt ? 'p' : '-',
      licenseState.valid ? licenseState.remaining : 'x'
    ].join('|');
  }
  function syncIfChanged() {
    try {
      var sig = panelSignature();
      if (sig !== _lastSig) { _lastSig = sig; refreshPanel(); }
    } catch (e) {}
  }

  function refreshPanel() {
    if (!panelEl) return;
    var st = panelEl.querySelector('#xfg-state');
    if (!st) return;

    var prod = currentProduct();
    var gc = giftCfg();
    var ctx = pageCtx();
    var lc = getLicense();

    st.innerHTML =
      '<div style="padding:7px 9px;border-radius:7px;background:' + (prod ? '#0e2f12' : '#2f1212') +
        ';border:1px solid ' + (prod ? '#2f7a3a' : '#7a2f2f') + ';margin-bottom:6px">' +
        '<div style="color:#9fe6a8;font-weight:700;font-size:11px">当前商品</div>' +
        (prod
          ? '<div style="color:#fff;font-family:ui-monospace,monospace;font-size:13.5px;font-weight:700;margin-top:1px">' + esc(prod.productId) + '</div>' +
            '<div style="color:#7a8;font-size:10.5px">' + esc(prod.availabilityId || '(缺 avail)') + ' · ' + esc(prod.source) + '</div>'
          : '<div style="color:#f88;font-size:11px">未识别（请在商品页或付款页）</div>') +
      '</div>' +
      '<div style="font-size:11px;color:' + (gc.email ? '#7ee787' : '#888') + '">' +
        (gc.email ? '送礼 → ' + esc(gc.email) + ' x' + gc.qty : '送礼：未设置邮箱') +
      '</div>' +
      (giftCart.id ? '<div style="font-size:11px;color:#7ee787">Gift cart：' + esc(giftCart.id.slice(0, 8)) + '</div>' : '') +
      '<div style="font-size:11px;color:' + (ctx ? '#7fd' : '#888') + '">' +
        (ctx ? 'Context：risk ' + esc(ctx.riskId.slice(0, 8)) + ' · ' + ctx.flights.length + ' flights'
             : 'Context：仅付款页可用') +
      '</div>' +
      '<div style="font-size:11px;color:' + (lc ? '#7fd' : '#f88') + '">' +
        (lc ? '授权：剩余 ' + licenseState.remaining + ' 次' : '授权：未激活') +
      '</div>';

    if (logEl) logEl.textContent = logLines.join('\n');
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
      // 2.x 不再需要 plan
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
  function fetchPlan(force) {
    var key = planKeyOf();
    if (!key) {
      log('[plan] 缺少 ①② 或授权码，跳过请求');
      panelAdd('⚠️ plan 未请求：缺少 ①② 或授权码');
      return Promise.resolve(null);
    }
    if (!force) {
      var hit = cachedPlan();
      if (hit) { log('[plan] 使用本地缓存（不请求服务端）'); return Promise.resolve(hit); }
    }
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
        var e = {
          key: key, ops: o.j.ops || [], meta: o.j.meta || {},
          sig: o.j.sig, ttl: o.j.ttl || 600, at: Date.now(),
          remaining: (typeof o.j.remaining === 'number') ? o.j.remaining : undefined,
          charged: !!o.j.charged
        };
        store.set(KEY_PLAN, e);

        // 服务端算出 plan 时已经扣过次了：同步余额到面板
        if (typeof o.j.remaining === 'number') {
          licenseState.valid = true;
          licenseState.remaining = o.j.remaining;
          if (o.j.charged) {
            panelAdd('💰 服务端已扣次，剩余 ' + o.j.remaining + ' 次');
            refreshPanel();
          }
        }
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
    if (!plan || !Array.isArray(plan.ops)) {
      // 付款页是另一个域名/标签，缓存可能为空或 key 不匹配 → 立刻补拉
      if (!planPending) {
        log('[plan] 缓存无 plan → 立即向服务端拉取');
        try { fetchPlan(); } catch (e) { log('fetchPlan err', e); }
      }
      return null;
    }
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
  /** 兼容占位：4.7+ 不再在本地判断 Gift 档，由服务端负责 */
  function giftAvailFor() { return ''; }

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

  // 一次赠礼只扣一次（变量声明在文件顶部）

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
    if (licenseState.remaining <= 0) {
      warnOnce('lic-empty', '授权次数已用完', '请续费后再试');
      return null;
    }

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
        return r.body;
      }
      return null;
    }
    return null;
  }

  /**
   * 同一次赠礼只扣一次。
   * 「同一次」用 orderId 判定：换了订单号就是新一轮，应重新扣次。
   */
  /**
   * 替换成功就扣次 —— 不做任何拦截。
   * 每次调用都会真的请求 /api/license/consume。
   */
  /**
   * 付款页替换成功 → 扣 1 次。
   * 每次成功替换都扣，不判断是否同一笔付款。
   */
  function chargeOnce(t, g) {
    var lc = getLicense();
    if (!lc || !lc.code) {
      log('[charge] 无授权码，跳过扣次');
      return;
    }

    var mk = (t && t.market) ? String(t.market) : (inferPageMarket() || manualMarket() || 'AR');
    var iapId = (t && t.productId) ? String(t.productId).toUpperCase() : '';
    var gameId = (g && g.productId) ? String(g.productId).toUpperCase() : '';

    log('[charge] 请求扣次 iap=' + iapId + ' market=' + mk);
    panelAdd('⏳ 扣次中…');

    fetch(SERVER_BASE + '/api/license/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({
        code: lc.code,
        market: mk,
        iap: iapId,
        game: gameId
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) {
          var msg = (j && j.error) || '扣次失败';
          log('[charge] 失败: ' + msg);
          panelAdd('❌ 扣次失败: ' + msg);
          return;
        }
        licenseState.valid = true;
        licenseState.remaining = j.data.remaining;
        log('[charge] 成功 剩余 ' + j.data.remaining);
        panelAdd('💰 已扣 1 次，剩余 ' + j.data.remaining + ' 次');
        refreshPanel();
      })
      .catch(function (e) {
        log('[charge] 异常: ' + e.message);
        panelAdd('❌ 扣次异常: ' + e.message);
      });
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
  // 同一个表单只处理一次（submit / requestSubmit / 事件 / 巡检 四个入口共用）
  var _patchedForms = new WeakSet();

  /** 设置表单字段，没有就新增隐藏域 */
  function setFormField(form, name, val) {
    for (var i = 0; i < form.elements.length; i++) {
      var el = form.elements[i];
      if (el && el.name === name) { el.value = String(val == null ? '' : val); return true; }
    }
    try {
      var inp = document.createElement('input');
      inp.type = 'hidden';
      inp.name = name;
      inp.value = String(val == null ? '' : val);
      form.appendChild(inp);
      return true;
    } catch (e) { return false; }
  }

  function patchBuynowForm(form) {
    try {
      if (!form || !isBuynowAction(form.action)) return 0;
      if (_patchedForms.has(form)) { log('[form] 该表单已处理过，跳过'); return 0; }
      _patchedForms.add(form);

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
      // 【2.0.0】不换商品，改为把订单转成「送礼」
      //   商品 = 当前页面的这个，加 giftee（收件邮箱）+ 数量
      //   scenario → gift，产物变成可兑换数字码
      // ============================================================
      var gc = giftCfg();
      if (!gc.email) {
        log('[form] 未设收码邮箱 → 保持家庭组代付');
        panelAdd('ℹ️ 未设收码邮箱，本次仍走家庭组代付');
        return 0;
      }

      var prod = currentProduct();
      if (!prod) { panelAdd('❌ 拿不到当前商品'); return 0; }

      var item = {
        productId: prod.productId,
        skuId: prod.skuId || '0010',
        availabilityId: prod.availabilityId || ''
      };
      if (!item.availabilityId) {
        try {
          var oldArr = JSON.parse(inp.value);
          if (Array.isArray(oldArr) && oldArr[0] && oldArr[0].availabilityId) {
            item.availabilityId = oldArr[0].availabilityId;
          }
        } catch (e) {}
      }
      if (!item.availabilityId) { panelAdd('❌ 商品缺 availabilityId'); return 0; }
      if (gc.qty > 1) item.quantity = gc.qty;

      log('[form] 原 products=' + String(inp.value).slice(0, 120));
      inp.value = JSON.stringify([item]);
      panelAdd('[form] products → ' + item.productId + '/' + item.availabilityId + ' x' + gc.qty);

      var mk = targetMarket() || '';

      // ---- 转送礼 ----
      setFormField(form, 'market', market());
      setFormField(form, 'scenario', 'gift');
      setFormField(form, 'callerApplicationId', 'XboxCom');
      setFormField(form, 'cssOverride', 'XboxCom2NewUI');
      setFormField(form, 'parentHostName', 'www.xbox.com');
      setFormField(form, 'suppressGiftThankYouPage', 'true');
      if (giftCart.id) setFormField(form, 'cartId', giftCart.id);
      setFormField(form, 'gifteeEmail', gc.email);
      setFormField(form, 'gifteeSenderName', gc.sender);

      try {
        if (form.action) form.action = form.action.replace(/([?&]scenario=)[^&]*/, '$1gift');
      } catch (e) {}

      panelAdd('✅ 已转送礼 · ' + item.productId + ' x' + gc.qty + ' → ' + gc.email);
      notify('✅ 付款页已转送礼', item.productId + ' x' + gc.qty, gc.email);
      try { chargeOnce(item, null); } catch (e) { log('charge err', e); }
      return 1;
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

      var gc = giftCfg();
      if (!gc.email) return u;

      var prod = currentProduct();
      if (!prod) return u;

      var m = s2.match(/[?&]products=([^&]*)/);
      if (m) {
        var item = { productId: prod.productId, skuId: prod.skuId || '0010', availabilityId: prod.availabilityId || '' };
        if (!item.availabilityId) {
          try { item.availabilityId = JSON.parse(decodeURIComponent(m[1]))[0].availabilityId; } catch (e) {}
        }
        if (gc.qty > 1) item.quantity = gc.qty;
        s2 = s2.replace(/([?&]products=)[^&]*/, '$1' + encodeURIComponent(JSON.stringify([item])));
      }

      if (/[?&]scenario=/.test(s2)) s2 = s2.replace(/([?&]scenario=)[^&]*/, '$1gift');
      else s2 += '&scenario=gift';

      log('[url] → gift · ' + prod.productId + ' x' + gc.qty);
      return s2;
    } catch (e) { return u; }
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
  // 跨窗口同步轮询：15 秒一次，只在有授权码时跑
  setInterval(function () {
    try { if (shareCode()) pullShare(false); } catch (e) {}
  }, 15000);

  setInterval(function () {
    try { syncIfChanged(); } catch (e) {}
    try { inferApprovedFromDom(); } catch (e) {}
    try {
      const forms = PAGE.document ? PAGE.document.querySelectorAll('form') : [];
      for (let i = 0; i < forms.length; i++) {
        var f = forms[i];
        if (!isBuynowAction(f.action)) continue;
        patchBuynowForm(f);   // 内部已做唯一性判断（同一表单只处理一次）
      }
    } catch (e) {}
  }, 1500);
  log('v5.0.2 injected (订单队列 + 会话锁扣次)');

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
        var lic2 = getLicense();
        if (!lic2) return notify("授权", "未激活", "请先输入授权码");
        var r = await verifyLicense();
        if (!r.ok) notify("授权", r.error || "无效", "");
        else notify("授权", "剩余 " + r.remaining + " 次", "");
      });
      GM_registerMenuCommand("查看当前商品", () => {
        var pr = currentProduct();
        notify("当前商品", pr ? (pr.productId + " / " + pr.availabilityId) : "未识别",
               pr ? ("来源: " + pr.source) : "请在商品页或付款页");
      });
      GM_registerMenuCommand("设置收码邮箱", () => {
        var gc = giftCfg();
        var raw = prompt("收码邮箱：", gc.email || "");
        if (raw === null) return;
        raw = raw.trim();
        if (!raw) { store.del(KEY_GC); notify("送礼", "已清除", ""); refreshPanel(); return; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) { notify("设置失败", "邮箱格式不正确", ""); return; }
        store.set(KEY_GC, { email: raw, sender: gc.sender, qty: gc.qty });
        notify("送礼邮箱", raw, "");
        refreshPanel();
      });
      GM_registerMenuCommand("设置送礼数量", () => {
        var gc = giftCfg();
        var raw = prompt("数量（1-10）：", String(gc.qty || 1));
        if (raw === null) return;
        var q = parseInt(raw, 10);
        if (!q || q < 1 || q > 10) { notify("设置失败", "数量需 1-10", ""); return; }
        store.set(KEY_GC, { email: gc.email, sender: gc.sender, qty: q });
        notify("送礼数量", "x" + q, "");
        refreshPanel();
      });
      GM_registerMenuCommand("建 Gift Cart（付款页用）", () => {
        prepareGiftCart();
      });
      GM_registerMenuCommand("清空送礼设置", () => {
        store.del(KEY_GC);
        store.del(KEY_GCART);
        giftCart = { id: '', recipientId: '', at: 0 };
        notify("已清空", "送礼设置已重置", "");
        refreshPanel();
      });
    }
  } catch (e) {}

  // 版本自检：控制台 + 面板都能确认当前跑的是哪一版
  try {
    console.log('%c[XFG] running v2.2.1', 'color:#107C10;font-weight:700',
      '| 送礼取码 | PrepareCheckout + scenario=gift');
  } catch (e) {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    setTimeout(buildPanel, 0);
  }

  // 环境诊断：确认脚本跑起来了
  setTimeout(function () {
    var P = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    var hasState = false;
    try { hasState = !!P.__STORE_CART_STATE__; } catch (e) {}
    var pr = currentProduct();
    var sg = store.get(KEY_GAME);
    panelAdd('环境 · top=' + (window.top === window.self ? '主窗口' : 'iframe') +
             ' · STATE=' + (hasState ? '有' : '无') +
             ' · store=' + (sg && sg.productId ? sg.productId : '无') +
             ' · 商品=' + (pr ? pr.productId + '(' + pr.source + ')' : '未识别'));
  }, 1500);

  // ============================================================
  // 自动建 gift cart
  // ------------------------------------------------------------
  // 付款页 context 一就绪就自动执行，不需要手点按钮。
  // 条件：有收码邮箱 + 有商品 + 还没有 cart
  // ============================================================
  function tryAutoBuild() {
    if (autoBuildTried) return;
    var gc = giftCfg();
    if (!gc.email) return;                 // 没邮箱就不建
    if (giftCart.id) return;               // 已有就不重复
    var ctx = pageCtx();
    if (!ctx || !ctx.riskId || !ctx.xToken) return;   // context 还没准备好
    var prod = currentProduct();
    if (!prod) return;

    autoBuildTried = true;
    log('[auto] context 就绪 → 自动建 gift cart');
    panelAdd('[auto] 自动建 gift cart…');
    prepareGiftCart();
  }

  // 付款页：轮询等 context，就绪即自动建
  if (isPayUrl()) {
    var payTries = 0;
    var payTimer = setInterval(function () {
      payTries++;
      tryAutoBuild();
      if (autoBuildTried || payTries > 40) {
        clearInterval(payTimer);
        if (!autoBuildTried) panelAdd('⚠️ 30 秒内未就绪（检查收码邮箱/商品/context）');
      }
    }, 800);
  } else {
    // 商品页：也试着建（部分页面有 context）
    var tries2 = 0;
    var t2 = setInterval(function () {
      tries2++;
      tryAutoBuild();
      if (autoBuildTried || tries2 > 10) clearInterval(t2);
    }, 1000);
  }

  // 启动：后台校验授权 + 有新赠礼流程时重置扣次标志
  setTimeout(function () {
    backgroundVerify();
  }, 800);

  // 采集被清空 = 新一轮赠礼，重置幂等与扣次标志
  var _origDel = store.del.bind(store);
  store.del = function (k) {
    if (k === KEY_LOCK) { clearGiftId(); }
    return _origDel(k);
  };

  log("v2.2.1 injected (gift-code build)");
})();
