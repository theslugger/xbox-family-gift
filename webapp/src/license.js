'use strict';

/**
 * 授权码系统
 *
 * 规则：
 *   - 一次完整赠礼扣 1 次
 *   - 不绑定账号，只记录次数
 *   - 服务端存 sha256 哈希，落盘不存明文
 *   - 支持过期时间、禁用、备注
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LIC_FILE = path.join(DATA_DIR, 'licenses.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.jsonl');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉 I O 0 1

let db = { licenses: {}, updatedAt: 0 };
let loaded = false;

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

function load() {
  if (loaded) return;
  ensureDir();
  try {
    const raw = fs.readFileSync(LIC_FILE, 'utf8');
    db = JSON.parse(raw);
    if (!db.licenses) db.licenses = {};
  } catch (e) {
    db = { licenses: {}, updatedAt: 0 };
  }
  loaded = true;
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    ensureDir();
    const tmp = LIC_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, LIC_FILE);
    } catch (e) {
      console.error('[license] save failed:', e.message);
    }
  }, 200);
}

/** 规范化用户输入：去空格、转大写、去掉前缀连字符差异 */
function normalizeCode(input) {
  const s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('XFG')) return s.slice(3);
  return s;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

/** 生成一个可读授权码：XXXX-XXXX-XXXX-XXXX */
function randomCode() {
  const buf = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s.match(/.{4}/g).join('-');
}

// ============================================================
// 生成
// ============================================================
function issue(opts = {}) {
  load();
  const count = Math.min(Math.max(Number(opts.count) || 1, 1), 500);
  const uses = Math.max(Number(opts.uses) || 1, 1);
  const note = String(opts.note || '').slice(0, 120);
  const days = Number(opts.days) || 0;                 // 0 = 永不过期
  const expiresAt = days > 0 ? Date.now() + days * 86400 * 1000 : 0;

  const out = [];
  for (let i = 0; i < count; i++) {
    let code;
    do { code = randomCode(); } while (db.licenses[hashCode(code)]);
    const h = hashCode(code);
    db.licenses[h] = {
      createdAt: Date.now(),
      total: uses,
      used: 0,
      remaining: uses,
      disabled: false,
      note,
      expiresAt,
      lastUsedAt: 0,
      // 关键：不存明文，只存后 4 位方便人工核对
      tail: code.slice(-4)
    };
    // 明文只出现在本次返回里，绝不落盘
    out.push({ code, uses, expiresAt, note });
  }
  db.updatedAt = Date.now();
  save();
  return out;
}

// ============================================================
// 查询
// ============================================================
function peek(code) {
  load();
  const h = hashCode(code);
  const lic = db.licenses[h];
  if (!lic) return { valid: false, reason: 'not_found' };
  if (lic.disabled) return { valid: false, reason: 'disabled' };
  if (lic.expiresAt && Date.now() > lic.expiresAt) return { valid: false, reason: 'expired' };
  if (lic.remaining <= 0) return { valid: false, reason: 'exhausted' };
  return { valid: true, remaining: lic.remaining, total: lic.total };
}

// ============================================================
// 扣次（一次完整赠礼调一次）
// ============================================================
function consume(code, ctx = {}) {
  load();
  const h = hashCode(code);
  const lic = db.licenses[h];
  if (!lic) return { ok: false, reason: 'not_found' };
  if (lic.disabled) return { ok: false, reason: 'disabled' };
  if (lic.expiresAt && Date.now() > lic.expiresAt) return { ok: false, reason: 'expired' };
  if (lic.remaining <= 0) return { ok: false, reason: 'exhausted' };

  lic.remaining -= 1;
  lic.used = (lic.used || 0) + 1;
  lic.lastUsedAt = Date.now();
  db.updatedAt = Date.now();
  save();

  // 追加使用记录（审计用，不含明文码）
  try {
    ensureDir();
    fs.appendFileSync(USAGE_FILE, JSON.stringify({
      t: Date.now(),
      tail: lic.tail,
      note: lic.note,
      remaining: lic.remaining,
      action: ctx.action || 'gift',
      market: ctx.market || '',
      iap: ctx.iap || '',
      game: ctx.game || ''
    }) + '\n');
  } catch (e) {}

  return { ok: true, remaining: lic.remaining, total: lic.total };
}

/** 撤销 / 恢复 / 手动改次数 */
function update(code, patch = {}) {
  load();
  const h = hashCode(code);
  const lic = db.licenses[h];
  if (!lic) return { ok: false, reason: 'not_found' };
  if (patch.disabled !== undefined) lic.disabled = !!patch.disabled;
  if (patch.remaining !== undefined) {
    lic.remaining = Math.max(0, Number(patch.remaining) || 0);
    lic.total = Math.max(lic.total, lic.used + lic.remaining);
  }
  if (patch.note !== undefined) lic.note = String(patch.note).slice(0, 120);
  lic.updatedAt = Date.now();
  db.updatedAt = Date.now();
  save();
  return { ok: true };
}

/** 列表（不含哈希） */
function list(query = '') {
  load();
  const q = String(query || '').trim().toLowerCase();
  const rows = [];
  for (const [h, lic] of Object.entries(db.licenses)) {
    if (q) {
      const hay = (lic.note || '').toLowerCase() + ' ' + (lic.tail || '').toLowerCase();
      if (!hay.includes(q)) continue;
    }
    rows.push({
      hash12: h.slice(0, 12),
      tail: lic.tail,
      total: lic.total,
      used: lic.used || 0,
      remaining: lic.remaining,
      disabled: !!lic.disabled,
      note: lic.note || '',
      createdAt: lic.createdAt,
      lastUsedAt: lic.lastUsedAt || 0,
      expiresAt: lic.expiresAt || 0
    });
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return rows;
}

function stats() {
  load();
  const all = Object.values(db.licenses);
  return {
    codes: all.length,
    totalUses: all.reduce((s, l) => s + (l.total || 0), 0),
    usedUses: all.reduce((s, l) => s + (l.used || 0), 0),
    remaining: all.reduce((s, l) => s + (l.remaining || 0), 0),
    active: all.filter(l => !l.disabled && l.remaining > 0 && (!l.expiresAt || Date.now() < l.expiresAt)).length
  };
}

/** 按尾部 4 位更新（要求唯一） */
function updateByTail(tail, patch = {}) {
  load();
  const t = String(tail || '').toUpperCase();
  const hits = Object.entries(db.licenses).filter(([h, l]) => l.tail === t);
  if (hits.length !== 1) return { ok: false, reason: hits.length ? 'ambiguous' : 'not_found' };
  const [h, lic] = hits[0];
  if (patch.disabled !== undefined) lic.disabled = !!patch.disabled;
  lic.updatedAt = Date.now();
  db.updatedAt = Date.now();
  save();
  return { ok: true };
}

module.exports = { issue, peek, consume, update, list, stats, hashCode, normalizeCode, updateByTail };
