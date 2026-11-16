'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const catalog = require('./catalog');
const roomsApi = require('./rooms');
const license = require('./license');

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// ---------- CORS ----------
// 油猴脚本从 www.xbox.com / account.microsoft.com / www.microsoft.com 发起跨域请求
const ALLOW_ORIGINS = [
  'https://www.xbox.com',
  'https://xbox.com',
  'https://www.microsoft.com',
  'https://microsoft.com',
  'https://account.microsoft.com',
  'https://login.live.com'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const ok = ALLOW_ORIGINS.includes(origin)
      || /\.xbox\.com$/.test(origin)
      || /\.microsoft\.com$/.test(origin)
      || /\.live\.com$/.test(origin);
    if (ok) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  }
  // 无 Origin 的预检也算通过（curl 调试用）
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// ---------- 简易限流（按 IP） ----------
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress || '?';
    const now = Date.now();
    let e = hits.get(ip);
    if (!e || now - e.at > windowMs) { e = { at: now, n: 0 }; hits.set(ip, e); }
    e.n++;
    if (e.n > max) return res.status(429).json({ ok: false, error: '请求过于频繁，请稍后再试' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (now - e.at > 10 * 60 * 1000) hits.delete(ip);
}, 5 * 60 * 1000).unref();

// ---------- 基础 ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, t: Date.now(), version: '0.1.0' });
});

/** 市场校验 + 归一化 */
app.get('/api/market/normalize', (req, res) => {
  const raw = req.query.m || '';
  const mk = catalog.normMarket(raw);
  res.json({
    ok: !!mk,
    input: raw,
    market: mk,
    locale: mk ? catalog.localeOf(mk) : '',
    error: mk ? null : '无法识别市场码，请输入 AR / US / JP 这类两字母代码'
  });
});

/** 解析单个商品（游戏或内购） */
app.post('/api/resolve', rateLimit(60, 60 * 1000), async (req, res) => {
  try {
    const { productId, market, skuId } = req.body || {};
    if (!productId) return res.status(400).json({ ok: false, error: '缺少 productId' });
    const mk = catalog.normMarket(market);
    if (!mk) return res.status(400).json({ ok: false, error: '缺少或无效的 market' });
    const info = await catalog.resolve(productId, mk, skuId);
    res.json({ ok: true, data: info });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** 从链接/文本里提取 productId */
function extractProductId(text) {
  const s = String(text || '').trim();
  let m = s.match(/\b([A-Z0-9]{12})\b/i);
  if (m) return m[1].toUpperCase();
  m = s.match(/store\/apps\/([a-z0-9]{12})/i);
  if (m) return m[1].toUpperCase();
  m = s.match(/products\/([A-Z0-9]{12})/i);
  if (m) return m[1].toUpperCase();
  return '';
}

/** 识别用户粘贴的内容 */
app.post('/api/lookup', rateLimit(40, 60 * 1000), async (req, res) => {
  try {
    const { input, market } = req.body || {};
    const mk = catalog.normMarket(market);
    if (!mk) return res.status(400).json({ ok: false, error: '请先选择目标地区' });
    const pid = extractProductId(input);
    if (!pid) return res.status(400).json({ ok: false, error: '没能从内容里识别出 ProductId（12 位字母数字）' });
    const info = await catalog.resolve(pid, mk);
    res.json({ ok: true, data: info });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** 挑选"狸猫换太子"用的游戏：自动排除已用过的 */
app.post('/api/pick-game', rateLimit(30, 60 * 1000), async (req, res) => {
  try {
    const { market, count, exclude, maxPrice } = req.body || {};
    const mk = catalog.normMarket(market);
    if (!mk) return res.status(400).json({ ok: false, error: '请先选择目标地区' });

    const used = roomsApi.usedGames(mk);
    const ex = new Set([...(exclude || []), ...used].map(x => String(x).toUpperCase()));
    const list = await catalog.findGames(mk, {
      count: Math.min(Number(count) || 5, 10),
      exclude: [...ex],
      maxPrice: maxPrice ? Number(maxPrice) : undefined
    });
    res.json({ ok: true, data: list, excluded: [...ex] });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------- 房间 ----------
// ============================================================
// 授权码 API（油猴脚本调用）
// ============================================================

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, error: '服务端未配置 ADMIN_TOKEN，管理接口已关闭' });
  }
  const got = String(req.headers['x-admin-token'] || req.query.token || '');
  // 定长比较，避免时序侧信道
  const a = Buffer.from(got);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: '管理口令错误' });
  }
  return null;
}

/** 校验授权码（不扣次） */
app.post('/api/license/check', rateLimit(60, 60 * 1000), (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ ok: false, error: '缺少授权码' });
  const r = license.peek(code);
  if (!r.valid) {
    const msg = {
      not_found: '授权码不存在',
      disabled: '授权码已被停用',
      expired: '授权码已过期',
      exhausted: '授权码次数已用完'
    }[r.reason] || '授权码无效';
    return res.json({ ok: false, error: msg, reason: r.reason });
  }
  res.json({ ok: true, data: { remaining: r.remaining, total: r.total } });
});

