// ==UserScript==
// @name         Xbox 家庭组内购送礼
// @namespace    https://github.com/theslugger/xbox-family-gift
// @version      6.0.0
// @description  采集会话并交由服务端完成全部操作
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
// @connect      xbox.aappe.uk
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  var S = 'https://xbox.aappe.uk';
  var K_CODE = 'k_code', K_SID = 'k_sid', K_GAME = 'k_g', K_IAP = 'k_i', K_LOG = 'k_log';

  function g(k) {
    try {
      if (typeof GM_getValue === 'function') {
        var v = GM_getValue(k, '');
        if (v) return JSON.parse(v);
      }
    } catch (e) {}
    try { var v2 = localStorage.getItem(k); return v2 ? JSON.parse(v2) : null; } catch (e) { return null; }
  }
  function s(k, v) {
    var t = JSON.stringify(v);
    try { if (typeof GM_setValue === 'function') GM_setValue(k, t); } catch (e) {}
    try { localStorage.setItem(k, t); } catch (e) {}
  }
  function d(k) {
    try { if (typeof GM_deleteValue === 'function') GM_deleteValue(k); } catch (e) {}
    try { localStorage.removeItem(k); } catch (e) {}
  }

  var logs = [];
  function log(m) {
    var line = new Date().toLocaleTimeString() + ' ' + m;
    logs.push(line);
    if (logs.length > 40) logs.shift();
    s(K_LOG, logs);
    renderLog();
  }

  function pid() {
    var u = location.href;
    var m = u.match(/\/store\/(?:apps|pdp|games)\/[^/]*\/([A-Z0-9]{12})\b/i) ||
            u.match(/\/p\/([A-Z0-9]{12})\b/i) ||
            u.match(/\b([A-Z0-9]{12})\b/);
    return m ? m[1].toUpperCase() : '';
  }
  function market() {
    var m = (location.pathname || '').match(/\/([a-z]{2})-([a-z]{2})(\/|$)/i);
    return m ? (m[1] + m[2]).toUpperCase() : '';
  }

  var el, body, logBox;

  function css() {
    return 'position:fixed;right:14px;bottom:14px;z-index:2147483646;width:320px;background:#0d1117;' +
      'color:#e6edf3;border:1px solid #30363d;border-radius:10px;font:12px/1.5 -apple-system,Segoe UI,sans-serif;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden';
  }
  function btn(id, text, bg, color, bd) {
    return '<button id="' + id + '" style="flex:1;padding:6px;background:' + bg + ';color:' + color +
      ';border:1px solid ' + bd + ';border-radius:6px;cursor:pointer;font:inherit">' + text + '</button>';
  }

  function build() {
    if (el || !document.body) return;
    if (window.top !== window.self) return;
    if (/\/store\/purchase\/buynowui\/buynow/i.test(location.href)) return;

    el = document.createElement('div');
    el.id = 'xfg';
    el.style.cssText = css();
    el.innerHTML =
      '<div id="h" style="display:flex;justify-content:space-between;padding:8px 10px;background:#107C10;cursor:pointer">' +
        '<b>Xbox 送礼 v6.0.0</b><span style="font-size:10px;opacity:.85">' + location.host + '</span>' +
        '<span id="t">收起</span></div>' +
      '<div id="b" style="padding:10px">' +
        '<div id="st"></div>' +
        '<div id="lg" style="max-height:130px;overflow:auto;background:#000;border-radius:6px;padding:6px;' +
          'font:11px/1.45 ui-monospace,Menlo,monospace;color:#9c9;white-space:pre-wrap;margin-top:8px"></div>' +
        '<div style="display:flex;gap:6px;margin-top:8px">' +
          btn('g1', '获取①游戏', '#0d2a0d', '#7fd', '#2a5') +
          btn('g2', '获取②内购', '#0d2a0d', '#7fd', '#2a5') +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:6px">' +
          btn('run', '上传并执行', '#123a1a', '#9f9', '#2f7a3a') +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:6px">' +
          btn('lic', '授权', '#1f1635', '#c8f', '#536') +
          btn('clr', '清空', '#2a1212', '#f99', '#633') +
        '</div>' +
      '</div>';
    document.documentElement.appendChild(el);

    body = el.querySelector('#b');
    logBox = el.querySelector('#lg');
    el.querySelector('#h').onclick = function () {
      var hid = body.style.display === 'none';
      body.style.display = hid ? '' : 'none';
      el.querySelector('#t').textContent = hid ? '收起' : '展开';
    };

    el.querySelector('#g1').onclick = function () { pick(K_GAME, '① 游戏'); };
    el.querySelector('#g2').onclick = function () { pick(K_IAP, '② 内购'); };
    el.querySelector('#run').onclick = run;
    el.querySelector('#lic').onclick = auth;
    el.querySelector('#clr').onclick = clear;

    render();
  }

  function pick(key, label) {
    var p = pid();
    if (!p) { log('❌ 当前页面没有商品 ID'); return; }
    s(key, { productId: p, market: market() });
    log('✅ ' + label + ' = ' + p + (market() ? ' @' + market() : ''));
    render();
  }

  function auth() {
    var cur = g(K_CODE);
    var raw = prompt('输入授权码（留空=清除）：', cur ? cur.code : '');
    if (raw === null) return;
    raw = raw.trim().toUpperCase();
    if (!raw) { d(K_CODE); log('已清除授权码'); render(); return; }
    s(K_CODE, { code: raw });
    log('已保存授权码 …' + raw.slice(-4));
    render();
  }

  function clear() {
    [K_GAME, K_IAP, K_SID, K_LOG].forEach(d);
    logs = [];
    log('已清空');
    render();
  }

  /** 采集当前域的全部 cookie */
  function cookies() {
    var out = [];
    try {
      document.cookie.split(';').forEach(function (c) {
        var i = c.indexOf('=');
        if (i < 0) return;
        var n = c.slice(0, i).trim(), v = c.slice(i + 1).trim();
        if (n) out.push({ name: n, value: v, domain: location.hostname });
      });
    } catch (e) {}
    return out;
  }

  function post(path, payload) {
    return fetch(S + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    });
  }

  function run() {
    var lc = g(K_CODE);
    var gm = g(K_GAME), ip = g(K_IAP);
    if (!lc || !lc.code) { log('❌ 先设置授权码'); return; }
    if (!gm || !gm.productId) { log('❌ 先获取①游戏'); return; }
    if (!ip || !ip.productId) { log('❌ 先获取②内购'); return; }

    var ck = cookies();
    if (!ck.length) { log('❌ 当前页面没有可上报的 cookie'); return; }
    log('⏳ 上报 ' + ck.length + ' 个 cookie…');

    post('/api/session', {
      code: lc.code,
      cookies: ck,
      meta: { market: ip.market || gm.market || '', host: location.hostname }
    })
      .then(function (r) {
        if (!r.body.ok) { log('❌ 建会话失败: ' + r.body.error); return null; }
        var sid = r.body.data.sessionId;
        s(K_SID, { id: sid, at: Date.now() });
        log('✅ 会话 ' + sid.slice(0, 8) + ' · ' + r.body.data.cookieCount + ' cookie');
        log('⏳ 服务端执行中…');
        return post('/api/run', {
          sessionId: sid,
          code: lc.code,
          market: ip.market || gm.market || 'AR',
          game: { productId: gm.productId, skuId: '0010' },
          iap: { productId: ip.productId, skuId: '0010' }
        });
      })
      .then(function (r) {
        if (!r) return;
        if (r.body.ok) {
          var d2 = r.body.data;
          log('✅ 完成 · 剩余 ' + d2.remaining + ' 次');
          if (d2.plan && d2.plan.meta && d2.plan.meta.iap) {
            log('   目标 ' + d2.plan.meta.iap.productId + '/' + d2.plan.meta.iap.availabilityId);
          }
        } else {
          log('❌ ' + (r.body.error || '执行失败'));
          if (r.body.data && r.body.data.stage) log('   阶段: ' + r.body.data.stage);
        }
        render();
      })
      .catch(function (e) { log('❌ 网络错误: ' + e.message); });
  }

  function renderLog() {
    if (logBox) logBox.textContent = logs.join('\n');
  }

  function render() {
    if (!el) return;
    var st = el.querySelector('#st');
    if (!st) return;
    var lc = g(K_CODE), gm = g(K_GAME), ip = g(K_IAP), sid = g(K_SID);

    function row(label, v, sub) {
      var has = !!v;
      return '<div style="padding:6px 8px;border-radius:6px;margin-bottom:5px;background:' +
        (has ? '#0e2f12' : '#2f1212') + ';border:1px solid ' + (has ? '#2f7a3a' : '#7a2f2f') + '">' +
        '<div style="color:#9fe6a8;font-size:11px;font-weight:700">' + label + '</div>' +
        (has ? '<div style="color:#fff;font-family:ui-monospace,Menlo,monospace;font-size:13px;font-weight:700">' + v + '</div>'
              : '<div style="color:#f88;font-size:11px">未获取</div>') +
        (sub ? '<div style="color:#7a8;font-size:10px">' + sub + '</div>' : '') +
        '</div>';
    }

    st.innerHTML =
      row('① 游戏', gm && gm.productId, gm && gm.market ? gm.market : '') +
      row('② 内购', ip && ip.productId, ip && ip.market ? ip.market : '') +
      '<div style="font-size:11px;color:' + (lc ? '#7fd' : '#f88') + '">' +
        (lc ? '授权 …' + String(lc.code).slice(-4) : '未授权') +
        (sid ? ' · 会话 ' + String(sid.id).slice(0, 8) : '') +
      '</div>';

    var b1 = el.querySelector('#g1'), b2 = el.querySelector('#g2');
    if (b1) b1.textContent = (gm && gm.productId) ? '① ' + gm.productId : '获取①游戏';
    if (b2) b2.textContent = (ip && ip.productId) ? '② ' + ip.productId : '获取②内购';
    renderLog();
  }

  log('v6.0.0 已注入 · ' + location.host);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else setTimeout(build, 0);
})();
