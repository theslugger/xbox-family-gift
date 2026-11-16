// ==UserScript==
// @name         Xbox 家庭组内购送礼（网页版）
// @namespace    https://github.com/theslugger/xbox-family-gift
// @version      4.5.6
// @description  子号加购游戏/内购 → 子号发起 → 主号 family safety 批准 → 付款时换成内购。需授权码激活（4.5.6：商品类别校验，修①②放反导致的 FailedToHydrate）
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
  }
  function clearLicense() { store.del(KEY_LICENSE); }

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

  function buildPanel() {
    if (panelEl || !document.body) return;
    panelEl = document.createElement('div');
    panelEl.id = 'xfg-panel';
    panelEl.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;width:330px;' +
      'background:#0b0b0b;color:#eee;border:1px solid #107C10;border-radius:10px;' +
      'font:12px/1.45 -apple-system,Segoe UI,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden';

    panelEl.innerHTML =
      '<div id="xfg-hd" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#107C10;cursor:pointer">' +
        '<b>Xbox 送礼脚本 v4.5.6</b><span style="font-size:10px;opacity:.8">' + location.host + '</span><span id="xfg-tg" style="margin-left:8px">收起</span>' +
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
        '<button id="xfg-align" style="flex:1;padding:5px;background:#1a3a2a;color:#8fe;border:1px solid #365;border-radius:6px;cursor:pointer">自动对齐</button>' +
        '<button id="xfg-lic" style="flex:1;padding:5px;background:#2a1a3a;color:#c8f;border:1px solid #536;border-radius:6px;cursor:pointer">授权</button>' +
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
      var mk = normMarket(raw);
      if (!raw.trim()) { store.del(KEY_MARKET); panelAdd('目标市场：跟随订单'); refreshPanel(); return; }
      if (!mk) { panelAdd('❌ 无法识别市场码「' + raw + '」，请输入 AR / US / JP 这类两字母代码'); return; }
      store.set(KEY_MARKET, mk);
      var loc = MARKET_LOCALE[mk] || mk.toLowerCase();
      panelAdd('目标市场已设为 ' + mk + '（订单/付款页都会用这个市场）');
      panelAdd('请到 https://www.xbox.com/' + loc + '/ 重新加购游戏和内购');
      // 已有 ID 若不属于该市场，立即提示
      var g0 = store.get(KEY_GAME), t0 = store.get(KEY_IAP);
      if (g0 && t0) {
        var c = checkMarket([{ which: '游戏', id: g0 }, { which: '内购', id: t0 }], mk);
        if (!c.ok) {
          c.bad.forEach(function (b) {
            panelAdd('⚠️ ' + b.which + '属于 ' + b.real + '（' + b.aid + '），需重新采集');
          });
          notify('⚠️ 已采集 ID 与 ' + mk + ' 不符', '请到 /' + loc + '/ 重新加购', '否则会跳过替换');
        }
      }
      refreshPanel();
      try { autoAlignCaptured(); } catch (e) {}
    });
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

    panelEl.querySelector('#xfg-align').addEventListener('click', function () {
      var mk = targetMarket();
      if (!mk) { panelAdd('未设目标市场，先点「市场」设置 AR/US/JP'); return; }
      var g = store.get(KEY_GAME), t = store.get(KEY_IAP);
      if (!g && !t) { panelAdd('还没有采集到 ID，请先加购'); return; }
      panelAdd('正在按 ' + mk + ' 解析游戏和内购…');
      Promise.all([
        g ? resolveItem(g, mk, '游戏') : null,
        t ? resolveItem(t, mk, '内购') : null
      ]).then(function (rs) {
        var okN = rs.filter(Boolean).length;
        if (!okN) { panelAdd('❌ ' + mk + ' 市场找不到对应商品'); }
        else { panelAdd('✅ 已按 ' + mk + ' 对齐 ' + okN + ' 项'); }
        refreshPanel();
      });
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
      '<div style="margin-top:4px">状态: ' + (lk ? '<b style="color:#ff0">🔒 已锁定</b>' : '<span style="color:#888">采集中</span>') + '</div>' +
      (function () {
        var lic = getLicense();
        if (!lic) return '<div style="margin-top:2px;color:#f77">授权: <b>未激活</b> — 点「授权」输入</div>';
        if (!licenseState.valid) return '<div style="margin-top:2px;color:#f77">授权: <b>校验中/异常</b></div>';
        return '<div style="margin-top:2px;color:#7fd">授权: 剩余 <b>' + licenseState.remaining + '</b> 次</div>';
      })() +
      (function () {
        var tgt = targetMarket();
        if (!tgt) return '<div style="margin-top:2px;color:#888">市场: 跟随订单</div>';
        var c = (g && t) ? checkMarket([{ which: '游戏', id: g }, { which: '内购', id: t }], tgt) : { ok: true, bad: [] };
        var loc = MARKET_LOCALE[tgt] || tgt.toLowerCase();
        var col = c.ok ? '#7fd' : '#f77';
        var extra = c.ok ? '' : '<br><span style="color:#f77">中 ' + c.bad.map(function (b) { return b.which + '是' + b.real; }).join('、') + '，去 /' + loc + '/ 重采</span>';
        return '<div style="margin-top:2px;color:' + col + '">市场: <b>' + tgt + '</b> (/' + loc + '/)' + extra + '</div>';
      })();
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
  /**
   * 记录商品类型线索
   * 来源：loadCart 的响应里通常带 productKind / ProductKind
   * 存成 xfg_kind_<productId> = 'iap' | 'game'
   */
  function recordKindHint(ids) {
    if (!ids || !ids.productId) return;
    var k = ids.productKind || ids.kind;
    if (!k) return;
    var tag = /consumable|iap|addon|durable/i.test(k) ? 'iap'
            : /^game$/i.test(k) ? 'game' : '';
    if (tag) store.set('xfg_kind_' + ids.productId, tag);
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

    // 记录商品类型线索：从页面/接口能判断的就记下来，供购物车快照分流用
    for (const ids of items) {
      try { recordKindHint(ids); } catch (e) {}
      try { classifyProduct(ids.productId); } catch (e) {}
    }

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
    }
    refreshPanel();
  }

  function swapOne(obj, g, t) {
    if (!(t.productId && t.availabilityId)) return 0;
    if (obj.productId !== g.productId) return 0;
    obj.productId = t.productId;
    if (obj.availabilityId !== undefined) obj.availabilityId = t.availabilityId;
    if (obj.skuId !== undefined && t.skuId) obj.skuId = t.skuId;
    return 1;
  }
  // availabilityId 是按市场分配的；同一 productId+skuId 在不同市场有不同 availabilityId
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
  function alignAvail(t, orderMarket) {
    if (!t || !t.productId) return t;
    var mk = normMarket(orderMarket);
    if (!mk) return t;
    var m = AVAIL_BY_MARKET[String(t.productId).toUpperCase()];
    if (!m) return t;
    var want = m[mk];
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
    let n = 0;
    // 市场必须与内购 ID 所属市场一致，否则 DisplayCatalog 404
    // 优先：保持订单原 market，把内购 availabilityId 换成该市场对应的值
    // 目标市场优先（面板/菜单设定），否则跟随订单
    var tgt = targetMarket();
    var orderMk = tgt || normMarket(o.market);
    if (orderMk) t = alignAvail(t, orderMk);
    if (orderMk && normMarket(o.market) !== orderMk) {
      log('订单市场 ' + (o.market || '?') + ' -> ' + orderMk);
      o.market = orderMk;
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
  // ============================================================
  // 商品类别识别（HAR+DisplayCatalog 实证）：
  //   9P6LX2D15SD7 → ProductType=Consumable（Apex Legends 500 Coins）= 内购
  //   9PKVLFR97PKL → ProductType=Game（Neon Apex: Beyond the Limit）= 游戏
  //   buynow 把 Consumable 当成 parentApproval 的商品提交 → FailedToHydrate-ProductNotFound
  // 所以面板 ①② 放反时必须拦住，不能让它进付款页。
  // ============================================================
  var KIND_CACHE = {};          // productId -> 'game' | 'consumable' | 'durable' | ''
  function classifyProduct(pid) {
    if (!pid) return;
    pid = String(pid).toUpperCase();
    if (KIND_CACHE[pid] !== undefined) return;
    KIND_CACHE[pid] = '';
    try {
      fetch('https://displaycatalog.mp.microsoft.com/v7.0/products/' +
            encodeURIComponent(pid) + '?market=US&languages=en-us&fieldsTemplate=Details',
            { credentials: 'omit' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (o) {
          var p = o && o.Product;
          var t = (p && p.ProductType) ? String(p.ProductType).toLowerCase() : '';
          KIND_CACHE[pid] = t;
          var title = '';
          try { title = p.LocalizedProperties[0].ProductTitle || ''; } catch (e) {}
          log('[kind] ' + pid + ' → ' + (t || '未知') + (title ? ' · ' + title : ''));
          store.set('xfg_type_' + pid, { type: t, title: title });
          refreshPanel();
        })
        .catch(function () { KIND_CACHE[pid] = ''; });
    } catch (e) {}
  }
  function kindOf(ids) {
    if (!ids || !ids.productId) return '';
    var pid = String(ids.productId).toUpperCase();
    if (KIND_CACHE[pid] !== undefined) return KIND_CACHE[pid];
    var rec = store.get('xfg_type_' + pid);
    if (rec && rec.type) { KIND_CACHE[pid] = rec.type; return rec.type; }
    classifyProduct(pid);
    return '';
  }
  // ①② 放反检测：①必须是 Game，②必须是 Consumable/Durable
  function checkKindOrder(g, t) {
    var kg = kindOf(g), kt = kindOf(t);
    if (!kg || !kt) return { ok: true, pending: true };
    if (kg === 'game' && (kt === 'consumable' || kt === 'durable' || kt === 'addon')) return { ok: true };
    if (kt === 'game' && (kg === 'consumable' || kg === 'durable' || kg === 'addon')) {
      return { ok: false, swapped: true, kg: kg, kt: kt };
    }
    if (kg === 'consumable' || kg === 'durable') return { ok: false, swapped: true, kg: kg, kt: kt };
    return { ok: true };
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
    const tgt = targetMarket();
    const formMarket = tgt || normMarket(unq(d['market'] || ''));
    let tt = t;
    if (formMarket && t && t.productId) tt = alignAvail(t, formMarket);
    // ①② 放反 → 拒绝替换（Consumable 当 parentApproval 商品会 ProductNotFound）
    var ko = checkKindOrder(g, t);
    if (!ko.ok && ko.swapped) {
      notify('⚠️ ①② 放反了，已跳过替换',
        '①是 ' + ko.kg + '，②是 ' + ko.kt,
        '点面板「交换①②」把游戏放①、内购放②，再重新发起');
      log('[buynow] kind 放反: ①=' + ko.kg + ' ②=' + ko.kt + ' → 跳过');
      return null;
    }
    // HAR 教训：内购 availabilityId B0N520SW1VC1 不属于 AR（也查不到归属），
    // 换上去 buynow 直接 FailedToHydrate-ProductNotFound。宁可不动，也别换脏 ID。
    if (formMarket) {
      var iapMk = marketOfAvail(tt.availabilityId) || normMarket(tt.market || '');
      if (iapMk && normMarket(formMarket) && iapMk !== normMarket(formMarket)) {
        notify('⚠️ 内购 ID 与付款市场不符，已跳过替换',
          '内购 ' + iapMk + ' / 付款 ' + formMarket,
          '去 /' + (MARKET_LOCALE[iapMk] || iapMk.toLowerCase()) + '/ 重新加购内购');
        log('[buynow] availabilityId ' + tt.availabilityId + ' 市场=' + iapMk + ' 与 form market=' + formMarket + ' 不符，跳过');
        return null;
      }
    }
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
  // ============================================================
  // 跨市场自动解析：拿 productId + skuId 去 DisplayCatalog 查目标市场
  // 选出「有非零价格」的 availabilityId，避开 0.0 的试用/免费条目
  // 结果缓存，避免重复请求
  // ============================================================
  var RESOLVE_CACHE = {};   // key = productId|skuId|market  -> {availabilityId, price, currency}
  var RESOLVING = {};       // 进行中的请求，防止并发重复

  function catalogUrl(pid, mk) {
    var lc = 'en-us';
    var LOC_BY_MARKET = MARKET_LOCALE;
    if (LOC_BY_MARKET[mk]) lc = LOC_BY_MARKET[mk];
    return 'https://displaycatalog.mp.microsoft.com/v7.0/products/' +
      encodeURIComponent(pid) + '?market=' + encodeURIComponent(mk) +
      '&languages=' + encodeURIComponent(lc) + '&fieldsTemplate=Details';
  }

  // 从 catalog 响应里挑最佳 availabilityId
  function pickAvail(o, skuWanted) {
    var p = o && (o.Product || (o.Payload && o.Payload.Products && o.Payload.Products[0]));
    if (!p) return null;
    var best = null;
    (p.DisplaySkuAvailabilities || []).forEach(function (a) {
      var sku = a.Sku && a.Sku.SkuId;
      if (skuWanted && sku && sku !== skuWanted) return;
      (a.Availabilities || []).forEach(function (av) {
        var aid = av.AvailabilityId;
        if (!aid) return;
        var pr = (av.OrderManagementData || {}).Price || {};
        var list = Number(pr.ListPrice);
        if (!isFinite(list)) list = 0;
        // 只要非零价；多个非零时取第一个（通常就是标准档）
        if (list > 0 && !best) {
          best = { availabilityId: aid, price: list, currency: pr.CurrencyCode || '', skuId: sku };
        }
      });
    });
    // 全是 0 价时退而取第一个有 id 的，至少结构完整
    if (!best) {
      (p.DisplaySkuAvailabilities || []).forEach(function (a) {
        if (best) return;
        var sku = a.Sku && a.Sku.SkuId;
        if (skuWanted && sku && sku !== skuWanted) return;
        (a.Availabilities || []).forEach(function (av) {
          if (best || !av.AvailabilityId) return;
          var pr = (av.OrderManagementData || {}).Price || {};
          best = { availabilityId: av.AvailabilityId, price: Number(pr.ListPrice) || 0, currency: pr.CurrencyCode || '', skuId: sku };
        });
      });
    }
    return best;
  }

  // 同步读缓存
  function resolveCached(item, mk) {
    if (!item || !item.productId || !mk) return null;
    var k = item.productId + '|' + (item.skuId || '') + '|' + mk;
    return RESOLVE_CACHE[k] || null;
  }

  // 异步解析；成功后回写 store 并刷新面板
  function resolveItem(item, mk, which) {
    return new Promise(function (resolve) {
      if (!item || !item.productId || !mk) return resolve(null);
      var k = item.productId + '|' + (item.skuId || '') + '|' + mk;
      if (RESOLVE_CACHE[k]) return resolve(RESOLVE_CACHE[k]);
      if (RESOLVING[k]) return RESOLVING[k].then(resolve, function () { resolve(null); });
      var p = fetch(catalogUrl(item.productId, mk), { credentials: 'omit' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (o) {
          var got = pickAvail(o, item.skuId);
          if (!got) { log('解析失败：' + item.productId + ' 在 ' + mk + ' 无可用条目'); return null; }
          RESOLVE_CACHE[k] = got;
          log('解析 ' + which + ' ' + item.productId + ' @' + mk + ' -> ' + got.availabilityId + ' (' + got.price + ' ' + got.currency + ')');
          return got;
        })
        .catch(function (e) { log('解析异常', e); return null; })
        .then(function (got) {
          delete RESOLVING[k];
          if (!got) return null;
          // 回写 store，让后续替换直接用
          var cur = store.get(which === '游戏' ? KEY_GAME : KEY_IAP);
          if (cur && cur.productId === item.productId) {
            cur.availabilityId = got.availabilityId;
            if (got.skuId) cur.skuId = got.skuId;
            cur.market = mk;
            store.set(which === '游戏' ? KEY_GAME : KEY_IAP, cur);
            notify('🔄 已按 ' + mk + ' 自动纠正' + which, got.availabilityId,
              got.price ? (got.price + ' ' + got.currency) : '');
            refreshPanel();
          }
          resolve(got);
        });
      RESOLVING[k] = p;
    });
  }

  // 采集后立刻尝试对齐目标市场；返回 true 表示当前 ID 已可用（或无需处理）
  function autoAlignCaptured() {
    var mk = targetMarket();
    if (!mk) return;
    var g = store.get(KEY_GAME), t = store.get(KEY_IAP);
    var jobs = [];
    if (g && g.productId && normMarket(g.market) !== mk) jobs.push(resolveItem(g, mk, '游戏'));
    if (t && t.productId && normMarket(t.market) !== mk) jobs.push(resolveItem(t, mk, '内购'));
    if (!jobs.length) return;
    Promise.all(jobs).then(function () {
      var c = checkMarket([
        { which: '游戏', id: store.get(KEY_GAME) },
        { which: '内购', id: store.get(KEY_IAP) }
      ], mk);
      if (!c.ok) {
        c.bad.forEach(function (b) {
          panelAdd('⚠️ ' + b.which + ' 仍属于 ' + b.real + '，无法在 ' + mk + ' 找到对应条目');
        });
      }
    });
  }

  // 采集结果与目标市场不符时，明确提示应去哪加购，而不是带着错 ID 去下单
  var warnedMarket = '';
  function guardMarket(g, t) {
    var tgt = targetMarket();
    if (!tgt) return true;
    // 先看有没有已解析好的市场版本，有就直接用，避免拦下本该成功的请求
    var rg = resolveCached(g, tgt), rt = resolveCached(t, tgt);
    if (rg && rg.availabilityId !== g.availabilityId) {
      g.availabilityId = rg.availabilityId; g.market = tgt;
      store.set(KEY_GAME, g); log('替换前套用已解析游戏ID', rg.availabilityId);
    }
    if (rt && rt.availabilityId !== t.availabilityId) {
      t.availabilityId = rt.availabilityId; if (rt.skuId) t.skuId = rt.skuId; t.market = tgt;
      store.set(KEY_IAP, t); log('替换前套用已解析内购ID', rt.availabilityId);
    }
    var c = checkMarket([{ which: '游戏', id: g }, { which: '内购', id: t }], tgt);
    if (c.ok) { warnedMarket = ''; return true; }
    // 还没解析过就开始解析，下次请求就能用上
    try { resolveItem(g, tgt, '游戏'); resolveItem(t, tgt, '内购'); } catch (e) {}
    var key = tgt + '|' + c.bad.map(function (b) { return b.which + b.real; }).join(',');
    if (warnedMarket !== key) {
      warnedMarket = key;
      var loc = MARKET_LOCALE[tgt] || tgt.toLowerCase();
      var msgs = c.bad.map(function (b) {
        return b.which + ' 属于 ' + b.real + '（' + b.aid + '）';
      }).join('；');
      notify('⚠️ 地区不匹配，已跳过替换', '目标 ' + tgt + '，实际：' + msgs,
        '请到 www.xbox.com/' + loc + '/ 重新加购游戏与内购，或把「市场」改成 ID 所属地区');
      log('地区校验失败，阻止替换', c.bad);
    }
    return false;
  }

  // 一次赠礼只扣一次：同一 giftId 内只在首次成功替换时扣
  let giftConsumed = false;

  function maybeSwap(url, bodyStr) {
    if (typeof bodyStr !== 'string' || !bodyStr) return null;
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
      // HAR 实证（2026-11-16T03:50:03.599Z，POST /v7.0/users/me/orders → 201）：
      //   body = {"market":"AR","language":"es-AR","items":[
      //     {"productId":"9PKVLFR97PKL","availabilityId":"B0N520SW1VC1","skuId":"0010",
      //      "beneficiary":{"identityType":"Msa","identityValue":"<子号 puid>"}}]}
      //   订单被换成【内购】→ approve 也跟着内购 →
      //   buynow 收到 products=[游戏 9P6LX2D15SD7 / AR availabilityId B2XRTR8KPHPM]
      //   与订单商品不一致 → 目录解析失败 → FailedToHydrate-ProductNotFound（付款页报错）。
      //
      // 结论：orders 阶段【永远不换】。这里是子号发起申请 / 主号批准建单，
      // 一旦换掉就破坏 buynow 的商品一致性。唯一改写点 = buynow 表单。
      // ============================================================
      log('[orders] 建单/批准阶段：一律保持原样，不替换');
      return null;
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
            ' 首项=' + ((p0[0] && p0[0].productId) || '?') + '/' + ((p0[0] && p0[0].availabilityId) || '?'));
      } catch (e) {}

      // 必须是家庭组批准链路
      var isFam = /AMCFamilySafety/i.test(bodyStr) || /parentApproval/i.test(bodyStr);
      if (!isFam) {
        log('buynow：非家庭组链路，不替换');
        return null;
      }
      // 必须有 purchaseOrderId = 主号批准后的付款页（HAR 实测：39bfe4f4-…）
      if (!/purchaseOrderId=[^&]+/i.test(bodyStr)) {
        log('buynow：无 purchaseOrderId → 发起申请阶段，不替换');
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

      // ---- 授权闸门 ----
      if (!getLicense() || !licenseState.valid) { warnOnce('form-no-lic', '未激活授权', '请在面板点「授权」输入授权码'); return 0; }

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
      if (!famSig) { log('[form] 非家庭组链路 → 不替换'); return 0; }
      if (!poid) {
        log('[form] 无 purchaseOrderId → 发起申请阶段，不替换');
        warnOnce('form-no-poid', '这是「发起申请」阶段', '等主号批准后到付款页才会换成内购');
        return 0;
      }

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
      const tgt = targetMarket();
      if (tgt) mk = tgt;
      let tt = t;
      if (mk) tt = alignAvail(t, mk);
      // 付款页市场与内购 availabilityId 所属市场不一致 → 下单必报错，宁可不换
      if (mk) {
        var iapMk = marketOfAvail(tt.availabilityId) || normMarket(tt.market || '');
        if (iapMk && iapMk !== normMarket(mk)) {
          notify('⚠️ 付款页市场不符，已跳过替换', '页面 ' + mk + ' / 内购 ' + iapMk,
            '请到 /' + (MARKET_LOCALE[iapMk] || iapMk.toLowerCase()) + '/ 重新加购内购');
          return 0;
        }
      }

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
  log('v4.5.6 injected (orders 永不替换 + buynow 单点替换 + 商品类别校验)');

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
    console.log('%c[XFG] running v4.5.6', 'color:#107C10;font-weight:700',
      '| orders 分支已禁替换 | 唯一替换点=buynow 表单');
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

  log("v4.0 injected (licensed build)");
})();