/**
 * 扣次：一次完整赠礼调一次
 * 幂等：同一个 giftId 重复调用只扣一次
 */
const consumedGifts = new Map();   // giftId -> {remaining, at}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of consumedGifts) if (now - v.at > 6 * 3600 * 1000) consumedGifts.delete(k);
}, 30 * 60 * 1000).unref();

app.post('/api/license/consume', rateLimit(30, 60 * 1000), (req, res) => {
  const { code, giftId, market, iap, game } = req.body || {};
  if (!code) return res.status(400).json({ ok: false, error: '缺少授权码' });

  const gid = String(giftId || '').slice(0, 64);
  if (gid && consumedGifts.has(gid)) {
    const hit = consumedGifts.get(gid);
    return res.json({ ok: true, data: { remaining: hit.remaining, dedup: true } });
  }

  const r = license.consume(code, { market, iap, game });
  if (!r.ok) {
    const msg = {
      not_found: '授权码不存在',
      disabled: '授权码已被停用',
      expired: '授权码已过期',
      exhausted: '授权码次数已用完'
    }[r.reason] || '授权码无效';
    return res.json({ ok: false, error: msg, reason: r.reason });
  }
  if (gid) consumedGifts.set(gid, { remaining: r.remaining, at: Date.now() });
  res.json({ ok: true, data: { remaining: r.remaining, total: r.total, dedup: false } });
});

// ---------- 管理接口 ----------

/** 按尾部 4 位停用/恢复（管理页用，避免暴露完整码） */
app.post('/api/admin/licenses/update-by-tail', (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  const { tail, disabled } = req.body || {};
  const t = String(tail || '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(t)) return res.status(400).json({ ok: false, error: '无效尾号' });
  const rows = license.list().filter(r => r.tail === t);
  if (!rows.length) return res.status(404).json({ ok: false, error: '找不到该尾号的授权码' });
  if (rows.length > 1) return res.status(409).json({ ok: false, error: '尾号重复，共 ' + rows.length + ' 个，请用完整码操作' });
  // 有 tail 唯一时，用内部方法直接改
  const r = license.updateByTail(t, { disabled });
  if (!r.ok) return res.status(400).json({ ok: false, error: r.reason });
  res.json({ ok: true });
});


/** 批量生成 */
app.post('/api/admin/licenses/issue', (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  const { count, uses, note, days } = req.body || {};
  try {
    const list = license.issue({ count, uses, note, days, keepPlain: true });
    res.json({ ok: true, data: list });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** 列表 */
app.get('/api/admin/licenses', (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  res.json({ ok: true, data: { rows: license.list(req.query.q), stats: license.stats() } });
});

/** 停用/恢复/改次数 */
app.post('/api/admin/licenses/update', (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  const { code, disabled, remaining, note } = req.body || {};
  if (!code) return res.status(400).json({ ok: false, error: '缺少授权码' });
  const r = license.update(code, { disabled, remaining, note });
  if (!r.ok) return res.status(404).json({ ok: false, error: '授权码不存在' });
  res.json({ ok: true });
});

// ---------- 书签脚本生成 ----------
const fs = require('fs');

const BOOKMARKLET_SRC = path.join(__dirname, '..', 'public', 'bookmarklet.js');
let bookmarkletCache = null;

function buildBookmarklet(roomId, serverUrl) {
  if (!bookmarkletCache) {
    bookmarkletCache = fs.readFileSync(BOOKMARKLET_SRC, 'utf8');
  }
  const cfg = JSON.stringify({ server: serverUrl, room: roomId });
  // 把配置作为全局变量前置，脚本其余部分原样执行
  const withCfg = 'window.__XFG_BOOKMARKLET_CFG__=' + cfg + ';\n' + bookmarkletCache;
  // 压成一行并做最小压缩（去注释行首空白），再 encodeURIComponent
  const compact = withCfg
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
    .join(' ')
    .replace(/\s{2,}/g, ' ');
  return 'javascript:' + encodeURIComponent(compact);
}

/** 生成带房间绑定的书签脚本 URL */
app.get('/api/bookmarklet', rateLimit(60, 60 * 1000), (req, res) => {
  const roomId = String(req.query.room || '').toUpperCase();
  if (roomId) {
    const room = roomsApi.getRoom(roomId);
    if (!room) return res.status(404).json({ ok: false, error: '房间不存在或已过期' });
  }
  const serverUrl = (req.query.server || ('https://' + (req.headers.host || 'xbox.aappe.uk'))).replace(/\/+$/, '');
  try {
    const code = buildBookmarklet(roomId, serverUrl);
    res.json({ ok: true, data: { room: roomId, server: serverUrl, code, length: code.length } });
  } catch (e) {
    res.status(500).json({ ok: false, error: '生成失败: ' + e.message });
  }
});

/** 书签脚本上报日志 / 进度 */
app.post('/api/room/:id/log', rateLimit(120, 60 * 1000), (req, res) => {
  const room = roomsApi.getRoom(req.params.id);
  if (!room) return res.status(404).json({ ok: false, error: '房间不存在' });
  const { msg, extra } = req.body || {};
  roomsApi.addLog(room, '[书签] ' + String(msg || ''), extra || null);
  // 书签脚本报告替换成功，推进状态
  if (/已替换为内购/.test(String(msg || '')) && room.status === 'requested') {
    roomsApi.setStatus(room, 'paying');
  }
  res.json({ ok: true });
});

app.post('/api/room', rateLimit(30, 60 * 1000), (req, res) => {
  const { market } = req.body || {};
  const mk = catalog.normMarket(market) || '';
  const room = roomsApi.createRoom({ market: mk });
  res.json({ ok: true, data: pub(room) });
});

app.get('/api/room/:id', (req, res) => {
  const room = roomsApi.getRoom(req.params.id);
  if (!room) return res.status(404).json({ ok: false, error: '房间不存在或已过期' });
  res.json({ ok: true, data: pub(room) });
});

function pub(r) {
  return {
    id: r.id,
    status: r.status,
    market: r.market,
    iap: r.iap,
    game: r.game,
    childInfo: r.childInfo,
    error: r.error,
    log: r.log.slice(-30),
    updatedAt: r.updatedAt
  };
}

// ---------- WebSocket：房间实时同步 ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Map();   // roomId -> Set<ws>

wss.on('connection', (ws, req) => {
  let roomId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'join') {
      const room = roomsApi.getRoom(msg.roomId);
      if (!room) { ws.send(JSON.stringify({ type: 'error', error: '房间不存在或已过期' })); return; }
      roomId = room.id;
      if (!clients.has(roomId)) clients.set(roomId, new Set());
      clients.get(roomId).add(ws);
      ws.send(JSON.stringify({ type: 'state', data: pub(room) }));
      return;
    }

    if (!roomId) return;
    const room = roomsApi.getRoom(roomId);
    if (!room) { ws.send(JSON.stringify({ type: 'error', error: '房间已过期' })); return; }

    try {
      handleRoomMessage(room, msg);
      broadcast(room);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: e.message }));
    }
  });

  ws.on('close', () => {
    if (roomId && clients.has(roomId)) {
      clients.get(roomId).delete(ws);
      if (!clients.get(roomId).size) clients.delete(roomId);
    }
  });
});

