'use strict';

/**
 * 任务状态机
 * 一个房间 = 一次赠礼流程，包含子号侧与主号侧
 *
 * 状态流转：
 *   created       刚建房间
 *   child_ready   子号已选好内购 + 游戏
 *   requested     子号已发起家庭组申请（订单已创建）
 *   approved      主号已批准
 *   paying        付款页已就绪
 *   done          完成
 *   failed        失败
 */

const crypto = require('crypto');

const TTL = 60 * 60 * 1000;           // 房间 1 小时过期
const rooms = new Map();              // roomId -> room
const gameUsage = new Map();          // `${market}|${productId}` -> 使用时间

function newRoomId() {
  // 6 位人类可读码，去掉易混字符
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const buf = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += abc[buf[i] % abc.length];
  return s;
}

function createRoom(opts = {}) {
  let id;
  do { id = newRoomId(); } while (rooms.has(id));

  const room = {
    id,
    status: 'created',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    market: opts.market || '',
    iap: null,             // { productId, availabilityId, skuId, title, price, currency }
    game: null,            // 同上
    childInfo: null,       // { orderId }
    approvals: null,
    error: null,
    log: [],
  };
  rooms.set(id, room);
  addLog(room, '创建房间');
  return room;
}

function getRoom(id) {
  const r = rooms.get(String(id || '').toUpperCase());
  if (!r) return null;
  if (Date.now() - r.updatedAt > TTL) { rooms.delete(r.id); return null; }
  return r;
}

function addLog(room, msg, extra) {
  room.updatedAt = Date.now();
  room.log.push({ t: Date.now(), msg, extra: extra || null });
  if (room.log.length > 100) room.log.shift();
}

function setStatus(room, status, patch = {}) {
  room.status = status;
  Object.assign(room, patch);
  addLog(room, '状态 -> ' + status);
  return room;
}

/** 记录某游戏已被用过，避免重复赠送同一个 */
function markGameUsed(market, productId) {
  gameUsage.set(String(market).toUpperCase() + '|' + String(productId).toUpperCase(), Date.now());
}

/** 取最近用过（含本次房间）的游戏 productId 列表，用于排除 */
function usedGames(market) {
  const mk = String(market).toUpperCase() + '|';
  const out = [];
  for (const [k, t] of gameUsage) {
    if (Date.now() - t > 30 * 24 * 3600 * 1000) { gameUsage.delete(k); continue; }
    if (k.startsWith(mk)) out.push(k.slice(mk.length));
  }
  return out;
}

/** 定时清理过期房间 */
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (now - r.updatedAt > TTL) rooms.delete(id);
  }
}, 5 * 60 * 1000).unref();

module.exports = { createRoom, getRoom, setStatus, addLog, markGameUsed, usedGames, rooms };