function broadcast(room) {
  const set = clients.get(room.id);
  if (!set) return;
  const payload = JSON.stringify({ type: 'state', data: pub(room) });
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function handleRoomMessage(room, msg) {
  switch (msg.type) {
    case 'set-iap': {
      const d = msg.data || {};
      if (!d.productId || !d.availabilityId) throw new Error('内购信息不完整');
      room.iap = d;
      roomsApi.addLog(room, '设置内购: ' + (d.title || d.productId) +
        (d.price ? ' · ' + d.price + ' ' + d.currency : ''));
      if (room.game) roomsApi.setStatus(room, 'child_ready');
      break;
    }
    case 'set-game': {
      const d = msg.data || {};
      if (!d.productId || !d.availabilityId) throw new Error('游戏信息不完整');
      room.game = d;
      roomsApi.markGameUsed(room.market, d.productId);
      roomsApi.addLog(room, '设置游戏: ' + (d.title || d.productId));
      if (room.iap) roomsApi.setStatus(room, 'child_ready');
      break;
    }
    case 'set-market': {
      const mk = catalog.normMarket(msg.data && msg.data.market);
      if (!mk) throw new Error('无效市场码');
      room.market = mk;
      roomsApi.addLog(room, '目标地区: ' + mk);
      break;
    }
    case 'requested': {
      if (!room.iap || !room.game) throw new Error('还没有选好内购和游戏');
      const orderId = (msg.data && msg.data.orderId) || '';
      room.childInfo = { orderId };
      roomsApi.setStatus(room, 'requested');
      roomsApi.addLog(room, '子号已发起申请', { orderId });
      break;
    }
    case 'approved': {
      roomsApi.setStatus(room, 'approved');
      break;
    }
    case 'paying':
      roomsApi.setStatus(room, 'paying');
      break;
    case 'done':
      roomsApi.setStatus(room, 'done');
      break;
    case 'failed':
      room.error = (msg.data && msg.data.error) || '未知错误';
      roomsApi.setStatus(room, 'failed');
      roomsApi.addLog(room, '失败: ' + room.error);
      break;
    case 'log':
      roomsApi.addLog(room, String((msg.data && msg.data.msg) || ''), msg.data && msg.data.extra);
      break;
    default:
      throw new Error('未知消息类型: ' + msg.type);
  }
}

// 心跳，清理死连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 30 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log('[xfg] listening on http://' + HOST + ':' + PORT);
});
